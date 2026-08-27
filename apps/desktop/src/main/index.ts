import { join } from 'node:path'
import { BrowserWindow, app, dialog, nativeTheme, protocol, shell } from 'electron'
import { HubApiError } from '@oh-my-huggingface/hub-api'
import type { IpcEventChannel, IpcEventPayload } from '@oh-my-huggingface/shared'
import {
  APP_PROTOCOL,
  isAllowedExternalUrl,
  isValidRepoId,
  parseHubResource,
  routeFromLaunchArgs
} from '@oh-my-huggingface/shared'
import { AuthManager } from './auth'
import { mimeForOmhfFile } from './preview-mime'
import { CacheManager } from './cache'
import { CachePinStore } from './cache-pins'
import { openDatabase } from './db'
import { DownloadManager } from './downloads'
import { FollowsPoller } from './follows'
import {
  createFailClosedDynamicProxiedFetch,
  buildHubClient,
  createHubClient,
  createHubProxy,
  rebuildHubClient,
  type HubHolder
} from './hub'
import { MainI18n, matchLocale } from './i18n'
import { IntegrationTaskManager } from './integration-tasks'
import { registerIpcHandlers } from './ipc'
import { Library } from './library'
import { LocalRuntimeManager } from './local-runtime'
import { LockfileManager } from './lockfile'
import { buildMenu } from './menu'
import { NotificationService } from './notifications'
import { applyAppProxy } from './proxy'
import { SettingsStore } from './settings'
import { SecurityGate } from './security-gate'
import { StarReminderService } from './star-reminder'
import { applyExplicitTelemetryDecline, DEFAULT_POSTHOG_HOST, TelemetryService } from './telemetry'
import { TrayManager } from './tray'
import { QuitCoordinator } from './quit-coordinator'
import { resolveUpdateClient, UpdateManager } from './updater'

declare const __OMH_POSTHOG_PROJECT_KEY__: string
declare const __OMH_POSTHOG_HOST__: string

const bundledPostHogProjectKey =
  typeof __OMH_POSTHOG_PROJECT_KEY__ === 'string' ? __OMH_POSTHOG_PROJECT_KEY__ : ''
const bundledPostHogHost =
  typeof __OMH_POSTHOG_HOST__ === 'string' ? __OMH_POSTHOG_HOST__ : DEFAULT_POSTHOG_HOST

// One identity everywhere: dev and packaged share the same safeStorage keychain
// entry and userData, so the ~/.oh_my_hf credentials decrypt in every session.
// This matches the identity existing installs already used — never change it,
// or stored ciphertexts stop decrypting and profiles orphan.
app.setName('oh-my-huggingface-desktop')

// Windows routes toasts by AppUserModelID; it must match the shortcut AUMID
// electron-builder (NSIS) derives from appId in electron-builder.yml, or
// Notification.show() silently no-ops.
if (process.platform === 'win32') app.setAppUserModelId('dev.oh-my-huggingface.desktop')

// Repo images (file previews, README images) load through this custom scheme
// so the hub client's auth + proxy apply — a renderer <img> pointing straight
// at https://huggingface.co/…/resolve/… carries no Authorization header and
// 401s on private/gated repos. bypassCSP lets omhf-file: subresources load
// under the renderer CSP (img-src 'self' https: data:) without widening it
// for every scheme; the handler only ever proxies Hub resolve URLs. Must run
// before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'omhf-file',
    privileges: { standard: true, secure: true, stream: true, bypassCSP: true }
  }
])

const isDev = !app.isPackaged
// Squirrel.Mac validates the update against the running app's designated
// requirement. Releases are signed with the stable self-signed OhMyHF-Release
// certificate (docs/signing.md), so the requirement matches across versions.
// Installs older than the first self-signed release still fall back to manual
// because their ad-hoc requirement (cdhash-based) can never match.
const macAutoInstallEnabled = true
// Squirrel.Mac sometimes only closes windows. After this delay the process
// relaunches itself so the user is not left with a windowless dock icon.
const MAC_INSTALL_RELAUNCH_FALLBACK_MS = 8_000

// Renderer crash / load-failure recovery: reload this many times before asking
// the user, with a short pause so a persistent crash can't spin a tight loop.
const MAX_RENDER_RECOVERIES = 3
const RENDER_RECOVERY_DELAY_MS = 1000

// E2E tests point userData at a temp dir so they never touch a real profile.
if (process.env.OMH_USER_DATA_DIR) {
  app.setPath('userData', process.env.OMH_USER_DATA_DIR)
}

function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
  // Callers include timers (download progress, inference delta flushes); a send that
  // races window destruction must never become an uncaught exception in main.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* window closed mid-send */
    }
  }
}

// Assigned inside app.whenReady() where the window factory lives; lets
// navigate() recreate the window when none exists (macOS keeps the app alive
// after the last window closes).
let recreateWindow: (() => BrowserWindow) | null = null
// Route queued while no window existed; createWindow flushes it once the new
// renderer has mounted and is actually listening for 'evt:navigate'.
let pendingRoute: string | null = null

function registerAppProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [process.argv[1]!])
    }
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL)
  }
}

function navigate(route: string): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    // Broadcasting now would be dropped — no renderer is listening yet.
    pendingRoute = route
    recreateWindow?.()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  broadcast('evt:navigate', route)
}

// Dev and packaged now share one app identity; skip the lock in dev so a running
// packaged instance doesn't swallow `pnpm dev` launches.
const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!gotLock) {
  app.quit()
} else {
  let installingUpdate = false
  let quit: QuitCoordinator | null = null
  let macInstallRelaunchTimer: ReturnType<typeof setTimeout> | null = null
  let restoreAfterFailedInstall: (() => void) | null = null

  const recoverFromFailedInstall = (): void => {
    if (macInstallRelaunchTimer !== null) {
      clearTimeout(macInstallRelaunchTimer)
      macInstallRelaunchTimer = null
    }
    installingUpdate = false
    quit?.reset()
    restoreAfterFailedInstall?.()
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return
    }
    // window-all-closed already skipped quit while installingUpdate was set.
    recreateWindow?.()
  }

  registerAppProtocol()

  let settingsRef: SettingsStore | null = null
  const pendingLaunch: Array<
    { type: 'url'; value: string } | { type: 'argv'; value: readonly string[] }
  > = []

  const configuredHubEndpoint = (): string | null => settingsRef?.get().hubEndpoint ?? null

  const applyLaunch = (
    input: { type: 'url'; value: string } | { type: 'argv'; value: readonly string[] }
  ): void => {
    const route =
      input.type === 'url'
        ? input.value.startsWith('/')
          ? input.value
          : parseHubResource(input.value, configuredHubEndpoint())
        : routeFromLaunchArgs(input.value, configuredHubEndpoint())
    if (route) navigate(route)
  }

  const enqueueLaunch = (
    input: { type: 'url'; value: string } | { type: 'argv'; value: readonly string[] }
  ): void => {
    if (!settingsRef) {
      pendingLaunch.push(input)
      return
    }
    applyLaunch(input)
  }

  app.on('open-url', (event, url) => {
    event.preventDefault()
    enqueueLaunch({ type: 'url', value: url })
  })

  app.on('second-instance', (_event, argv) => {
    enqueueLaunch({ type: 'argv', value: argv })
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    const db = openDatabase()
    const settings = new SettingsStore(db)
    settingsRef = settings
    for (const input of pendingLaunch.splice(0)) applyLaunch(input)
    const i18n = new MainI18n()
    const configuredLocale = settings.get().locale
    i18n.setLocale(configuredLocale === 'system' ? matchLocale(app.getLocale()) : configuredLocale)

    const telemetry = new TelemetryService({
      db,
      enabled: () => settings.get().telemetryEnabled,
      // Development/test builds must not pollute production analytics even if
      // a developer happens to have the release variable in their shell.
      apiKey: app.isPackaged ? bundledPostHogProjectKey : '',
      endpoint: bundledPostHogHost,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      locale: () => i18n.getLocale(),
      // Respect both the current app-level proxy override and the OS proxy.
      // The getter is evaluated per event so Settings changes apply immediately.
      fetchImpl: createFailClosedDynamicProxiedFetch(() => settings.get().proxyUrl)
    })
    try {
      applyExplicitTelemetryDecline(settings, telemetry)
    } catch {
      // Honor a stored decline without blocking window creation if SQLite is
      // read-only or full. The helper also fails closed; this is a last guard.
      console.error('[telemetry] failed to honor a stored telemetry decline')
    }
    const starReminder = new StarReminderService({
      db,
      hasMeaningfulActivity: () => {
        const row = db
          .prepare(
            `SELECT (
               EXISTS (SELECT 1 FROM downloads WHERE status = 'completed')
               OR EXISTS (SELECT 1 FROM favorites)
               OR (SELECT COUNT(*) FROM history) >= 5
             ) AS eligible`
          )
          .get() as { eligible: number }
        return row.eligible === 1
      }
    })

    const auth = new AuthManager(db, (state) => broadcast('evt:auth', state))
    const initial = settings.get()
    const hubHolder: HubHolder = {
      current: createHubClient(
        () => auth.accessToken(),
        () => auth.sessionCookie(),
        {
          endpoint: initial.hubEndpoint,
          proxyUrl: initial.proxyUrl
        }
      )
    }
    const hub = createHubProxy(hubHolder)
    const security = new SecurityGate(hub)
    auth.attachClient(hubHolder.current)
    await applyAppProxy(initial.proxyUrl)
    app.setLoginItemSettings({ openAtLogin: initial.launchAtLogin })

    // omhf-file://repo/?kind=…&repoId=…&revision=…&path=… → authenticated
    // fetch of the Hub resolve URL through the live hub client (token + proxy
    // + endpoint rebuilds all apply; the token never reaches the renderer).
    // The upstream response streams through; failures map to plain status
    // responses so a broken image stays a broken image.
    protocol.handle('omhf-file', async (request) => {
      const params = new URL(request.url).searchParams
      const kindParam = params.get('kind')
      const kind =
        kindParam === 'model' || kindParam === 'dataset' || kindParam === 'space' ? kindParam : null
      const repoId = params.get('repoId')
      const path = params.get('path')
      const revision = params.get('revision')
      if (!kind || !repoId || !path || !revision) {
        return new Response('invalid omhf-file URL', { status: 400 })
      }
      // The token rides this request, so refuse anything that could redirect it
      // off the addressed repo: a malformed repoId (unencoded in the resolve
      // URL), or a path with traversal/empty segments that URL normalization
      // would resolve outside the repo. The revision is encodeURIComponent'd by
      // resolveUrl, so its separators can't traverse and it needs no guard.
      const segments = path.split('/')
      if (!isValidRepoId(repoId) || segments.some((s) => s === '..' || s === '.' || s === '')) {
        return new Response('invalid omhf-file URL', { status: 400 })
      }
      try {
        const upstream = await hub.fetchFileResponse(kind, repoId, path, revision)
        // Rebuild as a plain Response with Content-Type only: undici
        // decompresses bodies, so the upstream Content-Length may not match
        // what actually streams out.
        const headers = new Headers()
        const mime = mimeForOmhfFile(path, upstream.headers.get('Content-Type'))
        if (mime) headers.set('Content-Type', mime)
        return new Response(upstream.body, { status: upstream.status, headers })
      } catch (err) {
        const status = err instanceof HubApiError && err.status ? err.status : 502
        return new Response(err instanceof Error ? err.message : 'fetch failed', { status })
      }
    })

    const library = new Library(db, () => settings.get().historyLimit)
    const notifications = new NotificationService(settings, i18n, navigate)
    const integrationTasksRef: { current: IntegrationTaskManager | null } = { current: null }
    const localRuntimeRef: { current: LocalRuntimeManager | null } = { current: null }
    const downloads = new DownloadManager(
      db,
      settings,
      hub,
      notifications,
      () => auth.accessToken(),
      (tasks) => broadcast('evt:downloads', tasks),
      (request) => {
        void (async () => {
          try {
            if (!request.resolvedCommit || !request.revision)
              throw new Error('export.revisionRequired')
            if (!request.securityAcknowledgement) {
              throw new Error('security.confirmationRequired')
            }
            await security.authorizeAcknowledged(
              {
                action: 'export',
                kind: request.kind,
                repoId: request.repoId,
                revision: request.revision,
                resolvedCommit: request.resolvedCommit,
                files: [request.filePath]
              },
              request.securityAcknowledgement
            )
            integrationTasksRef.current?.startExport(request)
          } catch (err) {
            integrationTasksRef.current?.recordExportError(request, err)
          }
        })()
      },
      async (request) => {
        const manager = localRuntimeRef.current
        if (!manager) throw new Error('runtime.unavailable')
        const state = await manager.startFromPostAction(request)
        if (state.status === 'error') throw new Error(state.error ?? 'runtime.startFailed')
      }
    )
    // Cache cleanup must spare partials of still-resumable downloads.
    const cachePinsRef: { current?: CachePinStore } = {}
    let lockfile: LockfileManager | null = null
    const cache = new CacheManager(
      settings,
      () => downloads.protectedTaskIds(),
      (kind, repoId) => {
        const protectedCommits = new Set(downloads.protectedCommits(kind, repoId))
        for (const commit of cachePinsRef.current?.commits(kind, repoId) ?? []) {
          protectedCommits.add(commit)
        }
        const runtimeState = localRuntimeRef.current?.getState()
        if (
          runtimeState?.repoId === repoId &&
          runtimeState.resolvedCommit &&
          kind === 'model' &&
          runtimeState.status !== 'idle' &&
          runtimeState.status !== 'unavailable'
        ) {
          protectedCommits.add(runtimeState.resolvedCommit)
        }
        for (const commit of lockfile?.protectedCommits(kind, repoId) ?? []) {
          protectedCommits.add(commit)
        }
        return protectedCommits
      }
    )
    const cachePins = new CachePinStore(db, cache)
    cachePinsRef.current = cachePins
    const integrationTasks = new IntegrationTaskManager({
      accessToken: () => auth.accessToken(),
      username: () => {
        const state = auth.getState()
        return state.status === 'signedIn' ? state.user.name : undefined
      },
      cacheDir: () => cache.cacheDir(),
      broadcast: (tasks) => broadcast('evt:integrationTasks', tasks),
      notifications
    })
    integrationTasksRef.current = integrationTasks
    const localRuntime = new LocalRuntimeManager({
      db,
      settings,
      cache,
      security,
      broadcastState: (state) => broadcast('evt:localRuntime', state),
      broadcastInference: (event) => broadcast('evt:localInference', event)
    })
    localRuntimeRef.current = localRuntime
    downloads.resumePendingPostActions()
    lockfile = new LockfileManager({
      hub,
      cache,
      downloads,
      security,
      localRuntime,
      broadcastRestore: (event) => broadcast('evt:lockfileRestore', event),
      contextForEndpoint: (endpoint, authenticated) => {
        const temporaryHub = buildHubClient(
          authenticated ? () => auth.accessToken() : () => undefined,
          // Hub web-session cookies are host-bound and never leave the applied
          // endpoint. Explicit lock restores use Bearer auth only.
          () => undefined,
          { endpoint, proxyUrl: settings.get().proxyUrl }
        )
        return { hub: temporaryHub, security: new SecurityGate(temporaryHub) }
      }
    })
    const follows = new FollowsPoller(
      library,
      hub,
      settings,
      (items) => broadcast('evt:inbox', items),
      notifications
    )
    const tray = new TrayManager(
      () => BrowserWindow.getAllWindows()[0],
      i18n,
      () => {
        quit?.markQuitting()
        app.quit()
      }
    )
    quit = new QuitCoordinator(async () => {
      downloads.shutdown()
      integrationTasks.shutdown()
      follows.stop()
      tray.destroy()
      await localRuntime.shutdown()
    })
    restoreAfterFailedInstall = () => {
      downloads.resumeAfterShutdown()
      follows.start()
      if (settings.get().closeToTray) tray.ensure()
    }
    const updater = new UpdateManager({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      autoInstallSupported: process.platform !== 'darwin' || macAutoInstallEnabled,
      // MacUpdater does not install on quit. true only stages the zip with
      // Squirrel.Mac after download so Restart can relaunch instead of
      // closing windows and leaving the process in the dock.
      autoInstallOnAppQuit: process.platform === 'darwin',
      loadUpdater: async () => {
        const updaterModule = await import('electron-updater')
        return resolveUpdateClient(updaterModule)
      },
      prepareInstall: async () => {
        installingUpdate = true
        try {
          await quit?.beginCleanup()
        } catch (error) {
          recoverFromFailedInstall()
          throw error
        }
      },
      scheduleInstall: (task) => {
        setImmediate(() => {
          task()
          if (process.platform !== 'darwin') return
          // quitAndInstall failed (throw or sync 'error'): do not force-relaunch.
          if (!installingUpdate) return
          // Squirrel may have closed windows without starting the new process.
          const timer = setTimeout(() => {
            if (macInstallRelaunchTimer === timer) macInstallRelaunchTimer = null
            if (!installingUpdate) return
            // Fallback is only for a windowless handshake, not a visible retry.
            if (BrowserWindow.getAllWindows().length > 0) return
            app.relaunch()
            app.exit(0)
          }, MAC_INSTALL_RELAUNCH_FALLBACK_MS)
          timer.unref?.()
          macInstallRelaunchTimer = timer
        })
      },
      onStateChange: (state) => {
        if (state.status === 'error' && state.operation === 'install') {
          recoverFromFailedInstall()
        }
        broadcast('evt:updater', state)
      }
    })

    const rebuildMenu = (): void => {
      buildMenu(i18n, navigate)
      tray.refreshMenu()
    }

    const applyNetworkSettings = async (
      next: { hubEndpoint: string | null; proxyUrl: string | null },
      prev: { hubEndpoint: string | null; proxyUrl: string | null }
    ): Promise<void> => {
      const endpointChanged = next.hubEndpoint !== prev.hubEndpoint
      const proxyChanged = next.proxyUrl !== prev.proxyUrl
      if (!endpointChanged && !proxyChanged) return
      if (proxyChanged) await applyAppProxy(next.proxyUrl)
      // A web-session cookie is bound to the host it was captured on; it must
      // never ride along to a different (mirror) endpoint.
      if (endpointChanged) await auth.disconnectHubSession()
      if (endpointChanged || proxyChanged) {
        rebuildHubClient(
          hubHolder,
          () => auth.accessToken(),
          () => auth.sessionCookie(),
          {
            endpoint: next.hubEndpoint,
            proxyUrl: next.proxyUrl
          }
        )
        auth.attachClient(hubHolder.current)
      }
    }

    const isDarkTheme = (): boolean => {
      const theme = settings.get().theme
      return theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
    }

    // Native minimize/maximize/close drawn over the TopBar (h-11 = 44px);
    // colors track the renderer theme (--c-bg / --c-ink-muted). Height is
    // 43px — one short of the TopBar — so the overlay's opaque background
    // doesn't paint over the header's 1px bottom border.
    const titleBarOverlay = (): Electron.TitleBarOverlayOptions =>
      isDarkTheme()
        ? { color: '#030712', symbolColor: '#99a1af', height: 43 }
        : { color: '#ffffff', symbolColor: '#4a5565', height: 43 }

    const refreshTitleBarOverlay = (): void => {
      if (process.platform !== 'win32') return
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay())
      }
    }
    nativeTheme.on('updated', refreshTitleBarOverlay)

    const applyDesktopSettings = (
      next: { launchAtLogin: boolean; closeToTray: boolean; theme: string },
      prev: { launchAtLogin: boolean; closeToTray: boolean; theme: string }
    ): void => {
      if (next.theme !== prev.theme) refreshTitleBarOverlay()
      if (next.launchAtLogin !== prev.launchAtLogin) {
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
      }
      if (next.closeToTray === prev.closeToTray) return
      if (next.closeToTray) {
        tray.ensure()
      } else {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed() && !win.isVisible()) {
          win.show()
        }
        tray.destroy()
      }
    }

    registerIpcHandlers({
      db,
      hub,
      auth,
      settings,
      telemetry,
      starReminder,
      starReminderEnabled: app.isPackaged,
      library,
      downloads,
      cache,
      cachePins,
      security,
      localRuntime,
      lockfile,
      follows,
      integrationTasks,
      updater,
      i18n,
      rebuildMenu,
      broadcast,
      applyNetworkSettings,
      applyDesktopSettings
    })
    rebuildMenu()
    if (initial.closeToTray) tray.ensure()

    const windowBackground = (): string => (isDarkTheme() ? '#030712' : '#ffffff')

    const createWindow = (backgroundColor: string): BrowserWindow => {
      const win = new BrowserWindow({
        width: 1360,
        height: 860,
        minWidth: 760,
        minHeight: 520,
        show: false,
        // Matches the renderer's --c-bg per theme so first paint never flashes white.
        backgroundColor,
        // Hide the native menu bar on Windows/Linux (Alt reveals it); its
        // accelerators (Ctrl+1..8, Ctrl+,, zoom, reload) keep working.
        autoHideMenuBar: true,
        ...(process.platform === 'darwin'
          ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 14 } }
          : {}),
        // Windows: drop the native title bar; the system window controls render
        // as an overlay on the TopBar (keeps Snap Layouts on the maximize button).
        ...(process.platform === 'win32'
          ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay() }
          : {}),
        // Window/taskbar icon for Windows and Linux; macOS uses the app bundle icon.
        ...(process.platform !== 'darwin' ? { icon: join(__dirname, '../../build/icon.png') } : {}),
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true
        }
      })

      win.on('ready-to-show', () => win.show())

      win.on('close', (event) => {
        if (quit?.isQuitting() || !settings.get().closeToTray) return
        event.preventDefault()
        win.hide()
        tray.ensure()
      })

      // Every external navigation goes through the system browser; the window never leaves the app.
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedExternalUrl(url, settings.get().hubEndpoint)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      win.webContents.on('will-navigate', (event, url) => {
        if (url !== win.webContents.getURL()) {
          event.preventDefault()
          if (isAllowedExternalUrl(url, settings.get().hubEndpoint)) void shell.openExternal(url)
        }
      })

      // A route queued while no window existed cannot be sent at did-finish-load:
      // the renderer bootstraps asynchronously (awaits settings/auth IPC in
      // main.tsx) before mounting React, so the 'evt:navigate' listener attaches
      // well after the load event. Wait for the React tree to commit into #root,
      // then flush.
      win.webContents.on('did-finish-load', () => {
        if (pendingRoute === null) return
        void win.webContents
          .executeJavaScript(
            `new Promise((resolve) => {
              const root = document.getElementById('root')
              if (!root || root.childElementCount > 0) return resolve(undefined)
              new MutationObserver((_records, observer) => {
                if (root.childElementCount > 0) {
                  observer.disconnect()
                  resolve(undefined)
                }
              }).observe(root, { childList: true })
            })`
          )
          .then(() => {
            const route = pendingRoute
            if (route === null) return
            pendingRoute = null
            broadcast('evt:navigate', route)
          })
          .catch(() => {
            /* window destroyed before the renderer mounted */
          })
      })

      // Recover from renderer crashes and failed loads instead of leaving a
      // permanently blank window; past the retry bound the user decides.
      let renderFailures = 0
      const recoverRenderer = (reason: string): void => {
        if (win.isDestroyed() || quit?.isQuitting()) return
        renderFailures += 1
        console.error(
          `[window] renderer failure (${reason}), recovery ${renderFailures}/${MAX_RENDER_RECOVERIES}`
        )
        if (renderFailures <= MAX_RENDER_RECOVERIES) {
          setTimeout(() => {
            if (!win.isDestroyed()) win.webContents.reload()
          }, RENDER_RECOVERY_DELAY_MS)
          return
        }
        void dialog
          .showMessageBox(win, {
            type: 'error',
            title: i18n.t('app.name'),
            message: i18n.t('dialogs.renderFailureMessage'),
            detail: i18n.t('dialogs.renderFailureDetail'),
            buttons: [i18n.t('dialogs.renderFailureReload'), i18n.t('dialogs.renderFailureQuit')],
            defaultId: 0
          })
          .then(({ response }) => {
            if (response === 0) {
              renderFailures = 0
              if (!win.isDestroyed()) win.webContents.reload()
            } else {
              app.quit()
            }
          })
      }
      win.webContents.on('render-process-gone', (_event, details) => {
        // 'clean-exit' accompanies ordinary teardown (window close, app quit).
        if (details.reason === 'clean-exit') return
        recoverRenderer(details.reason)
      })
      win.webContents.on(
        'did-fail-load',
        (_event, errorCode, errorDescription, _url, isMainFrame) => {
          // -3 (ERR_ABORTED) is a cancelled navigation, not a failure.
          if (!isMainFrame || errorCode === -3) return
          recoverRenderer(`${errorCode} ${errorDescription}`)
        }
      )

      if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void win.loadURL(process.env.ELECTRON_RENDERER_URL)
      } else {
        void win.loadFile(join(__dirname, '../renderer/index.html'))
      }
      return win
    }

    // Single window-creation path shared by startup, dock activate, and
    // navigate() (menu accelerators / notification clicks with no window).
    const createAppWindow = (): BrowserWindow => createWindow(windowBackground())
    recreateWindow = createAppWindow

    const launchRoute = routeFromLaunchArgs(process.argv, settings.get().hubEndpoint)
    if (launchRoute) pendingRoute = launchRoute
    createAppWindow()
    if (app.isPackaged) {
      try {
        starReminder.sessionStart()
      } catch {
        // Optional community UX must not interrupt updater/auth/follows startup.
        console.error('[star-reminder] failed to record session start')
      }
    }
    void telemetry.capture('app_launched')
    follows.start()

    if (!isDev) {
      // Compare this packaged version with the latest published GitHub Release.
      // Download and installation remain explicit user actions in Settings → About.
      void updater.checkForUpdates()
    }

    // Session restore happens after the window exists so auth events reach the UI.
    void auth.init()

    app.on('activate', () => {
      // During update-install the windows are gone on purpose; recreating one
      // would bring back the old version and cancel the relaunch fallback.
      if (quit?.isQuitting()) return
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      } else {
        createAppWindow()
      }
    })

    app.on('before-quit', (event) => {
      if (!quit) return
      quit.markQuitting()
      if (!quit.canQuit()) event.preventDefault()
      void quit.beginCleanup().finally(() => {
        // quitAndInstall / the macOS relaunch fallback owns the exit so we
        // do not issue a regular quit that skips Squirrel's relaunch.
        if (installingUpdate) return
        app.quit()
      })
    })
  })

  app.on('window-all-closed', () => {
    // Installing: Squirrel should relaunch; if it only closed windows, the
    // fallback timer relaunches. Do not quit here or the new process never starts.
    if (installingUpdate) return
    if (process.platform !== 'darwin' || quit?.isQuitting()) app.quit()
  })
}

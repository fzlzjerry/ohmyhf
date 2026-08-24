/**
 * Registers every IPC handler from the typed contract in @oh-my-huggingface/shared.
 * Each payload is validated (zod) before any work happens; channels that accept no
 * payload reject anything non-null. No string channels appear outside the contract.
 */
import { BrowserWindow, app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import type {
  AppInfo,
  AppSettings,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse
} from '@oh-my-huggingface/shared'
import {
  PROJECT_REPOSITORY_URL,
  SUPPORTED_LOCALES,
  isAllowedExternalUrl,
  ipcRequestSchemas,
  settingsExportFileSchema
} from '@oh-my-huggingface/shared'
import { defaultCacheDir, HubApiError } from '@oh-my-huggingface/hub-api'
import type { HubClient } from '@oh-my-huggingface/hub-api'
import type { AuthManager } from './auth'
import { buildHubClient } from './hub'
import { captureHubSessionCookie } from './hub-session'
import type { CacheManager } from './cache'
import type { AppDatabase } from './db'
import type { DownloadManager } from './downloads'
import type { FollowsPoller } from './follows'
import type { MainI18n } from './i18n'
import type { IntegrationTaskManager } from './integration-tasks'
import type { Library } from './library'
import { clearLocalAppData } from './privacy'
import type { SettingsStore } from './settings'
import { portableSettingsForExport, settingsFromImport } from './settings-transfer'
import type { StarReminderService } from './star-reminder'
import type { TelemetryService } from './telemetry'
import type { UpdateManager } from './updater'
import {
  cancelInference,
  commitRepoFiles,
  detectExportTargets,
  runInference,
  runInferenceStream
} from './integrations'
import { matchLocale } from './i18n'

export interface AppContext {
  db: AppDatabase
  hub: HubClient
  auth: AuthManager
  settings: SettingsStore
  telemetry: TelemetryService
  starReminder: StarReminderService
  starReminderEnabled: boolean
  library: Library
  downloads: DownloadManager
  cache: CacheManager
  follows: FollowsPoller
  integrationTasks: IntegrationTaskManager
  updater: UpdateManager
  i18n: MainI18n
  rebuildMenu: () => void
  broadcast: <C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>) => void
  applyNetworkSettings: (
    next: { hubEndpoint: string | null; proxyUrl: string | null },
    prev: { hubEndpoint: string | null; proxyUrl: string | null }
  ) => Promise<void>
  applyDesktopSettings: (
    next: { launchAtLogin: boolean; closeToTray: boolean; theme: string },
    prev: { launchAtLogin: boolean; closeToTray: boolean; theme: string }
  ) => void
}

function handle<C extends IpcInvokeChannel>(
  channel: C,
  handler: (
    req: IpcRequest<C>,
    event: IpcMainInvokeEvent
  ) => Promise<IpcResponse<C>> | IpcResponse<C>
): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    const schema = ipcRequestSchemas[channel]
    if (schema) {
      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        throw new Error(`Invalid payload for ${channel}: ${parsed.error.message}`)
      }
      return handler(parsed.data as IpcRequest<C>, event)
    }
    if (payload !== undefined && payload !== null) {
      throw new Error(`Channel ${channel} accepts no payload`)
    }
    return handler(undefined as IpcRequest<C>, event)
  })
}

async function applySettingsPatch(
  ctx: AppContext,
  patch: Partial<AppSettings>
): Promise<AppSettings> {
  const prev = ctx.settings.get()
  const telemetryWasEnabled = prev.telemetryEnabled === true
  const explicitTelemetryOptIn = !telemetryWasEnabled && patch.telemetryEnabled === true
  if (explicitTelemetryOptIn) {
    if (!ctx.telemetry.isConfigured()) {
      throw new Error('Telemetry is not configured in this build')
    }
    if (!ctx.telemetry.prepareIdentityForOptIn()) {
      throw new Error('Could not create the local telemetry identifier')
    }
  }

  let next: AppSettings
  try {
    next = ctx.settings.set(patch)
  } catch (error) {
    if (explicitTelemetryOptIn) ctx.telemetry.clearIdentity()
    throw error
  }
  const telemetryIsEnabled = next.telemetryEnabled === true
  if (telemetryWasEnabled && !telemetryIsEnabled) {
    // Stop and erase the pseudonymous identity before any unrelated, fallible
    // network or desktop side effect can interrupt the opt-out path.
    ctx.telemetry.clearIdentity()
  }
  const locale = next.locale === 'system' ? matchLocale(app.getLocale()) : next.locale
  if (SUPPORTED_LOCALES.includes(locale) && locale !== ctx.i18n.getLocale()) {
    ctx.i18n.setLocale(locale)
    ctx.rebuildMenu()
  }
  if (!telemetryWasEnabled && telemetryIsEnabled) {
    // Queue the consent event before an unrelated combined proxy patch can
    // fail. The transport itself reads the already-persisted current proxy.
    void ctx.telemetry.capture('telemetry_enabled')
  }
  await ctx.applyNetworkSettings(
    { hubEndpoint: next.hubEndpoint, proxyUrl: next.proxyUrl },
    { hubEndpoint: prev.hubEndpoint, proxyUrl: prev.proxyUrl }
  )
  ctx.applyDesktopSettings(
    { launchAtLogin: next.launchAtLogin, closeToTray: next.closeToTray, theme: next.theme },
    { launchAtLogin: prev.launchAtLogin, closeToTray: prev.closeToTray, theme: prev.theme }
  )
  return next
}

export function registerIpcHandlers(ctx: AppContext): void {
  /**
   * A 401 from a cookie-backed social write means the captured web session
   * expired or was revoked: auto-disconnect it (broadcasts evt:auth so the
   * UI reverts to the open-on-Hub fallbacks) and rethrow for the caller's
   * toast. 403s are NOT session death (CSRF/WAF/permission) — disconnecting
   * on them falsely drops a still-valid Hub web session. Token-auth 401s
   * can't reach this — cookie requests carry no Authorization header — and
   * CookieRequiredError carries no status.
   */
  const cookieBacked = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      const state = ctx.auth.getState()
      if (
        err instanceof HubApiError &&
        err.status === 401 &&
        state.status === 'signedIn' &&
        state.hubSession
      ) {
        await ctx.auth.disconnectHubSession()
      }
      throw err
    }
  }

  // --- system ---------------------------------------------------------------
  handle('system:getAppInfo', (): AppInfo => {
    return {
      version: app.getVersion(),
      platform: process.platform as AppInfo['platform'],
      electronVersion: process.versions.electron ?? '',
      systemLocale: app.getLocale(),
      hfCacheDir: ctx.settings.get().hfCacheDir ?? defaultCacheDir()
    }
  })
  handle('system:openExternal', async ({ url }) => {
    if (!isAllowedExternalUrl(url, ctx.settings.get().hubEndpoint)) {
      throw new Error('External URL is not allowed')
    }
    await shell.openExternal(url)
  })
  // --- updater --------------------------------------------------------------
  handle('updater:getState', () => ctx.updater.getState())
  handle('updater:check', () => ctx.updater.checkForUpdates())
  handle('updater:download', () => ctx.updater.downloadUpdate())
  handle('updater:install', async () => {
    const state = ctx.updater.getState()
    const version =
      state.status === 'ready' ||
      (state.status === 'error' && state.operation === 'install' && state.availableVersion)
        ? state.availableVersion
        : null
    if (!version) return ctx.updater.installUpdate()

    const result = await dialog.showMessageBox({
      type: 'question',
      title: ctx.i18n.t('dialogs.updateInstallTitle'),
      message: ctx.i18n.t('dialogs.updateInstallMessage', { version }),
      detail: ctx.i18n.t('dialogs.updateInstallDetail'),
      buttons: [
        ctx.i18n.t('dialogs.updateInstallButton'),
        ctx.i18n.t('dialogs.updateInstallCancel')
      ],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (result.response === 0) await ctx.updater.installUpdate()
  })

  // --- settings ---------------------------------------------------------------
  handle('settings:get', () => ctx.settings.get())
  handle('settings:set', async ({ patch }) => applySettingsPatch(ctx, patch))
  handle('settings:selectCacheDir', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    const entry = await lstat(selected)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Selected cache directory is not a regular directory')
    }
    const canonical = await realpath(selected)
    return applySettingsPatch(ctx, { hfCacheDir: canonical })
  })
  handle('settings:resetCacheDir', () => applySettingsPatch(ctx, { hfCacheDir: null }))

  // --- community -------------------------------------------------------------
  handle('telemetry:claimConsentPrompt', () => {
    const claim = ctx.telemetry.claimConsentPrompt()
    return claim ? { show: true as const, claimId: claim.claimId } : { show: false as const }
  })
  handle('telemetry:acknowledgeConsentPrompt', ({ claimId }) =>
    ctx.telemetry.acknowledgeConsentPrompt(claimId)
  )
  handle('starReminder:claim', () => {
    if (!ctx.starReminderEnabled) return { show: false as const }
    try {
      const claim = ctx.starReminder.claim()
      if (!claim) return { show: false as const }
      return { show: true as const, claimId: claim.claimId }
    } catch {
      return { show: false as const }
    }
  })
  handle('starReminder:acknowledgeShown', ({ claimId }) => {
    if (!ctx.starReminderEnabled) return { accepted: false as const }
    try {
      const acknowledged = ctx.starReminder.acknowledgeShown(claimId)
      if (acknowledged.accepted && acknowledged.newlyAccepted) {
        void ctx.telemetry.capture('star_prompt_shown', {
          prompt_number: acknowledged.promptNumber,
          action: 'shown'
        })
      }
      return acknowledged
    } catch {
      return { accepted: false as const }
    }
  })
  handle('starReminder:respond', async ({ claimId, action }) => {
    if (!ctx.starReminderEnabled) return { accepted: false as const }

    // The token check and state transition are one IMMEDIATE transaction. Only
    // its winner performs a browser side effect or emits outcome telemetry.
    const result = ctx.starReminder.respond(claimId, action)
    if (!result.accepted) return result

    if (result.outcome === 'opened') {
      let externalOpened = false
      try {
        await shell.openExternal(PROJECT_REPOSITORY_URL)
        externalOpened = true
        void ctx.telemetry.capture('star_prompt_opened', {
          prompt_number: result.promptNumber,
          action: 'open'
        })
      } catch {
        // The atomic response is still consumed; the renderer reports a generic
        // browser-launch error instead of retrying the already-used claim token.
      }
      return { ...result, externalOpened }
    }

    if (result.outcome === 'snoozed') {
      void ctx.telemetry.capture('star_prompt_snoozed', {
        prompt_number: result.promptNumber,
        action: 'later'
      })
      return {
        accepted: true as const,
        outcome: 'snoozed' as const,
        promptNumber: result.promptNumber
      }
    }
    if (result.outcome === 'exhausted') {
      void ctx.telemetry.capture('star_prompt_exhausted', {
        prompt_number: 2,
        action: 'exhausted'
      })
      return {
        accepted: true as const,
        outcome: 'exhausted' as const,
        promptNumber: result.promptNumber
      }
    }
    void ctx.telemetry.capture('star_prompt_disabled', {
      prompt_number: result.promptNumber,
      action: 'disable'
    })
    return {
      accepted: true as const,
      outcome: 'disabled' as const,
      promptNumber: result.promptNumber
    }
  })

  handle('settings:export', async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: 'ohmyhf-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true as const }
    const payload = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      settings: portableSettingsForExport(ctx.settings.get())
    }
    await writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return { canceled: false as const, path: result.filePath }
  })

  handle('settings:import', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { canceled: true as const }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    } catch {
      throw new Error('Invalid settings file')
    }
    const parsed = settingsExportFileSchema.safeParse(raw)
    if (!parsed.success) throw new Error('Invalid settings file')
    const next = await applySettingsPatch(
      ctx,
      settingsFromImport(ctx.settings.get(), parsed.data.settings)
    )
    return { canceled: false as const, settings: next }
  })

  handle('privacy:clearLocalData', async (req) => {
    const signOut = req.signOut === true
    const selective = (
      ['favorites', 'history', 'downloads', 'follows', 'inbox', 'otherKv'] as const
    ).some((key) => req[key] !== undefined)
    const clearDownloads = selective ? req.downloads === true : true
    const clearOtherKv = selective ? req.otherKv === true : true
    if (clearDownloads) ctx.downloads.clearAll()
    clearLocalAppData(ctx.db, req)
    if (clearOtherKv) ctx.telemetry.clearIdentity()
    if (signOut) {
      await ctx.auth.signOut()
    }
    return { cleared: true as const, signedOut: signOut }
  })

  handle('network:testConnection', async (req) => {
    const applied = ctx.settings.get()
    const endpoint = req?.endpoint !== undefined ? req.endpoint : applied.hubEndpoint
    const proxyUrl = req?.proxyUrl !== undefined ? req.proxyUrl : applied.proxyUrl
    // Drafts are probed on a throwaway client so the live client (and the
    // recorded applied network options) are never touched. Credentials stay
    // bound to the endpoint they belong to — the same rule Apply enforces — so
    // NEITHER the token NOR the web-session cookie ever rides along to a draft
    // mirror endpoint. The probe (public trending search) needs no auth, so a
    // draft host receives an anonymous request; this keeps the main-process
    // token siloed even if the renderer supplies an arbitrary endpoint.
    const endpointMatches = endpoint === applied.hubEndpoint
    const matchesApplied = endpointMatches && proxyUrl === applied.proxyUrl
    const client = matchesApplied
      ? ctx.hub
      : buildHubClient(
          endpointMatches ? () => ctx.auth.accessToken() : () => undefined,
          endpointMatches ? () => ctx.auth.sessionCookie() : () => undefined,
          { endpoint, proxyUrl }
        )
    try {
      await client.searchRepos({ kind: 'model', sort: 'trending', limit: 1 })
      return { ok: true as const }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  // --- hub --------------------------------------------------------------------
  handle('hub:search', ({ query }) => ctx.hub.searchRepos(query))
  handle('hub:papers', (req) => ctx.hub.getDailyPapers(req?.cursor))
  handle('hub:paper', ({ paperId }) => ctx.hub.getPaper(paperId))
  handle('hub:repoDetail', ({ kind, repoId }) => ctx.hub.getRepoDetail(kind, repoId))
  handle('hub:readme', ({ kind, repoId, revision }) => ctx.hub.getReadme(kind, repoId, revision))
  handle('hub:fileTree', ({ kind, repoId, revision, path }) =>
    ctx.hub.getFileTree(kind, repoId, revision, path)
  )
  handle('hub:commitFiles', (req) => commitRepoFiles(req, ctx.auth.accessToken()))
  handle('hub:discussions', ({ kind, repoId, type, status, cursor }) =>
    ctx.hub.listDiscussions(kind, repoId, { type, status, cursor })
  )
  handle('hub:discussionDiff', ({ kind, repoId, num }) =>
    ctx.hub.getDiscussionDiff(kind, repoId, num)
  )
  handle('hub:posts', (req) => ctx.hub.getPosts(req?.cursor))
  handle('hub:recentActivity', (req) => cookieBacked(() => ctx.hub.getRecentActivity(req?.cursor)))
  handle('hub:postDetail', ({ author, slug }) => ctx.hub.getPostDetail(author, slug))
  handle('hub:userOverview', ({ username }) => ctx.hub.getUserOverview(username))
  handle('hub:userFollowing', ({ username }) => ctx.hub.getUserFollowing(username))
  handle('hub:orgMembers', ({ org, limit }) => ctx.hub.getOrgMembers(org, limit))
  handle('hub:discussionDetail', ({ kind, repoId, num }) =>
    ctx.hub.getDiscussion(kind, repoId, num)
  )
  handle('hub:discussionCreate', ({ kind, repoId, title, description, pullRequest }) =>
    ctx.hub.createDiscussion(kind, repoId, title, description, pullRequest ?? false)
  )
  handle('hub:discussionComment', ({ kind, repoId, num, comment }) =>
    ctx.hub.commentOnDiscussion(kind, repoId, num, comment)
  )
  handle('hub:notifications', (req) => ctx.hub.getNotifications(req?.page))
  handle('hub:notificationsMarkRead', ({ discussionIds, read }) =>
    ctx.hub.markNotificationsRead(discussionIds, read)
  )
  handle('hub:notificationsClear', () => ctx.hub.clearNotifications())
  handle('hub:fileRange', ({ kind, repoId, path, revision, start, end }) =>
    ctx.hub.fetchFileRange(kind, repoId, path, start, end, revision)
  )
  handle('hub:fileText', ({ kind, repoId, path, revision, maxBytes }) =>
    ctx.hub.getFileText(kind, repoId, path, revision, maxBytes)
  )
  handle('hub:safetensorsHeader', ({ kind, repoId, path, revision }) =>
    ctx.hub.getSafetensorsHeader(kind, repoId, path, revision)
  )
  handle('hub:datasetSplits', ({ repoId }) => ctx.hub.getDatasetSplits(repoId))
  handle('hub:searchUsers', ({ query }) => ctx.hub.searchUsers(query))
  handle('hub:searchOrgs', ({ query }) => ctx.hub.searchOrgs(query))
  handle('hub:searchPapers', ({ query }) => ctx.hub.searchPapers(query))
  handle('hub:searchCollections', ({ query }) => ctx.hub.searchCollections(query))
  handle('hub:inferenceAvailable', ({ repoId }) => ctx.hub.isInferenceAvailable(repoId))
  handle('hub:datasetRows', ({ repoId, config, split, offset, length }) =>
    ctx.hub.getDatasetRows(repoId, config, split, offset, length)
  )

  // --- hub: collections ---------------------------------------------------------
  handle('hub:collections', ({ owner }) => ctx.hub.listCollections(owner))
  handle('hub:collection', ({ slug }) => ctx.hub.getCollection(slug))
  handle('hub:collectionCreate', (input) => ctx.hub.createCollection(input))
  handle('hub:collectionUpdate', ({ slug, patch }) => ctx.hub.updateCollection(slug, patch))
  handle('hub:collectionDelete', ({ slug }) => ctx.hub.deleteCollection(slug))
  handle('hub:collectionAddItem', ({ slug, item, note }) =>
    ctx.hub.addCollectionItem(slug, item, note)
  )
  handle('hub:collectionUpdateItem', ({ slug, itemId, note, position }) =>
    ctx.hub.updateCollectionItem(slug, itemId, { note, position })
  )
  handle('hub:collectionRemoveItem', ({ slug, itemId }) =>
    ctx.hub.removeCollectionItem(slug, itemId)
  )

  // --- hub: repo administration ---------------------------------------------------
  handle('hub:watchUpdate', (changes) => cookieBacked(() => ctx.hub.updateWatch(changes)))
  handle('hub:watchList', () => ctx.hub.listWatched())
  handle('hub:watchSet', ({ id, type, watching }) =>
    cookieBacked(() => ctx.hub.setWatch({ id, type }, watching))
  )
  handle('hub:myRepos', () => ctx.hub.listMyRepos())
  handle('hub:repoSettingsUpdate', ({ kind, repoId, patch }) =>
    ctx.hub.updateRepoSettings(kind, repoId, patch)
  )
  handle('hub:repoMove', ({ kind, fromRepo, toRepo }) => ctx.hub.moveRepo(kind, fromRepo, toRepo))
  handle('hub:repoDelete', ({ kind, repoId }) => ctx.hub.deleteRepo(kind, repoId))
  handle('hub:repoDuplicate', ({ repoId, toRepo, private: isPrivate }) =>
    ctx.hub.duplicateSpace(repoId, toRepo, { private: isPrivate })
  )
  handle('hub:branchCreate', ({ kind, repoId, branch, startingPoint }) =>
    ctx.hub.createBranch(kind, repoId, branch, startingPoint)
  )
  handle('hub:branchDelete', ({ kind, repoId, branch }) =>
    ctx.hub.deleteBranch(kind, repoId, branch)
  )
  handle('hub:tagCreate', ({ kind, repoId, tag, revision, message }) =>
    ctx.hub.createTag(kind, repoId, tag, revision, message)
  )
  handle('hub:tagDelete', ({ kind, repoId, tag }) => ctx.hub.deleteTag(kind, repoId, tag))
  handle('hub:accessRequests', ({ kind, repoId, status }) =>
    ctx.hub.listAccessRequests(kind, repoId, status)
  )
  handle('hub:accessRequestHandle', ({ kind, repoId, user, status, rejectionReason }) =>
    ctx.hub.handleAccessRequest(kind, repoId, user, status, rejectionReason)
  )
  handle('hub:accessRequestGrant', ({ kind, repoId, user }) =>
    ctx.hub.grantAccess(kind, repoId, user)
  )

  // --- hub: space administration ----------------------------------------------------
  handle('hub:spaceSecrets', ({ repoId }) => ctx.hub.listSpaceSecrets(repoId))
  handle('hub:spaceSecretSet', ({ repoId, key, value, description }) =>
    ctx.hub.setSpaceSecret(repoId, key, value, description)
  )
  handle('hub:spaceSecretDelete', ({ repoId, key }) => ctx.hub.deleteSpaceSecret(repoId, key))
  handle('hub:spaceVariables', ({ repoId }) => ctx.hub.listSpaceVariables(repoId))
  handle('hub:spaceVariableSet', ({ repoId, key, value, description }) =>
    ctx.hub.setSpaceVariable(repoId, key, value, description)
  )
  handle('hub:spaceVariableDelete', ({ repoId, key }) => ctx.hub.deleteSpaceVariable(repoId, key))
  handle('hub:spaceLogs', ({ repoId, logType }) => ctx.hub.getSpaceLogsSnapshot(repoId, logType))
  handle('hub:spaceRestart', ({ repoId, factory }) => ctx.hub.restartSpace(repoId, factory))

  // --- hub: community & billing --------------------------------------------------------
  // Like (POST) rides the web session; unlike (DELETE) rides the token, so a
  // token 401 there must not tear down the web session.
  handle('hub:likeSet', ({ kind, repoId, liked }) =>
    liked
      ? cookieBacked(() => ctx.hub.setLike(kind, repoId, true))
      : ctx.hub.setLike(kind, repoId, false)
  )
  handle('hub:followSet', ({ username, following, isOrg }) =>
    ctx.hub.setFollow(username, following, isOrg === true)
  )
  handle('hub:userLikes', ({ username }) => ctx.hub.getUserLikes(username))
  handle('hub:postComment', ({ author, slug, comment, replyToCommentId }) =>
    cookieBacked(() => ctx.hub.commentOnPost(author, slug, comment, replyToCommentId))
  )
  handle('hub:postReactionSet', ({ author, slug, reaction, active }) =>
    cookieBacked(() => ctx.hub.setPostReaction(author, slug, reaction, active))
  )
  handle('hub:postComments', ({ author, slug }) => ctx.hub.getPostComments(author, slug))
  handle('hub:postCommentHide', ({ author, slug, commentId, reason }) =>
    cookieBacked(() => ctx.hub.hidePostComment(author, slug, commentId, reason))
  )
  handle('hub:commentAssetUpload', async ({ filename: _filename, contentType, data }) => {
    const url = await cookieBacked(() => ctx.hub.uploadCommentAsset(data, contentType))
    return { url }
  })
  handle('hub:postCommentReactionSet', ({ author, slug, commentId, reaction, active }) =>
    cookieBacked(() => ctx.hub.setPostCommentReaction(author, slug, commentId, reaction, active))
  )
  handle('hub:postCanCreate', () => ctx.hub.canCreatePost())
  handle('hub:postCreate', ({ content }) => cookieBacked(() => ctx.hub.createPost(content)))
  handle('hub:profileGet', () => cookieBacked(() => ctx.hub.getProfileSettings()))
  handle('hub:profileUpdate', async (update) => {
    await cookieBacked(() => ctx.hub.updateProfileSettings(update))
    // Avatar/fullname live on auth.user (TopBar/Sidebar); refresh before return
    // so the renderer can pick them up without an app restart.
    await ctx.auth.refreshUser()
  })
  handle('hub:datasetSampleRows', async ({ repoId }) => {
    return (await ctx.hub.getDatasetSampleRows(repoId)) ?? null
  })
  handle('hub:repoAccessGate', ({ kind, repoId }) => ctx.hub.getRepoAccessGate(kind, repoId))
  handle('hub:repoAccessAsk', ({ kind, repoId, fields }) =>
    cookieBacked(() => ctx.hub.askRepoAccess(kind, repoId, fields))
  )
  handle('hub:paperUpvoteSet', ({ paperId, upvoted }) =>
    cookieBacked(() => ctx.hub.setPaperUpvote(paperId, upvoted))
  )
  handle('hub:collectionUpvoteSet', ({ slug, upvoted }) =>
    cookieBacked(() => ctx.hub.setCollectionUpvote(slug, upvoted))
  )
  handle('hub:discussionReactionSet', ({ kind, repoId, num, commentId, reaction, active }) =>
    cookieBacked(() =>
      ctx.hub.setDiscussionCommentReaction(kind, repoId, num, commentId, reaction, active)
    )
  )
  handle('hub:paperComment', ({ paperId, comment, replyToCommentId }) =>
    ctx.hub.commentOnPaper(paperId, comment, replyToCommentId)
  )
  handle('hub:paperComments', ({ paperId }) => ctx.hub.getPaperComments(paperId))
  handle('hub:paperCommentReactionSet', ({ paperId, commentId, reaction, active }) =>
    cookieBacked(() => ctx.hub.setPaperCommentReaction(paperId, commentId, reaction, active))
  )
  handle('hub:prMerge', ({ kind, repoId, num, comment }) =>
    ctx.hub.mergePullRequest(kind, repoId, num, comment)
  )
  handle('hub:discussionStatusSet', ({ kind, repoId, num, status, comment }) =>
    ctx.hub.setDiscussionStatus(kind, repoId, num, status, comment)
  )
  handle('hub:discussionTitleSet', ({ kind, repoId, num, title }) =>
    ctx.hub.setDiscussionTitle(kind, repoId, num, title)
  )
  handle('hub:billingUsage', () => ctx.hub.getBillingUsage())

  // --- auth ---------------------------------------------------------------------
  handle('auth:getState', () => ctx.auth.getState())
  // The token is a secret: never log this payload.
  handle('auth:signInWithToken', ({ token }) => ctx.auth.signInWithToken(token))
  handle('auth:signOut', () => ctx.auth.signOut())
  // The captured cookie is a secret: it stays in the main process, never logged.
  handle('auth:connectHubSession', async () => {
    if (ctx.auth.getState().status !== 'signedIn')
      return { ok: false as const, error: 'invalid' as const }
    const settings = ctx.settings.get()
    const captured = await captureHubSessionCookie({
      endpoint: ctx.hub.baseUrl,
      proxyUrl: settings.proxyUrl,
      parent: BrowserWindow.getAllWindows()[0]
    })
    if (!captured.ok) return { ok: false as const, error: captured.error }
    return ctx.auth.connectHubSession(captured.cookie)
  })
  handle('auth:disconnectHubSession', () => ctx.auth.disconnectHubSession())
  handle('auth:refreshUser', () => ctx.auth.refreshUser())

  // --- local library --------------------------------------------------------------
  handle('favorites:list', () => ctx.library.listFavorites())
  handle('favorites:add', ({ summary }) => ctx.library.addFavorite(summary))
  handle('favorites:remove', ({ kind, repoId }) => ctx.library.removeFavorite(kind, repoId))
  handle('history:list', () => ctx.library.listHistory())
  handle('history:record', ({ summary }) => ctx.library.recordHistory(summary))
  handle('history:clear', () => ctx.library.clearHistory())

  // --- downloads -------------------------------------------------------------------
  handle('downloads:list', () => ctx.downloads.list())
  handle('downloads:start', ({ request }) => ctx.downloads.start(request))
  handle('downloads:pause', ({ id }) => ctx.downloads.pause(id))
  handle('downloads:resume', ({ id }) => ctx.downloads.resume(id))
  handle('downloads:cancel', ({ id }) => ctx.downloads.cancel(id))
  handle('downloads:remove', ({ id }) => ctx.downloads.remove(id))
  handle('downloads:pauseAll', () => ctx.downloads.pauseAll())
  handle('downloads:resumeAll', () => ctx.downloads.resumeAll())
  handle('downloads:clearCompleted', () => ctx.downloads.clearCompleted())
  handle('downloads:reveal', async ({ id }) => {
    shell.showItemInFolder(await ctx.downloads.resolveRevealPath(id))
  })

  // --- cache -------------------------------------------------------------------------
  handle('cache:scan', () => ctx.cache.scan())
  handle('cache:snapshot', ({ kind, repoId }) => ctx.cache.snapshot(kind, repoId))
  handle('cache:readText', ({ kind, repoId, path, maxBytes }) =>
    ctx.cache.readText(kind, repoId, path, maxBytes)
  )
  handle('cache:deleteRevisions', ({ kind, repoId, commitHashes }) =>
    ctx.cache.deleteRevisions(kind, repoId, commitHashes)
  )
  handle('cache:cleanPartials', ({ kind, repoId }) => ctx.cache.cleanPartials(kind, repoId))
  handle('cache:revealRepo', async ({ kind, repoId }) => {
    shell.showItemInFolder(await ctx.cache.resolveRepo(kind, repoId))
  })

  // --- follows & inbox ------------------------------------------------------------------
  handle('follows:list', () => ctx.library.listFollows())
  handle('follows:add', ({ type, target }) => ctx.library.addFollow(type, target))
  handle('follows:remove', ({ id }) => ctx.library.removeFollow(id))
  handle('inbox:list', () => ctx.library.listInbox())
  handle('inbox:markRead', ({ ids }) => ctx.library.markInboxRead(ids))
  handle('inbox:clear', () => ctx.library.clearInbox())
  handle('inbox:pollNow', async () => ({ added: await ctx.follows.poll() }))

  // --- phase E ----------------------------------------------------------------------------
  handle('export:targets', () => detectExportTargets())
  handle('export:start', ({ request }) => ctx.integrationTasks.startExport(request))
  handle('export:cancel', ({ id }) => ctx.integrationTasks.cancel(id, 'export'))
  handle('upload:selectFolder', (_request, event) =>
    ctx.integrationTasks.selectUploadFolder(event.sender)
  )
  handle('upload:start', ({ request }, event) =>
    ctx.integrationTasks.startUpload(request, event.sender.id)
  )
  handle('upload:cancel', ({ id }) => ctx.integrationTasks.cancel(id, 'upload'))
  handle('integrationTasks:list', () => ctx.integrationTasks.list())
  handle('integrationTasks:revealOutput', ({ id }) => ctx.integrationTasks.revealOutput(id))
  handle('inference:run', ({ request }) => runInference(request, ctx.auth.accessToken()))
  handle('inference:stream', ({ id, request }) =>
    runInferenceStream(id, request, {
      accessToken: ctx.auth.accessToken(),
      broadcast: ctx.broadcast
    })
  )
  handle('inference:cancel', ({ id }) => {
    cancelInference(id)
  })
}

import { createContext, useContext, useId, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  Bell,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  LogOut,
  Minus,
  Monitor,
  PanelTop,
  Plus,
  RefreshCw,
  Shield,
  UserCircle2,
  UserPen,
  Wifi
} from 'lucide-react'
import type {
  AccentPreset,
  AppUpdateState,
  BrowsePageSize,
  DefaultHome,
  HistoryLimit,
  Locale,
  RepoOpenTarget,
  RepoSort,
  UiDensity
} from '@oh-my-huggingface/shared'
import { hubSettingsUrl, normalizeHubEndpoint, SUPPORTED_LOCALES } from '@oh-my-huggingface/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { ACCENT_SWATCH } from '@/lib/appearance'
import { changeLanguage } from '@/i18n'
import { cn, formatBytes, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PlanBadge } from '@/components/profile/PlanBadge'
import { ProfileAvatar } from '@/components/profile/ProfileAvatar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger as BaseSelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Switch as BaseSwitch } from '@/components/ui/switch'
import { useToasts } from '@/components/ui/toaster'
import type { SettingsSection } from '@/stores/app'
import { resolveLocale, useAppStore } from '@/stores/app'
import { isAuthError } from '@/lib/errors'
import { APP_UPDATE_QUERY_KEY } from '@/lib/query'
import { PrivacySection } from '@/components/settings/PrivacySection'
import { ProfileSection } from '@/components/settings/ProfileSection'
import { NetworkSection } from '@/components/settings/NetworkSection'
import { DesktopSection } from '@/components/settings/DesktopSection'

const REPO_URL = 'https://github.com/oh-my-hf/ohmyhf'
const RELEASES_URL = `${REPO_URL}/releases`
const SPEED_OPTIONS = [1, 5, 10, 20, 50] // MB/s
const UI_SCALE_MIN = 80
const UI_SCALE_MAX = 140
const UI_SCALE_STEP = 10
const FONT_SCALE_MIN = 90
const FONT_SCALE_MAX = 120
const FONT_SCALE_STEP = 5
const ACCENT_OPTIONS: AccentPreset[] = ['default', 'blue', 'green', 'orange', 'violet']
const PAGE_SIZE_OPTIONS: BrowsePageSize[] = [20, 30, 50]
const HISTORY_LIMIT_OPTIONS: HistoryLimit[] = [50, 100, 200, 500]

interface RowA11yContextValue {
  labelId: string
  descriptionId?: string
}

const RowA11yContext = createContext<RowA11yContextValue | undefined>(undefined)

function RowSelectTrigger(props: ComponentProps<typeof BaseSelectTrigger>): React.JSX.Element {
  const a11y = useContext(RowA11yContext)
  return (
    <BaseSelectTrigger
      {...props}
      aria-labelledby={props['aria-labelledby'] ?? a11y?.labelId}
      aria-describedby={props['aria-describedby'] ?? a11y?.descriptionId}
    />
  )
}

function RowSwitch(props: ComponentProps<typeof BaseSwitch>): React.JSX.Element {
  const a11y = useContext(RowA11yContext)
  return (
    <BaseSwitch
      {...props}
      aria-labelledby={props['aria-labelledby'] ?? a11y?.labelId}
      aria-describedby={props['aria-describedby'] ?? a11y?.descriptionId}
    />
  )
}

interface NavEntry {
  id: SettingsSection
  labelKey: string
  icon: React.ComponentType<{ className?: string }>
}

interface NavGroup {
  labelKey: string
  items: NavEntry[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'settings:groups.account',
    items: [
      { id: 'account', labelKey: 'settings:account.title', icon: UserCircle2 },
      { id: 'profile', labelKey: 'settings:profile.title', icon: UserPen }
    ]
  },
  {
    labelKey: 'settings:groups.interface',
    items: [
      { id: 'appearance', labelKey: 'settings:appearance.title', icon: Monitor },
      { id: 'downloads', labelKey: 'settings:downloads.title', icon: ArrowDownToLine },
      { id: 'notifications', labelKey: 'settings:notifications.title', icon: Bell }
    ]
  },
  {
    labelKey: 'settings:groups.connection',
    items: [{ id: 'network', labelKey: 'settings:network.title', icon: Wifi }]
  },
  {
    labelKey: 'settings:groups.system',
    items: [{ id: 'desktop', labelKey: 'settings:desktop.title', icon: PanelTop }]
  },
  {
    labelKey: 'settings:groups.data',
    items: [{ id: 'privacy', labelKey: 'settings:privacy.title', icon: Shield }]
  },
  {
    labelKey: 'settings:groups.about',
    items: [{ id: 'about', labelKey: 'settings:about.title', icon: Info }]
  }
]

function SectionShell({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-smd font-semibold text-ink-strong">{title}</h2>
      {children}
    </section>
  )
}

function Row({
  label,
  description,
  children
}: {
  label: string
  /** Optional secondary line under the label. */
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  const labelId = `${id}-label`
  const descriptionId = description ? `${id}-description` : undefined

  return (
    <div className="flex min-h-8 items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-[13px] text-ink-muted">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="text-[11.5px] text-ink-faint">
            {description}
          </span>
        ) : null}
      </div>
      <RowA11yContext.Provider value={{ labelId, descriptionId }}>
        {children}
      </RowA11yContext.Provider>
    </div>
  )
}

function AccountSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'auth', 'profile'])
  const auth = useAppStore((s) => s.auth)
  const setAuth = useAppStore((s) => s.setAuth)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const navigate = useNavigate()

  const signOut = useMutation({
    mutationFn: () => invoke('auth:signOut', undefined),
    onSuccess: setAuth
  })

  return (
    <SectionShell title={t('settings:account.title')}>
      {auth.status === 'signedIn' ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <ProfileAvatar
              name={auth.user.name}
              url={auth.user.avatarUrl}
              className="size-9 text-[12px]"
              isPro={auth.user.isPro === true}
              frame="compact"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13.5px] font-medium text-ink-strong">
                  {auth.user.fullname ?? auth.user.name}
                </span>
                {auth.user.isPro && <PlanBadge kind="pro" />}
              </div>
              <div className="truncate text-[12px] text-ink-muted">@{auth.user.name}</div>
              {auth.user.orgs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {auth.user.orgs.map((org) => (
                    <span key={org.name} className="inline-flex items-center gap-1">
                      <Badge variant="outline">{org.name}</Badge>
                      {org.plan && <PlanBadge kind={org.plan} />}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                closeSettings()
                navigate(`/users/${auth.user.name}`)
              }}
            >
              {t('profile:viewProfile')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => signOut.mutate()}>
              <LogOut className="size-3.5" aria-hidden />
              {t('auth:signOut')}
            </Button>
          </div>
          <TokenAccountBlock
            displayName={auth.tokenDisplayName}
            role={auth.tokenRole}
            hubSession={auth.hubSession === true}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-ink-faint">{t('auth:hint')}</p>
          <TokenSignInForm />
        </div>
      )}
    </SectionShell>
  )
}

/**
 * Paste-a-token sign-in. The token is a secret: password field, no
 * autocomplete, never echoed anywhere. Failures surface inline (invalid vs
 * network) — a failed paste never disturbs the current session.
 */
function TokenSignInForm({ onDone }: { onDone?: () => void }): React.JSX.Element {
  const { t } = useTranslation(['auth'])
  const setAuth = useAppStore((s) => s.setAuth)
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const [token, setToken] = useState('')
  const [alsoConnect, setAlsoConnect] = useState(true)
  const [error, setError] = useState<'invalid' | 'forbidden' | 'network' | null>(null)

  const submit = useMutation({
    mutationFn: (value: string) => invoke('auth:signInWithToken', { token: value }),
    onSuccess: (result) => {
      if (result.ok) {
        setAuth(result.state)
        setToken('')
        onDone?.()
        if (alsoConnect && result.state.status === 'signedIn' && result.state.hubSession !== true) {
          void invoke('auth:connectHubSession', undefined).then((session) => {
            if (session.ok) setAuth(session.state)
          })
        }
      } else {
        setError(result.error)
      }
    },
    onError: () => setError('network')
  })

  return (
    <form
      className="flex max-w-96 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const value = token.trim()
        if (value === '' || submit.isPending) return
        setError(null)
        submit.mutate(value)
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-strong">
          {t('auth:tokenSignIn.label')}
        </span>
        <Input
          type="password"
          value={token}
          placeholder={t('auth:tokenSignIn.placeholder')}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
          onChange={(event) => {
            setToken(event.target.value)
            setError(null)
          }}
        />
        {error !== null && (
          <span className="text-[12px] text-error">{t(`auth:tokenSignIn.${error}`)}</span>
        )}
      </label>
      <p className="max-w-[65ch] text-[12px] text-ink-faint">{t('auth:tokenSignIn.hint')}</p>
      <label className="flex items-center gap-2 text-[12.5px] text-ink">
        <input
          type="checkbox"
          className="size-3.5 accent-select"
          checked={alsoConnect}
          onChange={(event) => setAlsoConnect(event.target.checked)}
        />
        {t('auth:tokenSignIn.alsoConnect')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="cta"
          size="sm"
          loading={submit.isPending}
          disabled={token.trim() === ''}
        >
          <KeyRound className="size-3.5" aria-hidden />
          {t('auth:tokenSignIn.submit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => openExternal(hubSettingsUrl('tokens', endpoint))}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t('auth:tokenSignIn.createLink')}
        </Button>
      </div>
    </form>
  )
}

const TOKEN_ROLE_KEYS: Record<string, string> = {
  read: 'settings:account.hub.roleLabels.read',
  write: 'settings:account.hub.roleLabels.write',
  fineGrained: 'settings:account.hub.roleLabels.fineGrained'
}

/**
 * Signed in with a User Access Token: the token's own permissions decide what
 * works, and the API is the referee.
 */
function TokenAccountBlock({
  displayName,
  role,
  hubSession
}: {
  displayName?: string
  role?: string
  hubSession: boolean
}): React.JSX.Element {
  const { t } = useTranslation(['settings', 'auth'])
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <h3 className="text-[13px] font-semibold text-ink-strong">
        {t('settings:account.hub.title')}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="neutral">{t('settings:account.hub.tokenSession')}</Badge>
        {displayName !== undefined && displayName !== '' && (
          <Badge variant="outline" className="font-mono text-[11px]">
            {displayName}
          </Badge>
        )}
        {role !== undefined && role !== '' && (
          <Badge variant="outline">
            {TOKEN_ROLE_KEYS[role] !== undefined ? t(TOKEN_ROLE_KEYS[role]) : role}
          </Badge>
        )}
      </div>
      <p className="max-w-[65ch] text-[12px] text-ink-faint">
        {t('settings:account.hub.tokenHint')}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 rounded-lg border border-border-card bg-card-gradient p-3">
          <h4 className="text-[12px] font-semibold text-ink-strong">
            {t('auth:capabilities.tokenTitle')}
          </h4>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12px] text-ink-muted">
            <li>{t('auth:capabilities.tokenDownload')}</li>
            <li>{t('auth:capabilities.tokenGated')}</li>
            <li>{t('auth:capabilities.tokenAdmin')}</li>
            <li>{t('auth:capabilities.tokenDiscuss')}</li>
          </ul>
        </div>
        <div className="flex flex-col gap-1.5 rounded-lg border border-border-card bg-card-gradient p-3">
          <h4 className="text-[12px] font-semibold text-ink-strong">
            {t('auth:capabilities.sessionTitle')}
          </h4>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12px] text-ink-muted">
            <li>{t('auth:capabilities.sessionLike')}</li>
            <li>{t('auth:capabilities.sessionReact')}</li>
            <li>{t('auth:capabilities.sessionPost')}</li>
            <li>{t('auth:capabilities.sessionProfile')}</li>
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => openExternal(hubSettingsUrl('tokens', endpoint))}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t('auth:tokenSignIn.createLink')}
        </Button>
      </div>
      <HubSessionBlock connected={hubSession} />
      <BillingUsageCard />
    </div>
  )
}

/**
 * Supplemental Hub web session: a real login window captures the Hub cookie,
 * unlocking the social writes tokens can't do (like, post reactions/comments,
 * watch, discussion reactions). The cookie never reaches this process — only
 * the connected flag does.
 */
function HubSessionBlock({ connected }: { connected: boolean }): React.JSX.Element {
  const { t } = useTranslation(['auth'])
  const setAuth = useAppStore((s) => s.setAuth)
  const [error, setError] = useState<
    'mismatch' | 'timeout' | 'invalid' | 'forbidden' | 'network' | null
  >(null)

  const connect = useMutation({
    mutationFn: () => invoke('auth:connectHubSession', undefined),
    onSuccess: (result) => {
      if (result.ok) {
        setAuth(result.state)
      } else if (result.error !== 'canceled') {
        // Closing the login window is a deliberate cancel — no error banner.
        setError(result.error)
      }
    },
    onError: () => setError('network')
  })

  const disconnect = useMutation({
    mutationFn: () => invoke('auth:disconnectHubSession', undefined),
    onSuccess: setAuth
  })

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-card bg-card-gradient p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="text-[12.5px] font-medium text-ink-strong">{t('auth:hubSession.title')}</h4>
        {connected && <Badge variant="success">{t('auth:hubSession.connected')}</Badge>}
      </div>
      <p className="max-w-[65ch] text-[12px] text-ink-faint">
        {connected ? t('auth:hubSession.hint') : t('auth:hubSession.nextStep')}
      </p>
      {error !== null && <p className="text-[12px] text-error">{t(`auth:hubSession.${error}`)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {connected ? (
          <Button
            variant="secondary"
            size="sm"
            loading={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t('auth:hubSession.disconnect')}
          </Button>
        ) : (
          <Button
            variant="cta"
            size="sm"
            loading={connect.isPending}
            onClick={() => {
              setError(null)
              connect.mutate()
            }}
          >
            <Globe className="size-3.5" aria-hidden />
            {t('auth:hubSession.connect')}
          </Button>
        )}
      </div>
    </div>
  )
}

function BillingUsageCard(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)

  const usage = useQuery({
    queryKey: ['hub-billing-usage', endpointKey],
    queryFn: () => invoke('hub:billingUsage', undefined),
    // A 401/403 is a capability gap, not a transient failure — do not retry it.
    retry: (failureCount, error) => failureCount < 2 && !isAuthError(error.message)
  })

  // The Hub bills in USD; rows carry integer cents.
  const formatAmount = (cents: number): string =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100)

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-card bg-card-gradient p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[12.5px] font-medium text-ink-strong">
          {t('settings:account.billing.title')}
        </h4>
        {usage.data?.periodStart !== undefined && usage.data.periodEnd !== undefined && (
          <span className="nums text-[11.5px] text-ink-faint">
            {t('settings:account.billing.period', {
              start: formatDate(usage.data.periodStart, locale),
              end: formatDate(usage.data.periodEnd, locale)
            })}
          </span>
        )}
      </div>
      {usage.isPending && <Skeleton className="h-14" />}
      {usage.isError &&
        (isAuthError(usage.error.message) ? (
          <p className="text-[12px] text-ink-faint">{t('settings:account.billing.unauthorized')}</p>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[12px] text-ink-muted">{usage.error.message}</p>
            <Button variant="ghost" size="sm" onClick={() => void usage.refetch()}>
              {t('common:retry')}
            </Button>
          </div>
        ))}
      {usage.data !== undefined && usage.data.rows.length === 0 && (
        <p className="text-[12px] text-ink-faint">{t('settings:account.billing.empty')}</p>
      )}
      {usage.data !== undefined && usage.data.rows.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {usage.data.rows.map((row, index) => (
            <div
              key={`${row.label}-${index}`}
              className="flex items-center justify-between gap-4 text-[12.5px]"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-ink">{row.label}</span>
                {row.detail !== undefined && row.detail !== '' && (
                  <span className="truncate text-[11.5px] text-ink-faint">{row.detail}</span>
                )}
              </div>
              {row.amountCents !== undefined && (
                <span className="nums shrink-0 text-ink-muted">
                  {formatAmount(row.amountCents)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AppearanceSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common', 'browse'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const setLocale = (value: string): void => {
    const locale = value as 'system' | Locale
    void updateSettings({ locale }).then(() => {
      changeLanguage(resolveLocale({ ...settings, locale }, appInfo))
    })
  }

  const stepUiScale = (delta: number): void => {
    const uiScale = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, settings.uiScale + delta))
    if (uiScale !== settings.uiScale) void updateSettings({ uiScale })
  }

  const stepFontScale = (delta: number): void => {
    const fontScale = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, settings.fontScale + delta))
    if (fontScale !== settings.fontScale) void updateSettings({ fontScale })
  }

  const homeOptions: DefaultHome[] = ['home', 'models', 'datasets', 'spaces', 'papers']
  const sortOptions: RepoSort[] = ['trending', 'downloads', 'likes', 'updated', 'created']

  return (
    <SectionShell title={t('settings:appearance.title')}>
      <Row label={t('settings:appearance.language')}>
        <Select value={settings.locale} onValueChange={setLocale}>
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t('common:language.system')}</SelectItem>
            {SUPPORTED_LOCALES.map((locale) => (
              <SelectItem key={locale} value={locale}>
                {t(`common:language.${locale}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('common:theme.label')}>
        <Select
          value={settings.theme}
          onValueChange={(theme) => void updateSettings({ theme: theme as typeof settings.theme })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t('common:theme.system')}</SelectItem>
            <SelectItem value="light">{t('common:theme.light')}</SelectItem>
            <SelectItem value="dark">{t('common:theme.dark')}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.uiScale')}>
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="w-7 px-0"
            aria-label={t('settings:appearance.uiScaleDecrease')}
            disabled={settings.uiScale <= UI_SCALE_MIN}
            onClick={() => stepUiScale(-UI_SCALE_STEP)}
          >
            <Minus className="size-3.5" aria-hidden />
          </Button>
          <span className="nums w-12 text-center text-[13px]">{settings.uiScale}%</span>
          <Button
            variant="secondary"
            size="sm"
            className="w-7 px-0"
            aria-label={t('settings:appearance.uiScaleIncrease')}
            disabled={settings.uiScale >= UI_SCALE_MAX}
            onClick={() => stepUiScale(UI_SCALE_STEP)}
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
        </div>
      </Row>
      <Row label={t('settings:appearance.fontScale')}>
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="w-7 px-0"
            aria-label={t('settings:appearance.fontScaleDecrease')}
            disabled={settings.fontScale <= FONT_SCALE_MIN}
            onClick={() => stepFontScale(-FONT_SCALE_STEP)}
          >
            <Minus className="size-3.5" aria-hidden />
          </Button>
          <span className="nums w-12 text-center text-[13px]">{settings.fontScale}%</span>
          <Button
            variant="secondary"
            size="sm"
            className="w-7 px-0"
            aria-label={t('settings:appearance.fontScaleIncrease')}
            disabled={settings.fontScale >= FONT_SCALE_MAX}
            onClick={() => stepFontScale(FONT_SCALE_STEP)}
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
        </div>
      </Row>
      <Row label={t('settings:appearance.density')}>
        <Select
          value={settings.uiDensity}
          onValueChange={(v) => void updateSettings({ uiDensity: v as UiDensity })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="comfortable">
              {t('settings:appearance.densityOptions.comfortable')}
            </SelectItem>
            <SelectItem value="compact">
              {t('settings:appearance.densityOptions.compact')}
            </SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.accent')}>
        <div
          className="flex items-center gap-1.5"
          role="radiogroup"
          aria-label={t('settings:appearance.accent')}
        >
          {ACCENT_OPTIONS.map((accent) => {
            const selected = settings.accent === accent
            const color = ACCENT_SWATCH[accent]
            return (
              <button
                key={accent}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(`settings:appearance.accentOptions.${accent}`)}
                title={t(`settings:appearance.accentOptions.${accent}`)}
                className={cn(
                  'size-6 rounded-full border-2 transition-[box-shadow,border-color]',
                  selected ? 'border-bg' : 'border-border hover:border-ink-muted'
                )}
                style={{
                  background: color,
                  boxShadow: selected ? `0 0 0 2px ${color}` : undefined
                }}
                onClick={() => void updateSettings({ accent })}
              />
            )
          })}
        </div>
      </Row>
      <Row label={t('settings:appearance.sidebarCollapsed')}>
        <RowSwitch
          checked={settings.sidebarCollapsed}
          onCheckedChange={(sidebarCollapsed) => void updateSettings({ sidebarCollapsed })}
        />
      </Row>
      <Row label={t('settings:appearance.defaultHome')}>
        <Select
          value={settings.defaultHome}
          onValueChange={(v) => void updateSettings({ defaultHome: v as DefaultHome })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {homeOptions.map((home) => (
              <SelectItem key={home} value={home}>
                {t(`settings:appearance.homeOptions.${home}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.defaultSort')}>
        <Select
          value={settings.defaultRepoSort}
          onValueChange={(v) => void updateSettings({ defaultRepoSort: v as RepoSort })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {sortOptions.map((sort) => (
              <SelectItem key={sort} value={sort}>
                {t(`browse:sort.${sort}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.browsePageSize')}>
        <Select
          value={String(settings.browsePageSize)}
          onValueChange={(v) =>
            void updateSettings({ browsePageSize: Number(v) as BrowsePageSize })
          }
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t('settings:appearance.browsePageSizeOption', { count: n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.repoOpenTarget')}>
        <Select
          value={settings.repoOpenTarget}
          onValueChange={(v) => void updateSettings({ repoOpenTarget: v as RepoOpenTarget })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="app">{t('settings:appearance.openTarget.app')}</SelectItem>
            <SelectItem value="browser">{t('settings:appearance.openTarget.browser')}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.historyLimit')}>
        <Select
          value={String(settings.historyLimit)}
          onValueChange={(v) => void updateSettings({ historyLimit: Number(v) as HistoryLimit })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {HISTORY_LIMIT_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t('settings:appearance.historyLimitOption', { count: n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </SectionShell>
  )
}

function DownloadsSection(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const setSettings = useAppStore((s) => s.setSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const push = useToasts((s) => s.push)

  const pickCacheDir = useMutation({
    mutationFn: () => invoke('settings:selectCacheDir', undefined),
    onSuccess: (next) => {
      if (next) setSettings(next)
    },
    onError: (error) => push(error.message, 'error')
  })
  const resetCacheDir = useMutation({
    mutationFn: () => invoke('settings:resetCacheDir', undefined),
    onSuccess: setSettings,
    onError: (error) => push(error.message, 'error')
  })

  return (
    <SectionShell title={t('settings:downloads.title')}>
      <Row label={t('settings:downloads.concurrency')}>
        <Select
          value={String(settings.downloadConcurrency)}
          onValueChange={(v) => void updateSettings({ downloadConcurrency: Number(v) })}
        >
          <RowSelectTrigger className="w-24">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {String(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:downloads.speedLimit')}>
        <Select
          value={settings.speedLimitBps === null ? 'unlimited' : String(settings.speedLimitBps)}
          onValueChange={(v) =>
            void updateSettings({ speedLimitBps: v === 'unlimited' ? null : Number(v) })
          }
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="unlimited">{t('settings:downloads.unlimited')}</SelectItem>
            {SPEED_OPTIONS.map((mb) => (
              <SelectItem key={mb} value={String(mb * 1024 * 1024)}>
                {t('settings:downloads.speedPerSecond', {
                  value: formatBytes(mb * 1024 * 1024)
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:downloads.cacheDir')}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="max-w-56 truncate font-mono text-[11.5px] text-ink-faint"
            title={settings.hfCacheDir ?? appInfo?.hfCacheDir}
          >
            {settings.hfCacheDir ?? t('settings:downloads.cacheDirDefault')}
          </span>
          <Button variant="secondary" size="sm" onClick={() => pickCacheDir.mutate()}>
            {t('settings:downloads.choose')}
          </Button>
          {settings.hfCacheDir && (
            <Button
              variant="ghost"
              size="sm"
              loading={resetCacheDir.isPending}
              onClick={() => resetCacheDir.mutate()}
            >
              {t('settings:downloads.reset')}
            </Button>
          )}
        </div>
      </Row>
    </SectionShell>
  )
}

function NotificationsSection(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <SectionShell title={t('settings:notifications.title')}>
      <Row label={t('settings:notifications.enabled')}>
        <RowSwitch
          checked={settings.notificationsEnabled}
          onCheckedChange={(notificationsEnabled) => void updateSettings({ notificationsEnabled })}
        />
      </Row>
      <Row label={t('settings:notifications.pollInterval')}>
        <Select
          value={String(settings.pollIntervalMinutes)}
          onValueChange={(v) => void updateSettings({ pollIntervalMinutes: Number(v) })}
        >
          <RowSelectTrigger className="w-32">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {[15, 30, 60, 180, 360].map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {t('settings:notifications.minutes', { count: minutes })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </SectionShell>
  )
}

function UpdatePanel(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const updateQuery = useQuery({
    queryKey: APP_UPDATE_QUERY_KEY,
    queryFn: () => invoke('updater:getState', undefined),
    staleTime: Infinity
  })
  const state = updateQuery.data

  const updateAction = useMutation({
    mutationFn: async (): Promise<AppUpdateState | undefined> => {
      if (state?.status === 'available') return invoke('updater:download', undefined)
      if (
        state?.status === 'ready' ||
        (state?.status === 'error' &&
          state.operation === 'install' &&
          state.availableVersion !== undefined)
      ) {
        await invoke('updater:install', undefined)
        return undefined
      }
      return invoke('updater:check', undefined)
    },
    onSuccess: (next) => {
      if (next) queryClient.setQueryData(APP_UPDATE_QUERY_KEY, next)
    },
    onError: () => push(t('settings:about.updates.errors.unknown'), 'error')
  })

  let statusText = t('settings:about.updates.checking')
  if (state) {
    switch (state.status) {
      case 'unsupported':
        statusText = t('settings:about.updates.unsupported')
        break
      case 'idle':
        statusText = t('settings:about.updates.description')
        break
      case 'checking':
        statusText = t('settings:about.updates.checking')
        break
      case 'up-to-date':
        statusText = t('settings:about.updates.upToDate')
        break
      case 'available':
        statusText = t('settings:about.updates.available', {
          version: state.availableVersion
        })
        break
      case 'manual':
        statusText = t('settings:about.updates.manual', {
          version: state.availableVersion
        })
        break
      case 'downloading':
        statusText = t('settings:about.updates.downloading', {
          version: state.availableVersion,
          percent: Math.round(state.percent)
        })
        break
      case 'ready':
        statusText = t('settings:about.updates.ready', { version: state.availableVersion })
        break
      case 'error':
        statusText = t(`settings:about.updates.errors.${state.error}`)
        break
    }
  }

  const busy =
    updateQuery.isPending ||
    updateAction.isPending ||
    state?.status === 'checking' ||
    state?.status === 'downloading'
  let actionLabel = t('settings:about.updates.check')
  if (state?.status === 'up-to-date') actionLabel = t('settings:about.updates.checkAgain')
  if (state?.status === 'available') actionLabel = t('settings:about.updates.download')
  if (state?.status === 'downloading') {
    actionLabel = t('settings:about.updates.downloadingButton', {
      percent: Math.round(state.percent)
    })
  }
  if (state?.status === 'ready') actionLabel = t('settings:about.updates.restartAndInstall')
  if (state?.status === 'error') {
    actionLabel = t(
      state.operation === 'install' && state.availableVersion !== undefined
        ? 'settings:about.updates.retryInstall'
        : 'settings:about.updates.retry'
    )
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-[13px] font-semibold text-ink-strong">
            {t('settings:about.updates.title')}
          </h3>
          <p
            className="max-w-[65ch] text-[12px] text-ink-muted"
            role={state?.status === 'downloading' ? undefined : 'status'}
            aria-live={state?.status === 'downloading' ? undefined : 'polite'}
          >
            {statusText}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {state?.status !== 'unsupported' && state?.status !== 'manual' && (
            <Button
              variant={state?.status === 'ready' ? 'cta' : 'secondary'}
              size="sm"
              loading={busy}
              onClick={() => updateAction.mutate()}
            >
              {!busy && <RefreshCw className="size-3.5" aria-hidden />}
              {actionLabel}
            </Button>
          )}
          {(state?.status === 'unsupported' ||
            state?.status === 'manual' ||
            state?.status === 'error') && (
            <Button variant="ghost" size="sm" onClick={() => openExternal(RELEASES_URL)}>
              <ExternalLink className="size-3.5" aria-hidden />
              {t('settings:about.updates.openReleases')}
            </Button>
          )}
        </div>
      </div>
      {state?.status === 'downloading' && (
        <div className="flex flex-col gap-1.5">
          <Progress
            value={state.percent / 100}
            aria-label={t('settings:about.updates.progressLabel')}
          />
          {state.total > 0 && (
            <span className="nums text-[11.5px] text-ink-faint">
              {t('settings:about.updates.downloadProgress', {
                transferred: formatBytes(state.transferred),
                total: formatBytes(state.total)
              })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function AboutSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const appInfo = useAppStore((s) => s.appInfo)

  return (
    <SectionShell title={t('settings:about.title')}>
      <div className="flex flex-col gap-2 text-[12.5px]">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-ink-strong">{t('common:appName')}</span>
          <Badge variant="warning">{t('settings:about.unofficialTitle')}</Badge>
          {appInfo && (
            <span className="nums text-ink-faint">
              {t('settings:about.version', { version: appInfo.version })}
            </span>
          )}
        </div>
        <p className="max-w-[65ch] text-ink-muted">{t('settings:about.disclaimer')}</p>
        <p className="max-w-[65ch] text-ink-muted">{t('settings:about.privacy')}</p>
        <div className="mt-1 flex items-center gap-3">
          <span className="text-ink-faint">{t('settings:about.license')}</span>
          <button
            type="button"
            className="flex items-center gap-1 text-link hover:underline"
            onClick={() => openExternal(REPO_URL)}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('settings:about.github')}
          </button>
        </div>
      </div>
      <UpdatePanel />
    </SectionShell>
  )
}

const SECTION_CONTENT: Record<SettingsSection, () => React.JSX.Element> = {
  account: AccountSection,
  profile: ProfileSection,
  appearance: AppearanceSection,
  downloads: DownloadsSection,
  notifications: NotificationsSection,
  network: NetworkSection,
  desktop: DesktopSection,
  privacy: PrivacySection,
  about: AboutSection
}

export function SettingsDialog(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const open = useAppStore((s) => s.settingsOpen)
  const section = useAppStore((s) => s.settingsSection)
  const openSettings = useAppStore((s) => s.openSettings)
  const closeSettings = useAppStore((s) => s.closeSettings)

  const Content = SECTION_CONTENT[section]

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openSettings() : closeSettings())}>
      <DialogContent
        aria-describedby={undefined}
        className="grid h-[34rem] max-h-[calc(100vh-6rem)] w-[56rem] max-w-[calc(100vw-4rem)] grid-cols-[13rem_1fr] overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{t('settings:title')}</DialogTitle>
        <nav className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r bg-panel p-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.labelKey} className="flex flex-col gap-0.5">
              <div className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">
                {t(group.labelKey)}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openSettings(item.id)}
                  className={cn(
                    'flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors duration-150',
                    section === item.id
                      ? 'bg-panel-2 text-ink-strong'
                      : 'text-ink-muted hover:bg-panel-2 hover:text-ink'
                  )}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-left">{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-h-0 overflow-y-auto p-6">
          <Content />
        </div>
      </DialogContent>
    </Dialog>
  )
}

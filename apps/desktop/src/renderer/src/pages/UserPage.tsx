import { Fragment, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  Boxes,
  Building2,
  CircleUserRound,
  Database,
  Eye,
  ExternalLink,
  Heart,
  LayoutGrid,
  SquarePen,
  UserX
} from 'lucide-react'
import type {
  Follow,
  FollowedAccount,
  OrgSummary,
  RepoKind,
  RepoSummary,
  UserOverview
} from '@oh-my-huggingface/shared'
import { hubSettingsUrl, hubUserUrl, normalizeHubEndpoint } from '@oh-my-huggingface/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { formatCount, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProfileAvatar } from '@/components/profile/ProfileAvatar'
import { PlanBadge, planBadgeKind } from '@/components/profile/PlanBadge'
import { useToasts } from '@/components/ui/toaster'
import { useHubSession } from '@/hooks/use-hub-session'
import { resolveLocale, useAppStore } from '@/stores/app'

const STALE_TIME = 5 * 60_000

const KIND_PATH: Record<RepoKind, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces'
}

const KIND_ICON: Record<RepoKind, React.ComponentType<{ className?: string }>> = {
  model: Boxes,
  dataset: Database,
  space: LayoutGrid
}

/** Locale-key suffix (profile:stats.*) per repo kind. */
const STATS_KEY: Record<RepoKind, 'models' | 'datasets' | 'spaces'> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces'
}

const TAB_ORDER: readonly RepoKind[] = ['model', 'dataset', 'space']

function kindCounts(overview: UserOverview): Record<RepoKind, number> {
  return { model: overview.numModels, dataset: overview.numDatasets, space: overview.numSpaces }
}

/** Default tab: the kind with the highest count; ties resolve to the first in TAB_ORDER. */
function bestKind(overview: UserOverview): RepoKind {
  const counts = kindCounts(overview)
  let best: RepoKind = 'model'
  for (const kind of TAB_ORDER) {
    if (counts[kind] > counts[best]) best = kind
  }
  return best
}

function AccountChip({
  account,
  onNavigate
}: {
  account: Pick<OrgSummary, 'name' | 'fullname' | 'avatarUrl'>
  onNavigate: (name: string) => void
}): React.JSX.Element {
  const label = account.fullname ?? account.name
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => onNavigate(account.name)}
          className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-full border border-border-card bg-bg px-1.5 py-0.5 text-left outline-none transition-colors duration-150 hover:border-border hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        >
          <ProfileAvatar
            name={account.name}
            url={account.avatarUrl}
            className="size-5 text-[10px]"
          />
          <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-muted">
            {account.name}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function UserRepoRow({ repo, locale }: { repo: RepoSummary; locale: string }): React.JSX.Element {
  const navigate = useNavigate()
  const Icon = KIND_ICON[repo.kind]
  return (
    <button
      type="button"
      onClick={() => navigate(`/${KIND_PATH[repo.kind]}/${repo.id}`)}
      className="group flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors duration-150 outline-none hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {repo.kind === 'space' && repo.emoji ? (
          <span className="w-4 shrink-0 text-center text-[12px] leading-none" aria-hidden>
            {repo.emoji}
          </span>
        ) : (
          <Icon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        )}
        <span className="truncate font-mono text-[13px] tracking-tight text-ink-strong transition-colors duration-150 group-hover:text-hover-title">
          {repo.id}
        </span>
      </span>
      <span className="nums flex items-center gap-2.5 pl-[22px] text-[11px] text-ink-faint">
        <span className="flex items-center gap-0.5">
          <Heart className="size-3" aria-hidden />
          {formatCount(repo.likes, locale)}
        </span>
        <span className="flex items-center gap-0.5">
          <ArrowDownToLine className="size-3" aria-hidden />
          {formatCount(repo.downloads, locale)}
        </span>
        {repo.updatedAt ? <span>{formatRelativeTime(repo.updatedAt, locale)}</span> : null}
      </span>
    </button>
  )
}

/** Author-scoped repo list for one tab. Mounted lazily by the Tabs primitive. */
function UserRepoList({
  kind,
  username,
  locale
}: {
  kind: RepoKind
  username: string
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation(['profile', 'common'])
  const endpointKey = normalizeHubEndpoint(useAppStore((s) => s.settings.hubEndpoint))
  const list = useQuery({
    queryKey: ['user-repos', username, kind, endpointKey],
    queryFn: () =>
      invoke('hub:search', { query: { kind, author: username, sort: 'downloads', limit: 30 } }),
    staleTime: STALE_TIME
  })

  if (list.isPending) {
    return (
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
      </div>
    )
  }
  if (list.isError) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <p className="max-w-sm text-[12.5px] text-ink-muted">{list.error.message}</p>
        <Button size="sm" onClick={() => void list.refetch()}>
          {t('common:retry')}
        </Button>
      </div>
    )
  }
  if (list.data.items.length === 0) {
    return <EmptyState icon={KIND_ICON[kind]} title={t(`profile:empty.${kind}`)} />
  }
  return (
    <div className="flex flex-col gap-0.5">
      {list.data.items.map((repo) => (
        <UserRepoRow key={repo.id} repo={repo} locale={locale} />
      ))}
    </div>
  )
}

export function UserProfile({ username }: { username: string }): React.JSX.Element {
  const { t } = useTranslation(['profile', 'common', 'auth'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const auth = useAppStore((s) => s.auth)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const openSettings = useAppStore((s) => s.openSettings)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)
  const hubSession = useHubSession()
  const [tabChoice, setTabChoice] = useState<RepoKind | null>(null)
  const signedIn = auth.status === 'signedIn'

  const overviewQueryKey = useMemo(
    () => ['user-overview', username, endpointKey] as const,
    [username, endpointKey]
  )
  const watchedQueryKey = useMemo(() => ['hub-watched', endpointKey] as const, [endpointKey])
  const overview = useQuery({
    queryKey: overviewQueryKey,
    queryFn: () => invoke('hub:userOverview', { username }),
    staleTime: STALE_TIME
  })

  const watched = useQuery({
    queryKey: watchedQueryKey,
    queryFn: () => invoke('hub:watchList', undefined),
    enabled: signedIn,
    staleTime: 60_000
  })

  // After toggling Watch on the website, refresh when the app regains focus.
  useEffect(() => {
    if (!signedIn) return
    const onFocus = (): void => {
      void queryClient.invalidateQueries({ queryKey: watchedQueryKey })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [signedIn, queryClient, watchedQueryKey])

  const data = overview.data
  const isOrg = data?.isOrg === true
  const selfName = auth.status === 'signedIn' ? auth.user.name : undefined
  // The signed-in user's own profile: no Follow/Watch, show the owner affordances.
  const isSelf =
    data !== undefined &&
    selfName !== undefined &&
    data.name.toLowerCase() === selfName.toLowerCase()
  // Hub social follow — same flag the website Follow button uses.
  const followingOnHub = data?.isFollowing === true
  const watchingOnHub =
    data !== undefined &&
    (watched.data ?? []).some(
      (w) =>
        w.name.toLowerCase() === username.toLowerCase() ||
        (data.internalId !== undefined &&
          data.internalId !== '' &&
          w.internalId === data.internalId)
    )

  const members = useQuery({
    queryKey: ['org-members', username, endpointKey],
    queryFn: () => invoke('hub:orgMembers', { org: username, limit: 24 }),
    enabled: isOrg,
    staleTime: STALE_TIME
  })

  const setFollow = useMutation({
    mutationFn: (next: boolean) => invoke('hub:followSet', { username, following: next, isOrg }),
    onMutate: async (next) => {
      const source = { auth: useAppStore.getState().auth, endpointKey, queryKey: overviewQueryKey }
      await queryClient.cancelQueries({ queryKey: overviewQueryKey })
      const current = useAppStore.getState()
      if (
        current.auth !== source.auth ||
        normalizeHubEndpoint(current.settings.hubEndpoint) !== source.endpointKey
      ) {
        return { ...source, prev: undefined }
      }
      const prev = queryClient.getQueryData<UserOverview>(overviewQueryKey)
      if (prev) {
        const delta = next ? 1 : -1
        queryClient.setQueryData<UserOverview>(overviewQueryKey, {
          ...prev,
          isFollowing: next,
          numFollowers: Math.max(0, prev.numFollowers + delta)
        })
      }
      return { ...source, prev }
    },
    onError: (err, _next, ctx) => {
      const current = useAppStore.getState()
      if (
        !ctx ||
        current.auth !== ctx.auth ||
        normalizeHubEndpoint(current.settings.hubEndpoint) !== ctx.endpointKey
      )
        return
      if (ctx.prev) queryClient.setQueryData(ctx.queryKey, ctx.prev)
      push(t('profile:followError', { error: err.message }), 'error')
    },
    onSuccess: async (_res, next) => {
      // Keep the local inbox poller in sync with the Hub social graph.
      if (next) {
        const list = await invoke('follows:add', {
          type: isOrg ? 'org' : 'user',
          target: username
        })
        queryClient.setQueryData(['follows'], list)
        return
      }
      let local = queryClient.getQueryData<Follow[]>(['follows'])
      if (local === undefined) {
        local = await invoke('follows:list', undefined)
        queryClient.setQueryData(['follows'], local)
      }
      const entry = local.find(
        (f) =>
          (f.type === 'user' || f.type === 'org') &&
          f.target.toLowerCase() === username.toLowerCase()
      )
      if (entry) {
        const list = await invoke('follows:remove', { id: entry.id })
        queryClient.setQueryData(['follows'], list)
      }
    }
  })

  const setWatch = useMutation({
    // Watches are keyed by account handle, not the internal id.
    mutationFn: (next: boolean) =>
      invoke('hub:watchSet', {
        id: username,
        type: isOrg ? 'org' : 'user',
        watching: next
      }),
    onMutate: () => ({ auth: useAppStore.getState().auth, endpointKey, queryKey: watchedQueryKey }),
    onSuccess: (result, next, source) => {
      const current = useAppStore.getState()
      if (
        !source ||
        current.auth !== source.auth ||
        normalizeHubEndpoint(current.settings.hubEndpoint) !== source.endpointKey
      )
        return
      queryClient.setQueryData(source.queryKey, result.watched)
      if (result.applied) {
        push(t(next ? 'profile:watchSuccess' : 'profile:unwatchSuccess'), 'success')
        return
      }
      if (hubSession) {
        // A connected web session that still didn't apply the change means the
        // cookie went stale — point at Settings to reconnect.
        push(t('profile:watchSessionExpired'), 'error', {
          action: {
            label: t('profile:watchReconnect'),
            onClick: () => openSettings('account')
          }
        })
        return
      }
      // No web session: watch mutations need one — open the website control.
      openExternal(hubUserUrl(username, settings.hubEndpoint))
      push(t(next ? 'profile:watchOpenHub' : 'profile:unwatchOpenHub'), 'info', {
        action: {
          label: t('profile:watchOnHub'),
          onClick: () => openExternal(hubUserUrl(username, settings.hubEndpoint))
        }
      })
    },
    onError: (err) => {
      push(t('profile:watchError', { error: err.message }), 'error')
    }
  })

  const activeTab = tabChoice ?? (data ? bestKind(data) : 'model')

  const stats: Array<{ key: string; value: number }> = data
    ? [
        { key: 'models', value: data.numModels },
        { key: 'datasets', value: data.numDatasets },
        { key: 'spaces', value: data.numSpaces },
        { key: 'followers', value: data.numFollowers },
        ...(isOrg
          ? [{ key: 'members', value: data.numUsers ?? 0 }]
          : [{ key: 'following', value: data.numFollowing }])
      ]
    : []

  const memberAccounts: FollowedAccount[] = members.data ?? []
  const badgeKind = data ? planBadgeKind({ isPro: data.isPro, plan: data.plan, isOrg }) : undefined

  return (
    <div className="h-full overflow-y-auto">
      <div className="animate-fade-rise mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-5">
        {overview.isPending && (
          <div className="flex items-start gap-4 rounded-lg border border-border-card bg-card-gradient p-5">
            <Skeleton className="size-16 rounded-full" />
            <div className="flex flex-1 flex-col gap-2 pt-1">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-64" />
              <Skeleton className="h-3 w-52" />
            </div>
          </div>
        )}

        {overview.isError && (
          <EmptyState
            icon={UserX}
            title={t('profile:error.title')}
            body={overview.error.message}
            action={
              <Button size="sm" onClick={() => void overview.refetch()}>
                {t('common:retry')}
              </Button>
            }
          />
        )}

        {data && (
          <>
            <header className="flex items-start gap-4 rounded-lg border border-border-card bg-card-gradient p-5">
              <ProfileAvatar
                name={data.name}
                url={data.avatarUrl}
                className="size-16 text-[20px]"
                isPro={data.isPro === true}
                frame="profile"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <h1 className="min-w-0 truncate text-lg font-semibold text-ink-strong">
                    {data.fullname !== undefined && data.fullname !== ''
                      ? data.fullname
                      : data.name}
                  </h1>
                  <span className="truncate font-mono text-[12.5px] text-ink-faint">
                    @{data.name}
                  </span>
                  {isSelf && (
                    <Badge variant="select" className="gap-1 font-medium">
                      <CircleUserRound className="size-3" aria-hidden />
                      {t('profile:selfBadge')}
                    </Badge>
                  )}
                  {isOrg && (
                    <Badge variant="outline" className="gap-1 font-medium">
                      <Building2 className="size-3" aria-hidden />
                      {t('profile:orgBadge')}
                    </Badge>
                  )}
                  {badgeKind && <PlanBadge kind={badgeKind} />}
                </div>
                {data.bio !== undefined && data.bio !== '' && (
                  <p className="max-w-prose text-[13px] leading-relaxed text-ink-muted">
                    {data.bio}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-faint">
                  {stats.map((stat, i) => (
                    <Fragment key={stat.key}>
                      {i > 0 && (
                        <span className="text-decor" aria-hidden>
                          ·
                        </span>
                      )}
                      <span className="flex items-baseline gap-1">
                        <span className="nums font-medium text-ink">
                          {formatCount(stat.value, locale)}
                        </span>
                        <span>{t(`profile:stats.${stat.key}`)}</span>
                      </span>
                    </Fragment>
                  ))}
                </div>
                {!isOrg && data.orgs.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <span className="text-[12px] font-medium text-ink-faint">
                      {t('profile:orgsLabel')}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {data.orgs.map((org) => (
                        <AccountChip
                          key={org.name}
                          account={org}
                          onNavigate={(name) => navigate(`/users/${name}`)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {isOrg && memberAccounts.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <span className="text-[12px] font-medium text-ink-faint">
                      {t('profile:members')}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {memberAccounts.map((member) => (
                        <AccountChip
                          key={member.name}
                          account={member}
                          onNavigate={(name) => navigate(`/users/${name}`)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('common:openOnHub')}
                      onClick={() => openExternal(hubUserUrl(data.name, settings.hubEndpoint))}
                    >
                      <ExternalLink className="size-4" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('common:openOnHub')}</TooltipContent>
                </Tooltip>
                {isSelf && (
                  <Button
                    variant="outline"
                    size="md"
                    className="gap-1.5"
                    onClick={() => openExternal(hubSettingsUrl('profile', settings.hubEndpoint))}
                  >
                    <SquarePen className="size-3.5" aria-hidden />
                    {t('profile:editProfile')}
                  </Button>
                )}
                {signedIn && !isSelf && (
                  <>
                    <Button
                      variant={watchingOnHub ? 'secondary' : 'outline'}
                      size="md"
                      className="gap-1.5"
                      loading={setWatch.isPending}
                      disabled={watched.isPending || data.internalId === undefined}
                      aria-pressed={watchingOnHub}
                      onClick={() => setWatch.mutate(!watchingOnHub)}
                    >
                      <Eye className="size-3.5" aria-hidden />
                      {watchingOnHub ? t('profile:unwatch') : t('profile:watch')}
                    </Button>
                    <Button
                      variant={followingOnHub ? 'secondary' : 'cta'}
                      size="md"
                      loading={setFollow.isPending}
                      aria-pressed={followingOnHub}
                      onClick={() => setFollow.mutate(!followingOnHub)}
                    >
                      {followingOnHub ? t('profile:unfollow') : t('profile:follow')}
                    </Button>
                  </>
                )}
              </div>
            </header>

            <Tabs
              value={activeTab}
              onValueChange={(value) => setTabChoice(value as RepoKind)}
              className="flex flex-col"
            >
              <TabsList>
                {TAB_ORDER.map((kind) => (
                  <TabsTrigger key={kind} value={kind}>
                    <span className="inline-flex items-center gap-1.5">
                      {t(`profile:stats.${STATS_KEY[kind]}`)}
                      <span className="nums text-[11px] text-ink-faint">
                        {formatCount(kindCounts(data)[kind], locale)}
                      </span>
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
              {TAB_ORDER.map((kind) => (
                <TabsContent key={kind} value={kind} className="pt-2">
                  <UserRepoList kind={kind} username={username} locale={locale} />
                </TabsContent>
              ))}
            </Tabs>
          </>
        )}
      </div>
    </div>
  )
}

/** Public profile page (/users/:username). Keyed so per-user state resets on navigation. */
export function UserPage(): React.JSX.Element {
  const params = useParams()
  const username = params.username ?? ''
  return <UserProfile key={username} username={username} />
}

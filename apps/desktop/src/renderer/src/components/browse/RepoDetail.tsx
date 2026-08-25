import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  Columns3,
  ExternalLink,
  Heart,
  LockKeyhole,
  Pin,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Star
} from 'lucide-react'
import {
  classifyRevision,
  hubRepoUrl,
  normalizeHubEndpoint,
  normalizeResolvedCommit,
  type RepoKind,
  type RepoSummary,
  type SecurityPreflightRequest
} from '@oh-my-huggingface/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { cn, formatBytes, formatCount } from '@/lib/utils'
import { useSettledValue } from '@/hooks/use-settled-value'
import { useCommandActions } from '@/hooks/use-command-actions'
import {
  downloadBlockedByCapacity,
  estimatedWriteBytes,
  isDiskCapacityError,
  useDownloadCapacity
} from '@/hooks/use-download-capacity'
import { taskHue, taskIcon } from '@/lib/tag-colors'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tag } from '@/components/ui/tag'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { pushUndo, useToasts } from '@/components/ui/toaster'
import { RepoManagePanel } from '@/components/admin/RepoManagePanel'
import { SpaceOpsPanel } from '@/components/admin/SpaceOpsPanel'
import { DatasetPreview } from '@/components/browse/DatasetPreview'
import { DiscussionsPanel } from '@/components/browse/DiscussionsPanel'
import { DownloadIntentPanel } from '@/components/browse/DownloadIntentPanel'
import { GatedAccessBar } from '@/components/browse/GatedAccessBar'
import { FileTreeView } from '@/components/browse/FileTreeView'
import { EvalResultsPanel } from '@/components/browse/EvalResultsPanel'
import { InfoPanel } from '@/components/browse/InfoPanel'
import { MarkdownView } from '@/components/browse/MarkdownView'
import { PlaygroundPanel } from '@/components/browse/PlaygroundPanel'
import { LocalPlaygroundPanel } from '@/components/browse/LocalPlaygroundPanel'
import { RevisionSelector } from '@/components/browse/RevisionSelector'
import { SecurityReportPanel } from '@/components/browse/SecurityReportPanel'
import { RepoRevisionProvider } from '@/components/browse/revision-context'
import { EditFileButton, RepoFileEditor } from '@/components/browse/RepoFileEditor'
import { SpaceRunner } from '@/components/browse/SpaceRunner'
import { AddToCollectionMenu } from '@/components/collections/AddToCollectionMenu'
import { LikeButton } from '@/components/community/LikeButton'
import { UserLink } from '@/components/profile/UserLink'
import { resolveLocale, useAppStore } from '@/stores/app'
import { useSecurityGate } from '@/hooks/use-security-gate'

function missingRepoBytes(
  siblings: Array<{ rfilename: string; size?: number }> | undefined,
  cachedSizes: ReadonlyMap<string, number>
): number | undefined {
  if (!siblings || siblings.length === 0) return undefined
  let total = 0
  for (const file of siblings) {
    if (file.size === undefined) return undefined
    if (cachedSizes.get(file.rfilename) !== file.size) total += file.size
  }
  return total
}

/** Pipeline tags whose models the Hub can serve through chat completion. */
const CHAT_PIPELINE_TAGS = new Set(['text-generation', 'image-text-to-text'])

/**
 * Whether the playground's chat completion can work for this model. Providers
 * expose chat only for conversational text-generation / image-text-to-text
 * models (the Hub tags those "conversational"); every other task fails at the
 * provider. Without task metadata this stays permissive so the provider-based
 * availability check alone decides.
 */
export function exactRevisionSelection(revision: string | null) {
  if (!revision) return undefined
  const commit = normalizeResolvedCommit(revision)
  return commit ? classifyRevision(commit, commit) : undefined
}

export function chatCompletionCapable(detail?: { pipelineTag?: string; tags: string[] }): boolean {
  if (detail?.pipelineTag === undefined) return true
  return CHAT_PIPELINE_TAGS.has(detail.pipelineTag) && detail.tags.includes('conversational')
}

export function RepoDetail({
  kind,
  repoId
}: {
  kind: RepoKind
  repoId: string
}): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common', 'downloads'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const auth = useAppStore((s) => s.auth)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const securityGate = useSecurityGate()

  // Burst control for j/k navigation: the header renders from the immediate
  // repoId; a deliberate click fetches instantly while rapid bursts collapse
  // into a single fetch once the selection rests.
  const settledRepoId = useSettledValue(repoId, 200)
  const queriesEnabled = settledRepoId === repoId

  const refs = useQuery({
    queryKey: ['repo-refs', endpointKey, kind, settledRepoId],
    queryFn: () => invoke('hub:repoRefs', { kind, repoId: settledRepoId }),
    enabled: queriesEnabled,
    retry: false
  })
  const revisionParam = searchParams.get('revision')
  const exactSelection = useMemo(() => exactRevisionSelection(revisionParam), [revisionParam])
  const exactCommit = exactSelection?.resolvedCommit ?? null
  const requestedRevision = exactCommit ?? revisionParam ?? refs.data?.defaultBranch ?? ''
  const commits = useQuery({
    queryKey: ['repo-commits', endpointKey, kind, settledRepoId],
    queryFn: () => invoke('hub:repoCommits', { kind, repoId: settledRepoId, limit: 20 }),
    enabled: queriesEnabled,
    retry: false
  })
  const revisionSelection = useQuery({
    queryKey: ['repo-revision', endpointKey, kind, settledRepoId, requestedRevision],
    queryFn: () =>
      invoke('hub:resolveRevision', {
        kind,
        repoId: settledRepoId,
        revision: requestedRevision
      }),
    enabled:
      !exactSelection &&
      queriesEnabled &&
      requestedRevision.length > 0 &&
      (revisionParam !== null || !refs.isPending),
    initialData: exactSelection,
    staleTime: exactSelection ? Infinity : undefined,
    retry: false
  })
  const resolvedCommit = revisionSelection.data?.resolvedCommit

  useEffect(() => {
    if (revisionParam !== null || !refs.data?.defaultBranch) return
    const next = new URLSearchParams(searchParams)
    next.set('revision', refs.data.defaultBranch)
    setSearchParams(next, { replace: true })
  }, [refs.data?.defaultBranch, revisionParam, searchParams, setSearchParams])

  const detail = useQuery({
    queryKey: ['repo', endpointKey, kind, settledRepoId, requestedRevision, resolvedCommit],
    queryFn: () =>
      invoke('hub:repoDetail', {
        kind,
        repoId: settledRepoId,
        revision: resolvedCommit
      }),
    enabled: queriesEnabled && Boolean(resolvedCommit)
  })
  const readme = useQuery({
    queryKey: ['readme', endpointKey, kind, settledRepoId, requestedRevision, resolvedCommit],
    queryFn: async () => {
      try {
        const markdown = await invoke('hub:readme', {
          kind,
          repoId: settledRepoId,
          revision: resolvedCommit!
        })
        return { markdown, source: 'hub' as const }
      } catch (err) {
        try {
          const cached = await invoke('cache:readText', {
            kind,
            repoId: settledRepoId,
            path: 'README.md',
            commit: resolvedCommit!
          })
          if (cached) return { markdown: cached.content, source: 'cache' as const }
        } catch {
          /* keep the Hub error */
        }
        throw err
      }
    },
    enabled: queriesEnabled && Boolean(resolvedCommit)
  })
  const securityOverview = useQuery({
    queryKey: [
      'security-report',
      endpointKey,
      kind,
      settledRepoId,
      requestedRevision,
      resolvedCommit
    ],
    queryFn: () =>
      invoke('security:preflight', {
        request: {
          action: 'download',
          kind,
          repoId: settledRepoId,
          revision: requestedRevision,
          resolvedCommit: resolvedCommit!,
          files: undefined
        }
      }),
    enabled: queriesEnabled && Boolean(resolvedCommit),
    retry: false
  })
  const [editingCard, setEditingCard] = useState(false)
  const [branchDraft, setBranchDraft] = useState('')
  const favorites = useQuery({
    queryKey: ['favorites'],
    queryFn: () => invoke('favorites:list', undefined)
  })
  // The playground tab only exists when some inference provider actually serves the model.
  const inferenceAvailable = useQuery({
    queryKey: ['inference-available', settledRepoId, endpointKey],
    queryFn: () => invoke('hub:inferenceAvailable', { repoId: settledRepoId }),
    enabled: kind === 'model' && queriesEnabled,
    staleTime: 10 * 60_000
  })

  // Never show (or act on) data that belongs to a lagging settled id.
  const detailData = settledRepoId === repoId ? detail.data : undefined
  const detailError = settledRepoId === repoId && detail.isError
  const readmeData = settledRepoId === repoId ? readme.data : undefined
  const readmeError = settledRepoId === repoId && readme.isError
  const readmeMarkdown = readmeData?.markdown
  const capacity = useDownloadCapacity()
  const cachedSnapshot = useQuery({
    queryKey: ['cache-snapshot', kind, repoId, resolvedCommit],
    queryFn: () =>
      invoke('cache:snapshot', {
        kind,
        repoId,
        commit: resolvedCommit!
      }),
    enabled: Boolean(resolvedCommit),
    staleTime: 30_000
  })
  const cachedSizes = useMemo(
    () => new Map((cachedSnapshot.data?.files ?? []).map((file) => [file.path, file.size])),
    [cachedSnapshot.data?.files]
  )
  const wholeRepoSourceBytes = missingRepoBytes(detailData?.siblings, cachedSizes)
  const wholeRepoRequiredBytes = estimatedWriteBytes(wholeRepoSourceBytes, capacity.data)
  const wholeRepoBlocked = downloadBlockedByCapacity(wholeRepoRequiredBytes, capacity.data)

  // Record browse history once the summary is known.
  useEffect(() => {
    if (detailData && resolvedCommit) {
      const summary: RepoSummary = { ...detailData }
      void invoke('history:record', {
        summary,
        revision: requestedRevision,
        resolvedCommit
      })
        .then(() => queryClient.invalidateQueries({ queryKey: ['history'] }))
        .catch(() => {
          // History is a local convenience; a write failure must not block the
          // repository detail the user already opened successfully.
        })
    }
  }, [detailData, queryClient, requestedRevision, resolvedCommit])

  const isFavorite = favorites.data?.some((f) => f.repoId === repoId && f.kind === kind) ?? false

  const toggleFavorite = useMutation({
    mutationFn: async () => {
      if (isFavorite) {
        const removed = favorites.data?.find((f) => f.repoId === repoId && f.kind === kind)
        const list = await invoke('favorites:remove', { kind, repoId })
        return { list, removed: removed?.summary }
      }
      if (!detailData) throw new Error('not loaded')
      const list = await invoke('favorites:add', { summary: { ...detailData } })
      return { list, removed: undefined }
    },
    onSuccess: ({ list, removed }) => {
      queryClient.setQueryData(['favorites'], list)
      if (removed) {
        pushUndo(t('detail:favoriteRemoved'), {
          label: t('common:undo'),
          onClick: () => {
            void invoke('favorites:add', { summary: removed }).then((restored) =>
              queryClient.setQueryData(['favorites'], restored)
            )
          }
        })
      }
    }
  })

  const authorizeAction = async (
    action: SecurityPreflightRequest['action'],
    files?: string[]
  ): Promise<string | undefined> => {
    if (!resolvedCommit) throw new Error('Revision has not resolved to a commit')
    return securityGate.authorize({
      action,
      kind,
      repoId,
      revision: requestedRevision,
      resolvedCommit,
      files
    })
  }

  const download = useMutation({
    mutationFn: async () => {
      const securityGrantId = await authorizeAction('download')
      return invoke('downloads:start', {
        request: {
          repoId,
          kind,
          revision: requestedRevision,
          resolvedCommit,
          securityGrantId
        }
      })
    },
    onSuccess: () => push(t('detail:downloadStarted'), 'success'),
    onError: (error) =>
      push(
        isDiskCapacityError(error)
          ? t('downloads:capacity.insufficient')
          : t('detail:downloadFailed', { error: error.message }),
        'error'
      )
  })
  const pins = useQuery({
    queryKey: ['cache-pins', appInfo?.hfCacheDir ?? 'unknown', kind, repoId],
    queryFn: () => invoke('cache:listPins', { kind, repoId })
  })
  const isPinned =
    Boolean(resolvedCommit) && pins.data?.some((pin) => pin.commit === resolvedCommit) === true
  const togglePin = useMutation({
    mutationFn: async () => {
      if (!resolvedCommit) throw new Error('Revision has not resolved')
      return isPinned
        ? invoke('cache:unpin', { kind, repoId, commit: resolvedCommit })
        : invoke('cache:pin', {
            kind,
            repoId,
            commit: resolvedCommit,
            label: requestedRevision
          })
    },
    onSuccess: (value) =>
      queryClient.setQueryData(
        ['cache-pins', appInfo?.hfCacheDir ?? 'unknown', kind, repoId],
        value
      ),
    onError: (error) => push(error.message, 'error')
  })
  const exportLock = useMutation({
    mutationFn: async () => {
      if (!resolvedCommit) throw new Error('Revision has not resolved')
      const security = securityOverview.data
        ? {
            decision: securityOverview.data.decision,
            reasons: securityOverview.data.reasons,
            fingerprint: securityOverview.data.report.fingerprint,
            checkedAt: securityOverview.data.report.checkedAt
          }
        : undefined
      return invoke('lockfile:export', {
        lock: {
          format: 'ohmyhf-lock/v1',
          version: 1,
          createdAt: new Date().toISOString(),
          hubEndpoint: endpointKey,
          resources: [
            {
              kind,
              repoId,
              requestedRevision,
              resolvedCommit,
              security
            }
          ]
        }
      })
    },
    onSuccess: (result) => {
      if (!result.canceled) push(`Lockfile saved: ${result.path}`, 'success')
    },
    onError: (error) => push(error.message, 'error')
  })
  const createBranch = useMutation({
    mutationFn: async () => {
      if (!resolvedCommit || !branchDraft.trim()) throw new Error('Enter a new branch name')
      await invoke('hub:branchCreate', {
        kind,
        repoId,
        branch: branchDraft.trim(),
        startingPoint: resolvedCommit
      })
      return branchDraft.trim()
    },
    onSuccess: (branch) => {
      setBranchDraft('')
      void refs.refetch()
      changeRevision(branch)
    },
    onError: (error) => push(error.message, 'error')
  })
  const repoCommands = useMemo(
    () => [
      {
        id: `download-repo:${kind}:${repoId}`,
        label: t('downloads:commands.downloadCurrentRepository', { repo: repoId }),
        icon: ArrowDownToLine,
        disabled:
          download.isPending ||
          (wholeRepoRequiredBytes !== undefined &&
            capacity.data?.availableBytes !== undefined &&
            wholeRepoRequiredBytes > capacity.data.availableBytes),
        run: async () => {
          await download.mutateAsync()
        }
      }
    ],
    [capacity.data?.availableBytes, download, kind, repoId, t, wholeRepoRequiredBytes]
  )
  useCommandActions('repo-detail', repoCommands)

  const hubUrl = hubRepoUrl(kind, repoId, settings.hubEndpoint)
  const revisionHubUrl = revisionSelection.data
    ? revisionSelection.data.type === 'commit'
      ? `${hubUrl}/commit/${revisionSelection.data.resolvedCommit}`
      : `${hubUrl}/tree/${encodeURIComponent(revisionSelection.data.requested)}`
    : hubUrl
  const isModel = kind === 'model'
  // Provider-served AND chat-capable: the playground only speaks chat
  // completion, so non-conversational tasks (embeddings, text-to-image, …)
  // hide the tab instead of failing on every run.
  const showPlayground =
    isModel && inferenceAvailable.data === true && chatCompletionCapable(detailData)

  // Owner segment of "owner/name" links to the public profile; the rest stays plain.
  const slash = repoId.indexOf('/')
  const owner = slash > 0 ? repoId.slice(0, slash) : null

  // The Manage tab appears only for repos the signed-in user can administer
  // (their own namespace or one of their orgs).
  const isOwner =
    auth.status === 'signedIn' &&
    owner !== null &&
    (owner === auth.user.name || auth.user.orgs.some((o) => o.name === owner))

  // Controlled tabs: the component persists across repo selection (parent keys
  // by kind only), so the active tab resets per repo and clamps to 'card' when
  // its value is no longer rendered (e.g. 'manage' on a repo you don't own).
  const tabKey = `${kind}:${repoId}:${resolvedCommit ?? requestedRevision}`
  const [tabState, setTabState] = useState({ key: tabKey, value: 'card' })
  if (tabState.key !== tabKey) {
    setTabState({ key: tabKey, value: 'card' })
    if (editingCard) setEditingCard(false)
  }
  // The discussion/PR currently open inside the Discussions tab, mirrored up
  // by the panel (cleared when it unmounts on tab switch or repo change).
  const [activeDiscussion, setActiveDiscussion] = useState<number | null>(null)
  const tabRendered: Record<string, boolean> = {
    run: kind === 'space',
    preview: kind === 'dataset',
    playground: showPlayground,
    local: kind === 'model',
    evals: kind === 'model',
    manage: isOwner
  }
  const tab = (tabRendered[tabState.value] ?? true) ? tabState.value : 'card'

  // With a specific discussion/PR open, the open-on-Hub button deep-links to it.
  const openOnHubUrl =
    tab === 'discussions' && activeDiscussion !== null
      ? `${hubUrl}/discussions/${activeDiscussion}`
      : revisionHubUrl

  const changeRevision = (revision: string): void => {
    void queryClient
      .cancelQueries({
        predicate: (query) => query.queryKey.includes(kind) && query.queryKey.includes(repoId)
      })
      .finally(() => {
        const next = new URLSearchParams(searchParams)
        next.set('revision', revision)
        setSearchParams(next)
      })
  }

  if (revisionParam === null && !refs.isPending && !refs.data?.defaultBranch) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b p-3">
          <RevisionSelector
            refs={refs.data}
            commits={commits.data?.items}
            requested=""
            error
            onChange={changeRevision}
          />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <LockKeyhole className="size-8 text-danger" aria-hidden />
          <p role="alert" className="max-w-lg text-[12.5px] text-ink-muted">
            {t('common:repro.repo.referenceUnavailable')}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void refs.refetch()}>
            {t('common:retry')}
          </Button>
        </div>
      </div>
    )
  }

  if (revisionSelection.isPending || !revisionSelection.data) {
    if (revisionSelection.isError) {
      return (
        <div className="flex h-full flex-col">
          <div className="border-b p-3">
            <RevisionSelector
              refs={refs.data}
              commits={commits.data?.items}
              requested={requestedRevision}
              error
              onChange={changeRevision}
            />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <LockKeyhole className="size-8 text-danger" aria-hidden />
            <p className="font-mono text-[13px] text-ink-strong">{requestedRevision}</p>
            <p role="alert" className="max-w-lg text-[12.5px] text-ink-muted">
              {t('common:repro.repo.referenceUnavailable')}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void revisionSelection.refetch()}>
              {t('common:retry')}
            </Button>
          </div>
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col gap-3 p-4">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-12" />
        <Skeleton className="min-h-0 flex-1" />
      </div>
    )
  }

  return (
    <RepoRevisionProvider value={revisionSelection.data}>
      <div className="flex h-full min-w-0 flex-col">
        {securityGate.dialog}
        <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h1
              className="truncate font-mono text-smd font-semibold text-ink-strong"
              title={repoId}
            >
              {owner !== null ? (
                <>
                  <UserLink username={owner} className="hover:text-hover-title">
                    {owner}
                  </UserLink>
                  {repoId.slice(slash)}
                </>
              ) : (
                repoId
              )}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-faint">
              <RevisionSelector
                refs={refs.data}
                commits={commits.data?.items}
                selection={revisionSelection.data}
                requested={requestedRevision}
                loading={revisionSelection.isFetching}
                onChange={changeRevision}
              />
              {revisionSelection.data.readOnly && isOwner && (
                <div className="flex items-center gap-1">
                  <Input
                    className="h-7 w-36 font-mono text-[11px]"
                    value={branchDraft}
                    placeholder={`from-${revisionSelection.data.resolvedCommit.slice(0, 8)}`}
                    aria-label={t('common:repro.repo.newBranchName')}
                    onChange={(event) => setBranchDraft(event.target.value)}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={createBranch.isPending}
                    disabled={!branchDraft.trim()}
                    onClick={() => createBranch.mutate()}
                  >
                    {t('common:repro.repo.createBranch')}
                  </Button>
                </div>
              )}
              {detailData?.pipelineTag && (
                <Tag hue={taskHue(detailData.pipelineTag)} icon={taskIcon(detailData.pipelineTag)}>
                  {detailData.pipelineTag}
                </Tag>
              )}
              {detailData?.gated ? <Badge variant="warning">{t('common:gated')}</Badge> : null}
              {detailData?.private && <Badge variant="warning">{t('common:private')}</Badge>}
              {securityOverview.data && (
                <Badge
                  variant={
                    securityOverview.data.decision === 'allow'
                      ? 'success'
                      : securityOverview.data.decision === 'block'
                        ? 'error'
                        : 'warning'
                  }
                  title={securityOverview.data.reasons.join(', ')}
                >
                  {securityOverview.data.decision === 'allow' ? (
                    <ShieldCheck className="size-3" aria-hidden />
                  ) : securityOverview.data.decision === 'block' ? (
                    <ShieldAlert className="size-3" aria-hidden />
                  ) : (
                    <ShieldQuestion className="size-3" aria-hidden />
                  )}
                  {t(`common:repro.security.decision.${securityOverview.data.decision}`)}
                </Badge>
              )}
              {/* Signed in, the interactive LikeButton in the actions row shows the count. */}
              {auth.status !== 'signedIn' && (
                <span className="flex items-center gap-1">
                  <Heart className="size-3" aria-hidden />
                  {detailData ? formatCount(detailData.likes, locale) : '–'}
                </span>
              )}
              {auth.status !== 'signedIn' && kind !== 'space' && (
                <span className="text-decor" aria-hidden>
                  ·
                </span>
              )}
              {kind !== 'space' && (
                <span className="flex items-center gap-1">
                  <ArrowDownToLine className="size-3" aria-hidden />
                  {detailData ? formatCount(detailData.downloads, locale) : '–'}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {kind === 'model' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('common:repro.repo.addCompare')}
                    onClick={() => void navigate(`/compare?models=${encodeURIComponent(repoId)}`)}
                  >
                    <Columns3 className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('common:repro.repo.addCompare')}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    isPinned ? t('common:repro.repo.unpinExact') : t('common:repro.repo.pinExact')
                  }
                  aria-pressed={isPinned}
                  loading={togglePin.isPending}
                  onClick={() => togglePin.mutate()}
                >
                  <Pin
                    className={cn('size-4', isPinned && 'fill-select text-select')}
                    aria-hidden
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isPinned
                  ? t('common:repro.repo.unpinExact')
                  : t('common:repro.repo.pinDownloadedExact')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('common:repro.repo.exportLockAria')}
                  loading={exportLock.isPending}
                  onClick={() => exportLock.mutate()}
                >
                  <LockKeyhole className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('common:repro.repo.exportExactLock')}</TooltipContent>
            </Tooltip>
            <LikeButton kind={kind} repoId={repoId} likes={detailData?.likes ?? 0} />
            <AddToCollectionMenu kind={kind} repoId={repoId} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    isFavorite ? t('detail:actions.unfavorite') : t('detail:actions.favorite')
                  }
                  aria-pressed={isFavorite}
                  onClick={() => toggleFavorite.mutate()}
                >
                  <Star
                    className={cn('size-4', isFavorite && 'fill-warning text-warning')}
                    aria-hidden
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isFavorite ? t('detail:actions.unfavorite') : t('detail:actions.favoriteHint')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('common:openOnHub')}
                  onClick={() => openExternal(openOnHubUrl)}
                >
                  <ExternalLink className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('common:openOnHub')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="cta"
                    size="md"
                    loading={download.isPending}
                    disabled={wholeRepoBlocked}
                    onClick={() => download.mutate()}
                  >
                    <ArrowDownToLine className="size-3.5" aria-hidden />
                    {t('detail:actions.download')}
                    {wholeRepoRequiredBytes !== undefined && (
                      <span className="nums text-[11px] opacity-75">
                        {formatBytes(wholeRepoRequiredBytes)}
                      </span>
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {wholeRepoBlocked
                  ? t('downloads:capacity.insufficient')
                  : capacity.data?.availableBytes === undefined
                    ? t('downloads:capacity.availableUnknown')
                    : t('downloads:capacity.available', {
                        size: formatBytes(capacity.data.availableBytes)
                      })}
              </TooltipContent>
            </Tooltip>
          </div>
        </header>

        {detailData?.gated !== undefined && detailData.gated !== false && (
          <GatedAccessBar kind={kind} repoId={repoId} />
        )}

        <Tabs
          value={tab}
          onValueChange={(value) => setTabState({ key: tabKey, value })}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="px-3">
            <TabsTrigger value="card">{t('detail:tabs.card')}</TabsTrigger>
            {kind === 'space' && <TabsTrigger value="run">{t('detail:tabs.run')}</TabsTrigger>}
            {kind === 'dataset' && (
              <TabsTrigger value="preview">{t('detail:tabs.preview')}</TabsTrigger>
            )}
            <TabsTrigger value="files">{t('detail:tabs.files')}</TabsTrigger>
            <TabsTrigger value="info">{t('detail:tabs.info')}</TabsTrigger>
            <TabsTrigger value="discussions">{t('detail:tabs.discussions')}</TabsTrigger>
            {showPlayground && (
              <TabsTrigger value="playground">{t('detail:tabs.playground')}</TabsTrigger>
            )}
            {kind === 'model' && (
              <TabsTrigger value="local">{t('common:repro.repo.localTab')}</TabsTrigger>
            )}
            {kind === 'model' && (
              <TabsTrigger value="evals">{t('common:repro.repo.evalTab')}</TabsTrigger>
            )}
            {isOwner && <TabsTrigger value="manage">{t('detail:tabs.manage')}</TabsTrigger>}
          </TabsList>
          <TabsContent value="card" className="min-h-0 flex-1 overflow-y-auto p-4">
            {kind === 'model' && (
              <DownloadIntentPanel
                key={revisionSelection.data.resolvedCommit}
                kind={kind}
                repoId={repoId}
                detail={detailData}
                revision={revisionSelection.data}
              />
            )}
            {readmeData?.source === 'cache' && (
              <p className="mb-3 text-[12px] text-ink-faint">{t('detail:card.offline')}</p>
            )}
            {editingCard && readmeMarkdown !== undefined ? (
              <RepoFileEditor
                kind={kind}
                repoId={repoId}
                path="README.md"
                initial={readmeMarkdown}
                revision={revisionSelection.data}
                onClose={() => setEditingCard(false)}
                onSaved={() => {
                  setEditingCard(false)
                  void readme.refetch()
                }}
              />
            ) : readmeError ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-[13px] text-ink-muted">{t('common:error.generic')}</p>
                <Button variant="secondary" size="sm" onClick={() => void readme.refetch()}>
                  {t('common:retry')}
                </Button>
              </div>
            ) : readmeMarkdown !== undefined ? (
              <>
                <div className="mb-3 flex justify-end">
                  {revisionSelection.data.readOnly ? (
                    <span className="text-[11.5px] text-ink-faint">
                      {t('common:repro.repo.readOnlyRevision')}
                    </span>
                  ) : (
                    <EditFileButton onClick={() => setEditingCard(true)} />
                  )}
                </div>
                {readmeMarkdown.trim() === '' ? (
                  <p className="text-[13px] text-ink-muted">{t('detail:card.empty')}</p>
                ) : (
                  <MarkdownView
                    markdown={readmeMarkdown}
                    kind={kind}
                    repoId={repoId}
                    revision={revisionSelection.data.resolvedCommit}
                  />
                )}
              </>
            ) : (
              <div className="flex max-w-[72ch] flex-col gap-3">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-32 w-full" />
              </div>
            )}
          </TabsContent>
          {kind === 'space' && (
            <TabsContent value="run" className="min-h-0 flex-1">
              <SpaceRunner
                repoId={repoId}
                detail={detailData}
                selectedRevision={revisionSelection.data}
                defaultRevision={refs.data?.defaultBranch}
                onSelectRevision={changeRevision}
              />
            </TabsContent>
          )}
          {kind === 'dataset' && (
            <TabsContent value="preview" className="min-h-0 flex-1">
              <DatasetPreview
                repoId={repoId}
                revision={revisionSelection.data}
                defaultRevision={refs.data?.defaultBranch}
                onSelectRevision={changeRevision}
              />
            </TabsContent>
          )}
          <TabsContent value="files" className="min-h-0 flex-1">
            <FileTreeView
              key={revisionSelection.data.resolvedCommit}
              kind={kind}
              repoId={repoId}
              revision={revisionSelection.data}
            />
          </TabsContent>
          <TabsContent value="info" className="min-h-0 flex-1 overflow-y-auto">
            {detailError ? (
              <div className="flex flex-col items-start gap-2 p-4">
                <p className="text-[13px] text-ink-muted">{t('common:error.generic')}</p>
                <Button variant="secondary" size="sm" onClick={() => void detail.refetch()}>
                  {t('common:retry')}
                </Button>
              </div>
            ) : detailData ? (
              <>
                <InfoPanel detail={detailData} />
                <SecurityReportPanel
                  result={securityOverview.data}
                  error={securityOverview.error}
                />
              </>
            ) : (
              <div className="flex flex-col gap-3 p-4">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-52" />
              </div>
            )}
          </TabsContent>
          <TabsContent value="discussions" className="min-h-0 flex-1">
            <DiscussionsPanel
              kind={kind}
              repoId={repoId}
              onActiveDiscussion={setActiveDiscussion}
            />
          </TabsContent>
          {showPlayground && (
            <TabsContent value="playground" className="min-h-0 flex-1">
              <PlaygroundPanel repoId={repoId} />
            </TabsContent>
          )}
          {kind === 'model' && (
            <TabsContent value="local" className="min-h-0 flex-1">
              <LocalPlaygroundPanel
                repoId={repoId}
                detail={detailData}
                revision={revisionSelection.data}
              />
            </TabsContent>
          )}
          {kind === 'model' && (
            <TabsContent value="evals" className="min-h-0 flex-1 overflow-y-auto">
              <EvalResultsPanel
                repoId={repoId}
                requestedRevision={requestedRevision}
                resolvedCommit={revisionSelection.data.resolvedCommit}
              />
            </TabsContent>
          )}
          {isOwner && (
            <TabsContent value="manage" className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
                {kind === 'space' && !revisionSelection.data.isDefault && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-[12px] text-ink-muted">
                    {t('common:repro.repo.liveActionsWarning', {
                      commit: revisionSelection.data.resolvedCommit.slice(0, 8)
                    })}
                  </div>
                )}
                <RepoManagePanel kind={kind} repoId={repoId} />
                {kind === 'space' && <SpaceOpsPanel repoId={repoId} />}
              </div>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </RepoRevisionProvider>
  )
}

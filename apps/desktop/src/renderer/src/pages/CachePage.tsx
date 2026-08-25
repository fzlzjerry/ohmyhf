import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpRight,
  Boxes,
  ChevronRight,
  Database,
  FileInput,
  FolderOpen,
  HardDrive,
  LayoutGrid,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import { staleRevisionsOf } from '@oh-my-huggingface/shared'
import type {
  CachedRepo,
  LockfileInspection,
  LockfileRestoreEvent,
  RepoKind
} from '@oh-my-huggingface/shared'
import { describeError } from '@/lib/errors'
import { repoAppPath } from '@/lib/repo-open'
import { invoke } from '@/lib/ipc'
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import { resolveLocale, useAppStore } from '@/stores/app'

const KIND_ICON: Record<RepoKind, React.ComponentType<{ className?: string }>> = {
  model: Boxes,
  dataset: Database,
  space: LayoutGrid
}

interface PendingDelete {
  repo: CachedRepo
  commitHashes: string[]
  size: number
}

export function CachePage(): React.JSX.Element {
  const { t } = useTranslation(['cache', 'common', 'errors'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const push = useToasts((s) => s.push)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingDelete | null>(null)
  const [inspection, setInspection] = useState<LockfileInspection | null>(null)
  const [confirmWarnings, setConfirmWarnings] = useState(false)
  const restoreEvent = useQuery<LockfileRestoreEvent | null>({
    queryKey: ['lockfile-restore-event'],
    queryFn: () => Promise.resolve(null),
    enabled: false
  })

  const report = useQuery({
    queryKey: ['cache'],
    queryFn: () => invoke('cache:scan', undefined),
    staleTime: 5 * 60_000
  })

  const pins = useQuery({
    queryKey: ['cache-pins', report.data?.root ?? 'unknown'],
    queryFn: () => invoke('cache:listPins', undefined),
    enabled: Boolean(report.data)
  })

  const pinnedByRepo = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const pin of pins.data ?? []) {
      const key = `${pin.kind}:${pin.repoId}`
      let set = map.get(key)
      if (!set) map.set(key, (set = new Set()))
      set.add(pin.commit)
    }
    return map
  }, [pins.data])

  const togglePin = useMutation({
    mutationFn: ({
      repo,
      commit,
      pinned
    }: {
      repo: CachedRepo
      commit: string
      pinned: boolean
    }) =>
      pinned
        ? invoke('cache:unpin', { kind: repo.kind, repoId: repo.id, commit })
        : invoke('cache:pin', {
            kind: repo.kind,
            repoId: repo.id,
            commit,
            label: commit.slice(0, 12)
          }),
    onSuccess: () => void pins.refetch(),
    onError: (error) => push(error.message, 'error')
  })

  const inspectLock = useMutation({
    mutationFn: () => invoke('lockfile:inspect', undefined),
    onSuccess: (value) => {
      setInspection(value)
      setConfirmWarnings(false)
    },
    onError: (error) => push(error.message, 'error')
  })

  const confirmLockEndpoint = useMutation({
    mutationFn: (inspectionId: string) => invoke('lockfile:confirmEndpoint', { inspectionId }),
    onSuccess: (value) => {
      setInspection(value)
      setConfirmWarnings(false)
    },
    onError: (error) => push(error.message, 'error')
  })

  const restoreLock = useMutation({
    mutationFn: async (value: LockfileInspection) => {
      const securityGrantIds: string[] = []
      for (const [index] of value.lock.resources.entries()) {
        const inspected = value.resources[index]
        if (inspected?.currentSecurityDecision !== 'confirm') continue
        if (!inspected.securityChallengeId) throw new Error('security.challengeExpired')
        const grant = await invoke('lockfile:confirmSecurity', {
          inspectionId: value.inspectionId,
          resourceIndex: index,
          challengeId: inspected.securityChallengeId
        })
        securityGrantIds.push(grant.grantId)
      }
      return invoke('lockfile:restore', {
        inspectionId: value.inspectionId,
        confirmEndpoint: value.endpointMatches ? undefined : value.endpointConfirmed,
        securityGrantIds: securityGrantIds.length ? securityGrantIds : undefined
      })
    },
    onSuccess: (result) => {
      setInspection(null)
      void report.refetch()
      push(
        `Lock restore: ${result.readyResources.length} ready, ${result.queuedDownloadIds.length} downloads queued, ${result.blockedResources.length} blocked.`,
        result.blockedResources.length ? 'info' : 'success'
      )
    },
    onError: (error) => push(error.message, 'error')
  })

  const deleteRevisions = useMutation({
    mutationFn: (args: PendingDelete) =>
      invoke('cache:deleteRevisions', {
        kind: args.repo.kind,
        repoId: args.repo.id,
        commitHashes: args.commitHashes
      }),
    onSuccess: (next, args) => {
      queryClient.setQueryData(['cache'], next)
      void queryClient.invalidateQueries({ queryKey: ['download-capacity'] })
      push(t('cache:deleted', { size: formatBytes(args.size) }), 'success')
      setPending(null)
    },
    onError: (err) => {
      push(err.message, 'error')
      setPending(null)
    }
  })

  const cleanPartials = useMutation({
    mutationFn: (repo: CachedRepo) =>
      invoke('cache:cleanPartials', { kind: repo.kind, repoId: repo.id }),
    onSuccess: (next, repo) => {
      queryClient.setQueryData(['cache'], next)
      void queryClient.invalidateQueries({ queryKey: ['download-capacity'] })
      push(t('cache:deleted', { size: formatBytes(repo.partialSize ?? 0) }), 'success')
    },
    onError: (err) => push(describeError(t, err), 'error')
  })

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const staleOf = (repo: CachedRepo): PendingDelete | null => {
    const stale = staleRevisionsOf(repo, pinnedByRepo.get(`${repo.kind}:${repo.id}`))
    if (stale.length === 0) return null
    return {
      repo,
      commitHashes: stale.map((r) => r.commitHash),
      size: stale.reduce((acc, r) => acc + r.sizeOnDisk, 0)
    }
  }

  const lockHasWarnings = inspection?.resources.some(
    (resource) => resource.currentSecurityDecision === 'confirm'
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-smd nums font-semibold text-ink-strong">{t('cache:title')}</h1>
            {report.data && (
              <p className="nums flex items-center gap-1.5 text-[12.5px] text-ink-muted">
                {t('cache:totalOnDisk', { size: formatBytes(report.data.totalSize) })}
                <span className="text-decor" aria-hidden>
                  ·
                </span>
                {t('cache:reposCount', { count: report.data.repos.length })}
              </p>
            )}
            {report.data && (
              <p className="truncate font-mono text-[11.5px] text-ink-faint">{report.data.root}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={inspectLock.isPending}
              onClick={() => inspectLock.mutate()}
            >
              <FileInput className="size-3.5" aria-hidden />
              {t('common:repro.lock.inspect')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={report.isFetching}
              onClick={() => void report.refetch()}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              {report.isFetching ? t('cache:scanning') : t('cache:scan')}
            </Button>
          </div>
        </header>

        {(restoreEvent.data?.status === 'inspecting' ||
          restoreEvent.data?.status === 'restoring') && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-md border border-select/30 bg-select/5 px-3 py-2 text-[12px] text-ink-muted"
          >
            {t('common:loading')}
            {restoreEvent.data.totalResources !== undefined && (
              <span className="nums ml-2 font-mono">
                {restoreEvent.data.completedResources ?? 0}/{restoreEvent.data.totalResources}
              </span>
            )}
          </div>
        )}

        {inspection && (
          <section className="rounded-lg border border-border-card bg-card-gradient p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[13px] font-semibold text-ink-strong">
                  {t('common:repro.lock.inspectionTitle')}
                </h2>
                <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                  {inspection.lock.format} · {inspection.lock.hubEndpoint}
                </p>
              </div>
              <Badge
                variant={
                  inspection.endpointMatches || inspection.endpointConfirmed ? 'success' : 'warning'
                }
              >
                {inspection.endpointMatches
                  ? t('common:repro.lock.endpointMatches')
                  : inspection.endpointConfirmed
                    ? t('common:repro.lock.endpointConfirmed')
                    : t('common:repro.lock.differentEndpoint')}
              </Badge>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {inspection.resources.map((resource) => (
                <div
                  key={`${resource.kind}:${resource.repoId}:${resource.resolvedCommit}`}
                  className="rounded-md border bg-panel px-3 py-2 text-[11.5px]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{resource.kind}</Badge>
                    <span className="font-mono font-medium text-ink-strong">{resource.repoId}</span>
                    <span className="font-mono text-ink-faint">
                      {resource.requestedRevision} · {resource.resolvedCommit.slice(0, 12)}
                    </span>
                    <Badge
                      variant={
                        resource.currentSecurityDecision === 'allow'
                          ? 'success'
                          : resource.currentSecurityDecision === 'block'
                            ? 'error'
                            : 'warning'
                      }
                    >
                      {t('common:repro.lock.securityDecision', {
                        decision:
                          resource.currentSecurityDecision ??
                          t('common:repro.general.unknownNotProvided')
                      })}
                    </Badge>
                  </div>
                  <p className="nums mt-1 text-ink-muted">
                    {t('common:repro.lock.cachedMissingMismatched', {
                      cached: resource.cachedFiles,
                      missing: resource.missingFiles,
                      mismatched: resource.mismatchedFiles
                    })}
                    {resource.runtimeAvailable !== undefined
                      ? t('common:repro.lock.runtimeStatus', {
                          status: resource.runtimeAvailable
                            ? t('common:repro.lock.runtimeReady')
                            : t('common:repro.lock.runtimeUnavailable')
                        })
                      : ''}
                    {resource.securityChanged ? t('common:repro.lock.securityChangedSuffix') : ''}
                  </p>
                  {resource.errors.length > 0 && (
                    <p role="alert" className="mt-1 font-mono text-error">
                      {resource.errors.join(' · ')}
                    </p>
                  )}
                  {resource.securityReasons && resource.securityReasons.length > 0 && (
                    <p className="mt-1 font-mono text-warning">
                      {t('common:repro.lock.securityReasons', {
                        reasons: resource.securityReasons.join(', ')
                      })}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {!inspection.endpointMatches && !inspection.endpointConfirmed && (
              <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-[11.5px] text-ink-muted">
                <p>{t('common:repro.lock.endpointWarning')}</p>
                <Button
                  className="mt-2"
                  variant="secondary"
                  size="sm"
                  loading={confirmLockEndpoint.isPending}
                  onClick={() => confirmLockEndpoint.mutate(inspection.inspectionId)}
                >
                  {t('common:repro.lock.inspectConfirmEndpoint')}
                </Button>
              </div>
            )}
            {lockHasWarnings && (
              <label className="mt-3 flex items-start gap-2 text-[11.5px] text-ink-muted">
                <input
                  className="mt-0.5"
                  type="checkbox"
                  checked={confirmWarnings}
                  onChange={(event) => setConfirmWarnings(event.target.checked)}
                />
                {t('common:repro.lock.reviewedWarnings')}
              </label>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setInspection(null)}>
                {t('common:cancel')}
              </Button>
              <Button
                variant="cta"
                size="sm"
                loading={restoreLock.isPending}
                disabled={
                  (!inspection.endpointMatches && !inspection.endpointConfirmed) ||
                  (Boolean(lockHasWarnings) && !confirmWarnings)
                }
                onClick={() => restoreLock.mutate(inspection)}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {t('common:repro.lock.restoreExact')}
              </Button>
            </div>
          </section>
        )}

        {report.isLoading && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}

        {report.error !== null && (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="max-w-72 text-[13px] text-ink-muted">{describeError(t, report.error)}</p>
            <Button size="sm" onClick={() => void report.refetch()}>
              {t('common:retry')}
            </Button>
            {/* Cache users debug real paths and errnos — keep the raw error visible. */}
            <p className="max-w-full font-mono text-[11.5px] break-all text-ink-faint">
              {report.error.message}
            </p>
          </div>
        )}

        {report.error === null && report.data?.repos.length === 0 && (
          <EmptyState
            icon={HardDrive}
            title={t('cache:empty.title')}
            body={t('cache:empty.body')}
          />
        )}

        {report.error === null &&
          report.data?.repos.map((repo) => {
            const repoKey = `${repo.kind}:${repo.id}`
            const isOpen = expanded.has(repoKey)
            const stale = staleOf(repo)
            const Icon = KIND_ICON[repo.kind]
            return (
              <div key={repoKey} className="rounded-lg border">
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-t-lg px-3 py-2.5 transition-colors duration-150 hover:bg-panel',
                    !isOpen && 'rounded-b-lg'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(repoKey)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <ChevronRight
                      className={cn(
                        'size-4 shrink-0 text-decor transition-transform duration-150',
                        isOpen && 'rotate-90'
                      )}
                      aria-hidden
                    />
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-panel">
                      <Icon className="size-3.5 text-ink-muted" aria-hidden />
                    </span>
                    <span className="min-w-0 truncate font-mono text-[13px] font-medium tracking-tight text-ink-strong">
                      {repo.id}
                    </span>
                    <Badge variant="outline" className="nums">
                      {t('cache:revisions', { count: repo.revisions.length })}
                    </Badge>
                  </button>
                  <span className="nums min-w-16 text-right font-mono text-[12px] text-ink-faint">
                    {formatBytes(repo.sizeOnDisk)}
                  </span>
                  {stale && (
                    <Button variant="ghost" size="sm" onClick={() => setPending(stale)}>
                      <Trash2 className="size-3.5" aria-hidden />
                      {t('cache:deleteStale')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('common:showInFolder')}
                    onClick={() =>
                      void invoke('cache:revealRepo', { kind: repo.kind, repoId: repo.id })
                    }
                  >
                    <FolderOpen className="size-4" aria-hidden />
                  </Button>
                </div>
                {isOpen && (
                  <div className="border-t px-3 py-1.5">
                    {/* 1px inset guide aligned under the chevron column — a tree rail, not an accent. */}
                    <div className="ml-2 border-l border-border-card pl-3.5">
                      {repo.revisions.map((rev) => (
                        <div key={rev.commitHash} className="flex h-9 items-center gap-2.5">
                          <span className="nums w-24 shrink-0 font-mono text-[12px] text-ink-muted">
                            {rev.commitHash.slice(0, 10)}
                          </span>
                          {rev.refs.length > 0 ? (
                            rev.refs.map((ref) => (
                              <Badge
                                key={ref}
                                variant="outline"
                                className="border-select/25 bg-select/10 text-select"
                              >
                                {ref}
                              </Badge>
                            ))
                          ) : (
                            <Badge variant="outline">{t('cache:noRefs')}</Badge>
                          )}
                          {pinnedByRepo.get(`${repo.kind}:${repo.id}`)?.has(rev.commitHash) && (
                            <Badge
                              variant="outline"
                              className="border-select/25 bg-select/10 text-select"
                            >
                              {t('cache:pinned')}
                            </Badge>
                          )}
                          <span className="nums text-[11.5px] text-ink-faint">
                            {t('cache:files', { count: rev.fileCount })}
                          </span>
                          <span className="nums text-[11.5px] text-ink-faint">
                            {formatRelativeTime(rev.lastModified, locale)}
                          </span>
                          <span className="nums ml-auto font-mono text-[12px] text-ink-faint">
                            {formatBytes(rev.sizeOnDisk)}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('cache:openRevision')}
                            title={t('cache:openRevision')}
                            onClick={() =>
                              void navigate(repoAppPath(repo.kind, repo.id, rev.commitHash))
                            }
                          >
                            <ArrowUpRight className="size-3.5" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={
                              pinnedByRepo.get(`${repo.kind}:${repo.id}`)?.has(rev.commitHash)
                                ? t('common:repro.lock.unpinRevision')
                                : t('common:repro.lock.pinRevision')
                            }
                            onClick={() =>
                              togglePin.mutate({
                                repo,
                                commit: rev.commitHash,
                                pinned:
                                  pinnedByRepo
                                    .get(`${repo.kind}:${repo.id}`)
                                    ?.has(rev.commitHash) === true
                              })
                            }
                          >
                            {pinnedByRepo.get(`${repo.kind}:${repo.id}`)?.has(rev.commitHash) ? (
                              <PinOff className="size-3.5" aria-hidden />
                            ) : (
                              <Pin className="size-3.5" aria-hidden />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('cache:deleteRevision')}
                            onClick={() =>
                              setPending({
                                repo,
                                commitHashes: [rev.commitHash],
                                size: rev.sizeOnDisk
                              })
                            }
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </div>
                      ))}
                      {(repo.partialSize ?? 0) > 0 && (
                        <div className="nums flex h-9 items-center justify-between gap-2 text-[11.5px] text-ink-faint">
                          {t('cache:partialData', { size: formatBytes(repo.partialSize ?? 0) })}
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={cleanPartials.isPending}
                            onClick={() => cleanPartials.mutate(repo)}
                          >
                            {t('cache:cleanPartials')}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold">
            {t('cache:confirmDelete.title', { count: pending?.commitHashes.length ?? 0 })}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-ink-muted">
            {t('cache:confirmDelete.body', { size: formatBytes(pending?.size ?? 0) })}
          </DialogDescription>
          {/* Show exactly which snapshots go — ref-less does not always mean disposable. */}
          <p className="mt-2 font-mono text-[11.5px] break-all text-ink-faint">
            {pending?.commitHashes.map((h) => h.slice(0, 10)).join(' · ')}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deleteRevisions.isPending}
              onClick={() => pending && deleteRevisions.mutate(pending)}
            >
              {t('common:delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

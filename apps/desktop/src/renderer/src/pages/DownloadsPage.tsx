import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  CircleCheck,
  CircleX,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react'
import type { DownloadStatus, DownloadTask } from '@oh-my-huggingface/shared'
import { describeError } from '@/lib/errors'
import { invoke } from '@/lib/ipc'
import { cn, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSecurityGate } from '@/hooks/use-security-gate'

const STATUS_DOT: Record<DownloadStatus, string> = {
  queued: 'bg-ink-faint',
  running: 'bg-select',
  paused: 'bg-warning',
  completed: 'bg-success',
  error: 'bg-error',
  canceled: 'bg-ink-faint'
}

type Action = 'downloads:pause' | 'downloads:resume' | 'downloads:cancel' | 'downloads:remove'

type BulkAction = 'downloads:pauseAll' | 'downloads:resumeAll' | 'downloads:clearCompleted'

function TaskCard({ task }: { task: DownloadTask }): React.JSX.Element {
  const { t } = useTranslation(['downloads', 'common', 'errors'])
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const security = useSecurityGate()
  const [confirmRemove, setConfirmRemove] = useState(false)

  const act = useMutation({
    mutationFn: (action: Action) => invoke(action, { id: task.id }),
    onSuccess: (tasks, action) => {
      queryClient.setQueryData(['downloads'], tasks)
      if (action === 'downloads:remove') push(t('downloads:removed'), 'success')
    }
  })

  const retryPostAction = useMutation({
    mutationFn: async () => {
      if (!task.postAction || !task.resolvedCommit) throw new Error('Exact revision unavailable')
      const securityGrantId = await security.authorize({
        action: 'local-run',
        kind: 'model',
        repoId: task.repoId,
        revision: task.revision,
        resolvedCommit: task.resolvedCommit,
        files: [task.postAction.filePath]
      })
      return invoke('downloads:retryPostAction', {
        id: task.id,
        securityGrantId,
        allowTightFit: task.postAction.error?.startsWith('runtime.fitConfirmationRequired')
      })
    },
    onSuccess: (tasks) => queryClient.setQueryData(['downloads'], tasks),
    onError: (error) => push(error.message, 'error')
  })

  const done = task.files.filter((f) => f.status === 'completed').length
  const progress = task.totalBytes > 0 ? task.receivedBytes / task.totalBytes : 0
  // The badge is a claim about the whole task: every file must have passed a real check.
  const verified =
    task.status === 'completed' && task.files.length > 0 && task.files.every((f) => f.verified)
  const active = task.status === 'running' || task.status === 'queued'

  const openFolder = (): void => {
    void invoke('downloads:reveal', { id: task.id })
  }

  return (
    <>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border-card bg-card-gradient p-4">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] font-medium text-ink-strong">
            {task.repoId}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-ink-muted">
            <span
              className={cn(
                'size-1.5 rounded-full',
                STATUS_DOT[task.status],
                task.status === 'running' && 'animate-pulse'
              )}
              aria-hidden
            />
            {t(`downloads:status.${task.status}`)}
          </span>
        </div>
        <Progress
          value={progress}
          indeterminate={task.status === 'running' && task.totalBytes === 0}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
          <span className="nums font-mono text-ink-faint">
            {formatBytes(task.receivedBytes)} / {formatBytes(task.totalBytes)}
          </span>
          {task.status === 'running' && task.speedBps > 0 && (
            <span className="nums font-mono text-ink-faint">
              {t('downloads:speed', { speed: formatBytes(task.speedBps) })}
            </span>
          )}
          <span className="nums">{t('downloads:files', { done, total: task.files.length })}</span>
          <span className="text-ink-faint">
            {t('common:repro.downloads.requested')}{' '}
            <span className="font-mono">{task.revision}</span>
          </span>
          <span className="text-ink-faint">
            {t('common:repro.downloads.commit')}{' '}
            <span className="font-mono">
              {task.resolvedCommit
                ? task.resolvedCommit.slice(0, 12)
                : t('common:repro.downloads.legacyUnresolved')}
            </span>
          </span>
          {verified && (
            <span className="flex items-center gap-1 text-success">
              <CircleCheck className="size-3.5" aria-hidden />
              {t('downloads:checksumsVerified')}
            </span>
          )}
          {task.status === 'completed' && !verified && (
            <span className="flex items-center gap-1 text-warning">
              <CircleX className="size-3.5" aria-hidden />
              {t('common:repro.downloads.integrityIncomplete')}
            </span>
          )}
          {task.error && (
            <span className="flex min-w-0 items-center gap-1 text-error" title={task.error}>
              <CircleX className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{describeError(t, task.error)}</span>
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {(task.status === 'running' || task.status === 'queued') && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('downloads:actions.pause')}
                    onClick={() => act.mutate('downloads:pause')}
                  >
                    <Pause className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('downloads:actions.pause')}</TooltipContent>
              </Tooltip>
            )}
            {(task.status === 'paused' || task.status === 'error') && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('downloads:actions.resume')}
                    onClick={() => act.mutate('downloads:resume')}
                  >
                    <Play className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('downloads:actions.resume')}</TooltipContent>
              </Tooltip>
            )}
            {task.status !== 'completed' && task.status !== 'canceled' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('downloads:actions.cancel')}
                    onClick={() => act.mutate('downloads:cancel')}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('downloads:actions.cancel')}</TooltipContent>
              </Tooltip>
            )}
            {task.status === 'completed' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('downloads:actions.openFolder')}
                    onClick={openFolder}
                  >
                    <FolderOpen className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('downloads:actions.openFolder')}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('downloads:actions.remove')}
                  onClick={() => (active ? setConfirmRemove(true) : act.mutate('downloads:remove'))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('downloads:actions.remove')}</TooltipContent>
            </Tooltip>
          </span>
        </div>
        {task.files.some((file) => file.localSha256) && (
          <details className="rounded-md border border-border-card bg-panel px-2.5 py-1.5 text-[11px]">
            <summary className="cursor-pointer text-ink-muted">
              {t('common:repro.downloads.integrityDetails')}
            </summary>
            <ul className="mt-2 flex max-h-36 flex-col gap-1 overflow-y-auto font-mono text-ink-faint">
              {task.files.map((file) => (
                <li key={file.path} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <span className="truncate" title={file.path}>
                    {file.path}
                  </span>
                  <span
                    className={file.verified ? 'text-success' : 'text-warning'}
                    title={file.localSha256}
                  >
                    {file.verified
                      ? t('common:repro.downloads.verified')
                      : t('common:repro.downloads.unverified')}
                    {file.localSha256 ? ` · sha256:${file.localSha256.slice(0, 12)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {task.postAction && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11.5px] text-ink-muted"
            role={task.postAction.status === 'error' ? 'alert' : 'status'}
          >
            <span className="font-medium text-ink-strong">
              {t('common:repro.downloads.localRun')}
            </span>
            <span className="font-mono">{task.postAction.runtime}</span>
            <span>· {task.postAction.status}</span>
            {task.postAction.error && (
              <span className="min-w-0 flex-1 truncate text-error" title={task.postAction.error}>
                {task.postAction.error}
              </span>
            )}
            {task.postAction.status !== 'running' && (
              <Button
                className="ml-auto"
                variant="secondary"
                size="sm"
                loading={retryPostAction.isPending}
                onClick={() => retryPostAction.mutate()}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {t('common:repro.downloads.recheckRun')}
              </Button>
            )}
          </div>
        )}
      </div>

      {security.dialog}

      {/* Removing a live download cancels the transfer — confirm first. */}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold">
            {t('downloads:confirmRemove.title')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-ink-muted">
            {t('downloads:confirmRemove.body')}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirmRemove(false)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmRemove(false)
                act.mutate('downloads:remove')
              }}
            >
              {t('downloads:confirmRemove.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function DownloadsPage(): React.JSX.Element {
  const { t } = useTranslation(['downloads', 'common'])
  const queryClient = useQueryClient()
  const tasks = useQuery({
    queryKey: ['downloads'],
    queryFn: () => invoke('downloads:list', undefined)
  })

  const bulk = useMutation({
    mutationFn: (action: BulkAction) => invoke(action, undefined),
    onSuccess: (next) => queryClient.setQueryData(['downloads'], next)
  })

  const total = tasks.data?.length ?? 0
  const list = tasks.data ?? []
  const hasResumable = list.some((task) => task.status === 'paused' || task.status === 'error')
  const hasActive = list.some((task) => task.status === 'running' || task.status === 'queued')
  const hasCompleted = list.some((task) => task.status === 'completed')

  let content: React.JSX.Element | React.JSX.Element[]
  if (tasks.data === undefined && !tasks.error) {
    content = Array.from({ length: 4 }, (_, i) => (
      <div key={i} className="flex flex-col gap-2.5 rounded-lg border border-border-card p-4">
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    ))
  } else if (tasks.error) {
    content = (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="max-w-72 text-[13px] text-ink-muted">{t('common:error.network')}</p>
        <Button size="sm" onClick={() => void tasks.refetch()}>
          {t('common:retry')}
        </Button>
      </div>
    )
  } else if (total === 0) {
    content = <EmptyState icon={ArrowDownToLine} title={t('empty.title')} body={t('empty.body')} />
  } else {
    content = (tasks.data ?? []).map((task) => <TaskCard key={task.id} task={task} />)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-[15px] font-semibold text-ink-strong">{t('title')}</h1>
            {total > 0 && (
              <p className="nums text-[12.5px] text-ink-muted">
                {t('count', {
                  count: total,
                  defaultValue_one: '{{count}} task',
                  defaultValue_other: '{{count}} tasks'
                })}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {hasResumable && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => bulk.mutate('downloads:resumeAll')}
              >
                <Play className="size-3.5" aria-hidden />
                {t('downloads:bulk.resumeAll')}
              </Button>
            )}
            {hasActive && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => bulk.mutate('downloads:pauseAll')}
              >
                <Pause className="size-3.5" aria-hidden />
                {t('downloads:bulk.pauseAll')}
              </Button>
            )}
            {hasCompleted && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => bulk.mutate('downloads:clearCompleted')}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t('downloads:bulk.clearCompleted')}
              </Button>
            )}
          </div>
        </header>
        {content}
      </div>
    </div>
  )
}

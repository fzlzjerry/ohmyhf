import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Boxes,
  Database,
  FolderGit2,
  LayoutGrid,
  MoreHorizontal,
  ShieldAlert,
  UserX
} from 'lucide-react'
import { normalizeHubEndpoint, type MyRepoEntry, type RepoKind } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { isRepoQuery, repoQueryKey } from '@/lib/query'
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import {
  DeleteRepoDialog,
  DuplicateRepoDialog,
  RenameRepoDialog
} from '@/components/admin/RepoActionDialogs'
import { MANAGE_REPOS_SCOPE, scopeMissing } from '@/lib/scopes'
import { resolveLocale, useAppStore } from '@/stores/app'

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

type KindFilter = 'all' | RepoKind

const FILTERS: readonly KindFilter[] = ['all', 'model', 'dataset', 'space']

type RepoDialogKind = 'rename' | 'duplicate' | 'delete'

export function MyReposPage(): React.JSX.Element {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const auth = useAppStore((s) => s.auth)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)

  const [filter, setFilter] = useState<KindFilter>('all')
  const [dialog, setDialog] = useState<{ type: RepoDialogKind; repo: MyRepoEntry } | null>(null)

  const signedIn = auth.status === 'signedIn'
  const canManage = !scopeMissing(auth, MANAGE_REPOS_SCOPE)

  const repos = useQuery({
    queryKey: ['my-repos', endpointKey],
    queryFn: () => invoke('hub:myRepos', undefined),
    enabled: signedIn
  })

  const setVisibility = useMutation({
    mutationFn: (args: { repo: MyRepoEntry; makePrivate: boolean }) =>
      invoke('hub:repoSettingsUpdate', {
        kind: args.repo.kind,
        repoId: args.repo.id,
        patch: { private: args.makePrivate }
      }),
    onSuccess: (_result, { repo }) => {
      push(t('admin:visibility.updated'), 'success')
      void queryClient.invalidateQueries({ queryKey: ['my-repos'] })
      void queryClient.invalidateQueries({
        queryKey: repoQueryKey('repo', endpointKey, repo.kind, repo.id)
      })
    },
    onError: (err) => push(err.message, 'error')
  })

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['my-repos'] })
  }

  // Rename/delete leave stale detail caches behind under the old id; drop them too.
  const refreshAndDrop = (repo: MyRepoEntry): void => {
    queryClient.removeQueries({
      predicate: (query) => isRepoQuery(query.queryKey, endpointKey, repo.kind, repo.id)
    })
    refresh()
  }

  const visible = useMemo(() => {
    const list = repos.data ?? []
    const filtered = filter === 'all' ? list : list.filter((r) => r.kind === filter)
    return [...filtered].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }, [repos.data, filter])

  if (!signedIn) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl p-5">
          <EmptyState
            icon={UserX}
            title={t('admin:signedOut.title')}
            body={t('admin:signedOut.body')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <h1 className="text-smd font-semibold text-ink-strong">{t('admin:myRepos.title')}</h1>
          <div className="ml-auto flex items-center gap-0.5">
            {FILTERS.map((f) => (
              <Button
                key={f}
                variant="ghost"
                size="sm"
                aria-pressed={filter === f}
                className={cn(filter === f && 'bg-panel-2 text-ink-strong')}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? t('admin:myRepos.filter.all') : t(`common:kind.${f}`)}
              </Button>
            ))}
          </div>
        </div>

        {!canManage && (
          <p className="flex items-start gap-2 rounded-md border bg-panel px-3 py-2 text-[12.5px] text-ink-muted">
            <ShieldAlert className="mt-px size-4 shrink-0 text-warning" aria-hidden />
            {t('admin:gatedHint.body')}
          </p>
        )}

        {repos.isPending && (
          <div className="flex flex-col gap-1.5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}

        {repos.isError && (
          <EmptyState
            icon={ShieldAlert}
            title={t('admin:error.title')}
            body={repos.error.message}
            action={
              <Button size="sm" onClick={() => void repos.refetch()}>
                {t('common:retry')}
              </Button>
            }
          />
        )}

        {repos.data?.length === 0 && (
          <EmptyState
            icon={FolderGit2}
            title={t('admin:myRepos.empty.title')}
            body={t('admin:myRepos.empty.body')}
          />
        )}

        <div className="flex flex-col gap-1">
          {visible.map((repo) => {
            const Icon = KIND_ICON[repo.kind]
            return (
              <div
                key={`${repo.kind}:${repo.id}`}
                className="group flex items-center gap-2.5 rounded-md border px-3 py-2.5 transition-colors hover:bg-panel"
              >
                <button
                  type="button"
                  onClick={() => navigate(`/${KIND_PATH[repo.kind]}/${repo.id}`)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                >
                  <Icon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 truncate font-mono text-[13px] font-medium tracking-tight text-ink-strong transition-colors duration-150 group-hover:text-hover-title">
                    {repo.id}
                  </span>
                  {repo.visibility === 'private' && (
                    <Badge variant="warning">{t('common:private')}</Badge>
                  )}
                  {repo.visibility === 'protected' && (
                    <Badge variant="neutral">{t('admin:visibility.protected')}</Badge>
                  )}
                  <span className="nums ml-auto flex shrink-0 items-center gap-2 text-[11.5px] text-ink-faint">
                    {repo.storage > 0 && (
                      <span title={`${repo.storagePercent.toFixed(1)}%`}>
                        {formatBytes(repo.storage)}
                      </span>
                    )}
                    <span>{formatRelativeTime(repo.updatedAt, locale)}</span>
                  </span>
                </button>
                {canManage && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={t('admin:actions.label')}>
                        <MoreHorizontal className="size-4" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {repo.visibility !== 'protected' && (
                        <DropdownMenuItem
                          onSelect={() =>
                            setVisibility.mutate({
                              repo,
                              makePrivate: repo.visibility !== 'private'
                            })
                          }
                        >
                          {repo.visibility === 'private'
                            ? t('admin:visibility.makePublic')
                            : t('admin:visibility.makePrivate')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => setDialog({ type: 'rename', repo })}>
                        {t('admin:actions.rename')}
                      </DropdownMenuItem>
                      {/* The Hub only supports duplicating Spaces. */}
                      {repo.kind === 'space' && (
                        <DropdownMenuItem onSelect={() => setDialog({ type: 'duplicate', repo })}>
                          {t('admin:actions.duplicate')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-error data-[highlighted]:text-error"
                        onSelect={() => setDialog({ type: 'delete', repo })}
                      >
                        {t('common:delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {dialog && (
        <>
          <RenameRepoDialog
            kind={dialog.repo.kind}
            repoId={dialog.repo.id}
            open={dialog.type === 'rename'}
            onOpenChange={(open) => !open && setDialog(null)}
            onDone={() => refreshAndDrop(dialog.repo)}
          />
          <DuplicateRepoDialog
            repoId={dialog.repo.id}
            open={dialog.type === 'duplicate'}
            onOpenChange={(open) => !open && setDialog(null)}
            onDone={refresh}
          />
          <DeleteRepoDialog
            kind={dialog.repo.kind}
            repoId={dialog.repo.id}
            open={dialog.type === 'delete'}
            onOpenChange={(open) => !open && setDialog(null)}
            onDone={() => refreshAndDrop(dialog.repo)}
          />
        </>
      )}
    </div>
  )
}

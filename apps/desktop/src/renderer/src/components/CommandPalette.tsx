import { useCallback, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Command } from 'cmdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  ArrowUpDown,
  Boxes,
  Building2,
  Columns3,
  Database,
  Bookmark,
  FileText,
  Filter,
  FolderGit2,
  HardDrive,
  Home,
  Heart,
  History,
  Inbox,
  Keyboard,
  Library,
  LayoutGrid,
  Loader2,
  Moon,
  Pause,
  Play,
  Search,
  Settings,
  Star,
  Sun,
  SunMoon,
  Trash2,
  UploadCloud,
  User
} from 'lucide-react'
import type { RepoKind, RepoSort, RepoSummary } from '@oh-my-huggingface/shared'
import { parseHubResource } from '@oh-my-huggingface/shared'
import { LIBRARIES, LICENSES, PARAM_BUCKETS, TASKS } from '@/lib/catalog'
import type { ParamBucket } from '@/lib/utils'
import { formatCount } from '@/lib/utils'
import { openRepo } from '@/lib/repo-open'
import { invoke } from '@/lib/ipc'
import { Kbd } from '@/components/ui/kbd'
import { useToasts } from '@/components/ui/toaster'
import { useCommandActionStore } from '@/hooks/use-command-actions'
import { useGlobalSearch } from '@/hooks/use-global-search'
import { resolveLocale, useAppStore } from '@/stores/app'

type Page = 'root' | 'download' | 'task' | 'library' | 'license' | 'params' | 'sort'

// Key glyphs for the footer hint bar (not user copy; the labels are localized).
const KEY_UP = '↑'
const KEY_DOWN = '↓'
const KEY_ENTER = '↵'
const KEY_ESC = 'Esc'

const KIND_BY_PATH: Record<string, RepoKind> = {
  '/models': 'model',
  '/datasets': 'dataset',
  '/spaces': 'space'
}

const KIND_PATH: Record<RepoKind, string> = {
  model: '/models',
  dataset: '/datasets',
  space: '/spaces'
}

const KIND_ICON: Record<RepoKind, React.ComponentType<{ className?: string }>> = {
  model: Boxes,
  dataset: Database,
  space: LayoutGrid
}

const KIND_LABEL_KEY: Record<RepoKind, string> = {
  model: 'nav:models',
  dataset: 'nav:datasets',
  space: 'nav:spaces'
}

const ALL_KINDS: RepoKind[] = ['model', 'dataset', 'space']

const SORTS: RepoSort[] = ['trending', 'downloads', 'likes', 'updated', 'created']

/** Mirrors FiltersBar: spaces have no download counts, so no downloads sort. */
export function sortsForKind(kind: RepoKind): RepoSort[] {
  return SORTS.filter((sort) => !(kind === 'space' && sort === 'downloads'))
}

/** Result-group order: key into useGlobalSearch's buckets + the repo kind. */
const SEARCH_GROUPS = [
  ['models', 'model'],
  ['datasets', 'dataset'],
  ['spaces', 'space']
] as const satisfies ReadonlyArray<readonly [string, RepoKind]>

function RepoResultItem({
  repo,
  locale,
  disabled = false,
  onSelect
}: {
  repo: RepoSummary
  locale: string
  disabled?: boolean
  onSelect: () => void
}): React.JSX.Element {
  const Icon = KIND_ICON[repo.kind]
  return (
    <Command.Item value={`${repo.kind}:${repo.id}`} disabled={disabled} onSelect={onSelect}>
      <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-ink-strong">{repo.id}</span>
      <span className="nums flex shrink-0 items-center gap-2 text-[11px] text-ink-faint">
        <span className="flex items-center gap-0.5">
          <Heart className="size-3" aria-hidden />
          {formatCount(repo.likes, locale)}
        </span>
        <span className="flex items-center gap-0.5">
          <ArrowDownToLine className="size-3" aria-hidden />
          {formatCount(repo.downloads, locale)}
        </span>
      </span>
    </Command.Item>
  )
}

export function CommandPalette(): React.JSX.Element {
  const { t } = useTranslation(['nav', 'browse', 'common', 'downloads', 'errors'])
  const open = useAppStore((s) => s.paletteOpen)
  const setOpen = useAppStore((s) => s.setPaletteOpen)
  const setFilters = useAppStore((s) => s.setFilters)
  const resetFilters = useAppStore((s) => s.resetFilters)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettings = useAppStore((s) => s.openSettings)
  const setShortcutsOpen = useAppStore((s) => s.setShortcutsOpen)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const queryClient = useQueryClient()
  const push = useToasts((state) => state.push)
  const actionScopes = useCommandActionStore((state) => state.scopes)
  const contextActions = [...actionScopes.values()].flat()
  const navigate = useNavigate()
  const location = useLocation()
  const [page, setPage] = useState<Page>('root')
  const [value, setValue] = useState('')
  const [runningActionId, setRunningActionId] = useState<string | null>(null)

  const browseKind: RepoKind =
    Object.entries(KIND_BY_PATH).find(([path]) => location.pathname.startsWith(path))?.[1] ??
    'model'

  const query = value.trim()
  const needle = query.toLowerCase()
  const matches = (label: string): boolean => needle === '' || label.toLowerCase().includes(needle)

  const search = useGlobalSearch(page === 'root' || page === 'download' ? value : '')
  const downloads = useQuery({
    queryKey: ['downloads'],
    queryFn: () => invoke('downloads:list', undefined),
    staleTime: Infinity
  })
  const startDownload = useMutation({
    mutationFn: (repo: RepoSummary) =>
      invoke('downloads:start', { request: { kind: repo.kind, repoId: repo.id } }),
    onSuccess: (tasks) => {
      queryClient.setQueryData(['downloads'], tasks)
      push(t('downloads:commands.started'), 'success')
      setOpen(false)
      setPage('root')
      setValue('')
    },
    onError: (error) => push(error.message, 'error')
  })
  const bulkDownload = useMutation({
    mutationFn: (
      channel: 'downloads:pauseAll' | 'downloads:resumeAll' | 'downloads:clearCompleted'
    ) => invoke(channel, undefined),
    onSuccess: (tasks) => queryClient.setQueryData(['downloads'], tasks),
    onError: (error) => push(error.message, 'error')
  })

  const onOpenChange = useCallback(
    (next: boolean): void => {
      setOpen(next)
      if (!next) {
        setPage('root')
        setValue('')
        setRunningActionId(null)
      }
    },
    [setOpen]
  )

  const closeAnd = useCallback(
    (fn: () => void): void => {
      setOpen(false)
      // Programmatic close skips onOpenChange, so reset here too.
      setPage('root')
      setValue('')
      fn()
    },
    [setOpen]
  )

  // Sub-page lists filter on the input, so a leftover needle would hide every option.
  const enterPage = (next: Page): void => {
    setPage(next)
    setValue('')
  }

  const runContextAction = (action: (typeof contextActions)[number]): void => {
    if (runningActionId) return
    setRunningActionId(action.id)
    void Promise.resolve()
      .then(() => action.run())
      .then(() => {
        setOpen(false)
        setPage('root')
        setValue('')
      })
      .catch((error: unknown) => {
        // Keep the palette open so the same command can be retried.
        push(error instanceof Error ? error.message : String(error), 'error')
      })
      .finally(() => setRunningActionId(null))
  }

  const applyFilter = (kind: RepoKind, patch: Parameters<typeof setFilters>[1]): void =>
    closeAnd(() => {
      setFilters(kind, patch)
      navigate(KIND_PATH[kind])
    })

  const navItems = [
    { to: '/', label: t('nav:home'), icon: Home },
    { to: '/models', label: t('nav:models'), icon: Boxes },
    { to: '/datasets', label: t('nav:datasets'), icon: Database },
    { to: '/spaces', label: t('nav:spaces'), icon: LayoutGrid },
    { to: '/papers', label: t('nav:papers'), icon: FileText },
    { to: '/favorites', label: t('nav:favorites'), icon: Star },
    { to: '/history', label: t('nav:history'), icon: History },
    { to: '/my-repos', label: t('nav:myRepos'), icon: FolderGit2 },
    { to: '/collections', label: t('nav:collections'), icon: Bookmark },
    { to: '/downloads', label: t('nav:downloads'), icon: ArrowDownToLine },
    { to: '/cache', label: t('nav:cache'), icon: HardDrive },
    { to: '/inbox', label: t('nav:inbox'), icon: Inbox },
    { to: '/compare', label: t('nav:compare'), icon: Columns3 },
    { to: '/upload', label: t('nav:upload'), icon: UploadCloud }
  ]
  const pastedRoute = query ? parseHubResource(query, settings.hubEndpoint) : null

  const filterPages: Array<{ page: Page; label: string; icon: typeof Filter }> = [
    { page: 'task', label: t('browse:filter.task'), icon: Filter },
    { page: 'library', label: t('browse:filter.library'), icon: Filter },
    { page: 'license', label: t('browse:filter.license'), icon: Filter },
    // Param counts only exist on models; other kinds would always filter to nothing.
    ...(browseKind === 'model'
      ? [{ page: 'params' as const, label: t('browse:filter.params'), icon: Filter }]
      : []),
    { page: 'sort', label: t('browse:sort.label'), icon: ArrowUpDown }
  ]

  const themeItems = [
    { theme: 'light', label: t('common:theme.light'), icon: Sun },
    { theme: 'dark', label: t('common:theme.dark'), icon: Moon },
    { theme: 'system', label: t('common:theme.system'), icon: SunMoon }
  ] as const

  const sorts = sortsForKind(browseKind)

  const visibleNav = navItems.filter((item) => matches(item.label))
  const visibleFilterPages = filterPages.filter((item) => matches(item.label))
  const visibleThemes = themeItems.filter((item) => matches(item.label))
  const showSettings = matches(t('nav:settings'))
  const showClear = matches(t('browse:filter.clear'))
  const showShortcuts = matches(t('nav:shortcuts'))
  const showDownload = matches(t('downloads:commands.downloadRepository'))
  const staticCount =
    visibleNav.length +
    visibleFilterPages.length +
    visibleThemes.length +
    (showSettings ? 1 : 0) +
    (showClear ? 1 : 0) +
    (showShortcuts ? 1 : 0) +
    (showDownload ? 1 : 0) +
    contextActions.filter((action) => matches(action.label)).length

  const asyncCount =
    search.models.length +
    search.datasets.length +
    search.spaces.length +
    search.orgs.length +
    search.users.length +
    search.papers.length +
    search.collections.length
  // Root: only surface Empty once every hub query settled with nothing and no static row matched.
  const showEmpty =
    page === 'root'
      ? needle === '' || (!search.isLoading && asyncCount === 0 && staticCount === 0)
      : page === 'download'
        ? needle !== '' &&
          !search.isLoading &&
          search.models.length + search.datasets.length + search.spaces.length === 0
        : true

  const hasResumable = downloads.data?.some(
    (task) => task.status === 'paused' || (task.status === 'error' && task.resumable)
  )
  const hasActive = downloads.data?.some(
    (task) => task.status === 'running' || task.status === 'queued'
  )
  const hasCompleted = downloads.data?.some((task) => task.status === 'completed')

  const searchKinds: RepoKind[] = [browseKind, ...ALL_KINDS.filter((k) => k !== browseKind)]

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={t('nav:commandPalette')}
      shouldFilter={false}
      className="animate-fade-rise fixed top-[18%] left-1/2 z-50 w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-lg border bg-elevated shadow-overlay"
      overlayClassName="animate-fade fixed inset-0 z-40 bg-scrim-soft"
    >
      <div className="flex items-center gap-2 border-b px-3">
        <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
        <Command.Input
          value={value}
          onValueChange={setValue}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && page !== 'root') {
              e.preventDefault()
              e.stopPropagation()
              setPage('root')
              setValue('')
              return
            }
            // Footer hint: '?' on an empty input jumps to the shortcuts dialog.
            if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && value === '') {
              e.preventDefault()
              closeAnd(() => setShortcutsOpen(true))
            }
          }}
          placeholder={
            page === 'root'
              ? t('nav:globalSearch')
              : page === 'download'
                ? t('downloads:commands.searchPlaceholder')
                : t('nav:search')
          }
          className="h-11 w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
        />
      </div>
      <Command.List className="max-h-80 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-faint [&_[cmdk-group-heading]]:uppercase [&_[cmdk-item]]:flex [&_[cmdk-item]]:cursor-default [&_[cmdk-item]]:items-center [&_[cmdk-item]]:gap-2.5 [&_[cmdk-item]]:rounded-md [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2 [&_[cmdk-item]]:text-[13px] [&_[cmdk-item][data-selected=true]]:bg-panel-2 [&_[cmdk-item][data-selected=true]]:text-ink-strong [&_[cmdk-item][data-selected=true]_svg]:text-ink">
        {showEmpty && (
          <Command.Empty className="px-3 py-6 text-center text-[13px] text-ink-muted">
            {t('browse:empty.title')}
          </Command.Empty>
        )}

        {page === 'root' && (
          <>
            {pastedRoute && (
              <Command.Group heading={t('nav:palette.navigate')}>
                <Command.Item
                  value={`open-link:${pastedRoute}`}
                  onSelect={() => closeAnd(() => navigate(pastedRoute))}
                >
                  <Search className="size-4 text-ink-faint" aria-hidden />
                  {t('nav:openHubLink', { route: pastedRoute })}
                </Command.Item>
              </Command.Group>
            )}
            {needle !== '' &&
              (search.isLoading ? (
                <Command.Loading>
                  <div className="flex items-center gap-2.5 px-2 py-2 text-[13px] text-ink-muted">
                    <Loader2 className="size-4 shrink-0 animate-spin text-ink-faint" aria-hidden />
                    {t('nav:searching')}
                  </div>
                </Command.Loading>
              ) : (
                <>
                  {SEARCH_GROUPS.map(([group, kind]) =>
                    search[group].length > 0 ? (
                      <Command.Group key={group} heading={t(KIND_LABEL_KEY[kind])}>
                        {search[group].map((repo) => (
                          <RepoResultItem
                            key={repo.id}
                            repo={repo}
                            locale={locale}
                            onSelect={() =>
                              closeAnd(() =>
                                openRepo(
                                  repo.kind,
                                  repo.id,
                                  settings.repoOpenTarget,
                                  navigate,
                                  settings.hubEndpoint
                                )
                              )
                            }
                          />
                        ))}
                      </Command.Group>
                    ) : null
                  )}
                  {search.orgs.length > 0 && (
                    <Command.Group heading={t('nav:organizations')}>
                      {search.orgs.map((org) => (
                        <Command.Item
                          key={org.name}
                          value={`org:${org.name}`}
                          onSelect={() => closeAnd(() => navigate(`/users/${org.name}`))}
                        >
                          <Building2 className="size-4 shrink-0 text-ink-faint" aria-hidden />
                          <span className="min-w-0 flex-1 truncate font-mono text-ink-strong">
                            {org.name}
                          </span>
                          {org.fullname ? (
                            <span className="max-w-40 shrink-0 truncate text-[11px] text-ink-faint">
                              {org.fullname}
                            </span>
                          ) : null}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                  {search.users.length > 0 && (
                    <Command.Group heading={t('nav:users')}>
                      {search.users.map((user) => (
                        <Command.Item
                          key={user.name}
                          value={`user:${user.name}`}
                          onSelect={() => closeAnd(() => navigate(`/users/${user.name}`))}
                        >
                          <User className="size-4 shrink-0 text-ink-faint" aria-hidden />
                          <span className="min-w-0 flex-1 truncate font-mono text-ink-strong">
                            {user.name}
                          </span>
                          {user.fullname ? (
                            <span className="max-w-40 shrink-0 truncate text-[11px] text-ink-faint">
                              {user.fullname}
                            </span>
                          ) : null}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                  {search.papers.length > 0 && (
                    <Command.Group heading={t('nav:papers')}>
                      {search.papers.map((paper) => (
                        <Command.Item
                          key={paper.id}
                          value={`paper:${paper.id}`}
                          onSelect={() => closeAnd(() => navigate(`/papers/${paper.id}`))}
                        >
                          <FileText className="size-4 shrink-0 text-ink-faint" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-ink-strong">
                            {paper.title}
                          </span>
                          <span className="max-w-40 shrink-0 truncate font-mono text-[11px] text-ink-faint">
                            {paper.id}
                          </span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                  {search.collections.length > 0 && (
                    <Command.Group heading={t('nav:collections')}>
                      {search.collections.map((col) => (
                        <Command.Item
                          key={col.slug}
                          value={`collection:${col.slug}`}
                          onSelect={() => closeAnd(() => navigate(`/collections/${col.slug}`))}
                        >
                          <Library className="size-4 shrink-0 text-ink-faint" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-ink-strong">
                            {col.title}
                          </span>
                          <span className="max-w-40 shrink-0 truncate font-mono text-[11px] text-ink-faint">
                            {col.slug}
                          </span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                </>
              ))}
            {needle !== '' && (
              <Command.Item
                value={`searchAll:${query}`}
                onSelect={() =>
                  closeAnd(() => navigate(`/search?q=${encodeURIComponent(query)}&type=all`))
                }
              >
                <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
                <span className="truncate">{t('nav:searchAll', { query })}</span>
              </Command.Item>
            )}
            {needle !== '' &&
              searchKinds.map((kind) => (
                <Command.Item
                  key={`searchIn:${kind}`}
                  value={`searchIn:${kind}:${query}`}
                  onSelect={() =>
                    closeAnd(() =>
                      navigate(
                        `/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(kind)}`
                      )
                    )
                  }
                >
                  <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
                  <span className="truncate">
                    {t('nav:searchIn', { kind: t(KIND_LABEL_KEY[kind]), query })}
                  </span>
                </Command.Item>
              ))}

            {(contextActions.some((action) => matches(action.label)) || showDownload) && (
              <Command.Group heading={t('downloads:commands.actions')}>
                {contextActions
                  .filter((action) => matches(action.label))
                  .map((action) => (
                    <Command.Item
                      key={action.id}
                      disabled={action.disabled || runningActionId !== null}
                      onSelect={() => runContextAction(action)}
                    >
                      {action.icon ? (
                        <action.icon className="size-4 text-ink-faint" aria-hidden />
                      ) : (
                        <ArrowDownToLine className="size-4 text-ink-faint" aria-hidden />
                      )}
                      {action.label}
                    </Command.Item>
                  ))}
                {showDownload && (
                  <Command.Item onSelect={() => enterPage('download')}>
                    <ArrowDownToLine className="size-4 text-ink-faint" aria-hidden />
                    {t('downloads:commands.downloadRepository')}…
                  </Command.Item>
                )}
                {hasActive && matches(t('downloads:bulk.pauseAll')) && (
                  <Command.Item
                    disabled={bulkDownload.isPending}
                    onSelect={() => bulkDownload.mutate('downloads:pauseAll')}
                  >
                    <Pause className="size-4 text-ink-faint" aria-hidden />
                    {t('downloads:bulk.pauseAll')}
                  </Command.Item>
                )}
                {hasResumable && matches(t('downloads:bulk.resumeAll')) && (
                  <Command.Item
                    disabled={bulkDownload.isPending}
                    onSelect={() => bulkDownload.mutate('downloads:resumeAll')}
                  >
                    <Play className="size-4 text-ink-faint" aria-hidden />
                    {t('downloads:bulk.resumeAll')}
                  </Command.Item>
                )}
                {hasCompleted && matches(t('downloads:bulk.clearCompleted')) && (
                  <Command.Item
                    disabled={bulkDownload.isPending}
                    onSelect={() => bulkDownload.mutate('downloads:clearCompleted')}
                  >
                    <Trash2 className="size-4 text-ink-faint" aria-hidden />
                    {t('downloads:bulk.clearCompleted')}
                  </Command.Item>
                )}
              </Command.Group>
            )}

            {(visibleNav.length > 0 || showSettings) && (
              <Command.Group heading={t('nav:browse')}>
                {visibleNav.map((item) => (
                  <Command.Item key={item.to} onSelect={() => closeAnd(() => navigate(item.to))}>
                    <item.icon className="size-4 text-ink-faint" aria-hidden />
                    {item.label}
                  </Command.Item>
                ))}
                {showSettings && (
                  <Command.Item onSelect={() => closeAnd(() => openSettings())}>
                    <Settings className="size-4 text-ink-faint" aria-hidden />
                    {t('nav:settings')}
                  </Command.Item>
                )}
              </Command.Group>
            )}
            {(visibleFilterPages.length > 0 || showClear) && (
              <Command.Group heading={t('browse:filter.task')}>
                {visibleFilterPages.map((item) => (
                  <Command.Item key={item.page} onSelect={() => enterPage(item.page)}>
                    <item.icon className="size-4 text-ink-faint" aria-hidden />
                    {item.label}…
                  </Command.Item>
                ))}
                {showClear && (
                  <Command.Item onSelect={() => closeAnd(() => resetFilters(browseKind))}>
                    <Filter className="size-4 text-ink-faint" aria-hidden />
                    {t('browse:filter.clear')}
                  </Command.Item>
                )}
              </Command.Group>
            )}
            {visibleThemes.length > 0 && (
              <Command.Group heading={t('common:theme.label')}>
                {visibleThemes.map((item) => (
                  <Command.Item
                    key={item.theme}
                    onSelect={() => closeAnd(() => void updateSettings({ theme: item.theme }))}
                  >
                    <item.icon className="size-4 text-ink-faint" aria-hidden />
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {showShortcuts && (
              <Command.Item onSelect={() => closeAnd(() => setShortcutsOpen(true))}>
                <Keyboard className="size-4 text-ink-faint" aria-hidden />
                {t('nav:shortcuts')}
              </Command.Item>
            )}
          </>
        )}

        {page === 'download' && (
          <>
            {needle === '' && (
              <div className="px-3 py-6 text-center text-[13px] text-ink-muted">
                {t('downloads:commands.typeToSearch')}
              </div>
            )}
            {needle !== '' && search.isLoading && (
              <Command.Loading>
                <div className="flex items-center gap-2.5 px-2 py-2 text-[13px] text-ink-muted">
                  <Loader2 className="size-4 shrink-0 animate-spin text-ink-faint" aria-hidden />
                  {t('nav:searching')}
                </div>
              </Command.Loading>
            )}
            {needle !== '' &&
              !search.isLoading &&
              SEARCH_GROUPS.map(([group, kind]) =>
                search[group].length > 0 ? (
                  <Command.Group key={`download:${group}`} heading={t(KIND_LABEL_KEY[kind])}>
                    {search[group].map((repo) => (
                      <RepoResultItem
                        key={repo.id}
                        repo={repo}
                        locale={locale}
                        disabled={startDownload.isPending}
                        onSelect={() => startDownload.mutate(repo)}
                      />
                    ))}
                  </Command.Group>
                ) : null
              )}
            {startDownload.isPending && (
              <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-ink-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {t('downloads:commands.starting')}
              </div>
            )}
          </>
        )}

        {page === 'task' &&
          TASKS.filter((task) => matches(task)).map((task) => (
            <Command.Item
              key={task}
              onSelect={() => applyFilter(browseKind, { pipelineTag: task })}
            >
              {task}
            </Command.Item>
          ))}
        {page === 'library' &&
          LIBRARIES.filter((lib) => matches(lib)).map((lib) => (
            <Command.Item key={lib} onSelect={() => applyFilter(browseKind, { library: lib })}>
              {lib}
            </Command.Item>
          ))}
        {page === 'license' &&
          LICENSES.filter((license) => matches(license)).map((license) => (
            <Command.Item key={license} onSelect={() => applyFilter(browseKind, { license })}>
              {license}
            </Command.Item>
          ))}
        {page === 'params' &&
          PARAM_BUCKETS.filter((bucket) => matches(t(`browse:params.${bucket}`))).map((bucket) => (
            <Command.Item
              key={bucket}
              onSelect={() => applyFilter(browseKind, { paramBucket: bucket as ParamBucket })}
            >
              {t(`browse:params.${bucket}`)}
            </Command.Item>
          ))}
        {page === 'sort' &&
          sorts
            .filter((sort) => matches(t(`browse:sort.${sort}`)))
            .map((sort) => (
              <Command.Item key={sort} onSelect={() => applyFilter(browseKind, { sort })}>
                {t(`browse:sort.${sort}`)}
              </Command.Item>
            ))}
      </Command.List>

      <div className="flex items-center gap-4 border-t bg-panel/50 px-3 py-2 text-[11px] text-ink-faint">
        <span className="flex items-center gap-1.5">
          <Kbd>{KEY_UP}</Kbd>
          <Kbd>{KEY_DOWN}</Kbd>
          {t('nav:palette.navigate', 'Navigate')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>{KEY_ENTER}</Kbd>
          {t('nav:palette.select', 'Select')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>{KEY_ESC}</Kbd>
          {t('nav:palette.close', 'Close')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>?</Kbd>
          {t('nav:shortcuts')}
        </span>
      </div>
    </Command.Dialog>
  )
}

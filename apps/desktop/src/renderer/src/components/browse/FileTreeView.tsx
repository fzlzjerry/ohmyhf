import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  ChevronRight,
  File,
  FileSearch,
  Folder,
  Share,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  X
} from 'lucide-react'
import type {
  ExportIntegrationTask,
  ExportTool,
  FileTreeEntry,
  RepoKind,
  RepoRevisionSelection,
  SecurityEvidenceStatus
} from '@oh-my-huggingface/shared'
import { normalizeHubEndpoint } from '@oh-my-huggingface/shared'
import { describeError } from '@/lib/errors'
import { invoke } from '@/lib/ipc'
import { cn, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryErrorState } from '@/components/errors/QueryErrorState'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useToasts } from '@/components/ui/toaster'
import { useCommandActions } from '@/hooks/use-command-actions'
import {
  downloadBlockedByCapacity,
  estimatedWriteBytes,
  isDiskCapacityError,
  useDownloadCapacity
} from '@/hooks/use-download-capacity'
import { useAppStore } from '@/stores/app'
import { FilePreview } from '@/components/browse/FilePreview'
import { useSecurityGate } from '@/hooks/use-security-gate'

const TOOL_LABELS: Record<ExportTool, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  comfyui: 'ComfyUI'
}

/**
 * File types each target ingests (mirrors main/integrations/export.ts):
 * Ollama builds from a single GGUF, LM Studio's models dir loads GGUF, and
 * ComfyUI's models/* folders take the usual weight formats.
 */
const TOOL_EXTENSIONS: Record<ExportTool, string[]> = {
  ollama: ['.gguf'],
  lmstudio: ['.gguf'],
  comfyui: ['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf']
}

const TREE_WIDTH_KEY = 'omh:file-tree-width'
export const FILE_TREE_MIN_WIDTH = 256
export const FILE_TREE_MAX_WIDTH = 560
export const FILE_TREE_DEFAULT_WIDTH = 336

/** Export tools that can ingest the given file, by extension. */
export function exportToolsFor(name: string): ExportTool[] {
  const lower = name.toLowerCase()
  return (Object.keys(TOOL_EXTENSIONS) as ExportTool[]).filter((tool) =>
    TOOL_EXTENSIONS[tool].some((ext) => lower.endsWith(ext))
  )
}

export function clampFileTreeWidth(value: number): number {
  return Math.min(FILE_TREE_MAX_WIDTH, Math.max(FILE_TREE_MIN_WIDTH, Math.round(value)))
}

function readFileTreeWidth(): number {
  try {
    const raw = localStorage.getItem(TREE_WIDTH_KEY)
    if (raw === null) return FILE_TREE_DEFAULT_WIDTH
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampFileTreeWidth(parsed) : FILE_TREE_DEFAULT_WIDTH
  } catch {
    return FILE_TREE_DEFAULT_WIDTH
  }
}

function persistFileTreeWidth(width: number): void {
  try {
    localStorage.setItem(TREE_WIDTH_KEY, String(width))
  } catch {
    /* ignore quota / private-mode failures */
  }
}

/** Flatten a cached snapshot into the current directory listing. */
export function treeFromSnapshot(
  files: Array<{ path: string; size: number }>,
  path: string
): FileTreeEntry[] {
  const prefix = path ? `${path}/` : ''
  const seen = new Set<string>()
  const entries: FileTreeEntry[] = []
  for (const file of files) {
    if (prefix !== '' && !file.path.startsWith(prefix)) continue
    const rest = prefix === '' ? file.path : file.path.slice(prefix.length)
    if (rest === '') continue
    const slash = rest.indexOf('/')
    const nested = slash !== -1
    const name = nested ? rest.slice(0, slash) : rest
    const entryPath = prefix === '' ? name : `${path}/${name}`
    if (seen.has(entryPath)) continue
    seen.add(entryPath)
    entries.push({
      type: nested ? 'directory' : 'file',
      path: entryPath,
      size: nested ? 0 : file.size
    })
  }
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

function missingFileBytes(
  files: Array<{ path: string; size: number }>,
  cachedSizes: ReadonlyMap<string, number>
): number {
  let total = 0
  for (const file of files) {
    if (cachedSizes.get(file.path) !== file.size) total += file.size
  }
  return total
}

function FileSecurityIcon({
  status,
  message
}: {
  status: SecurityEvidenceStatus
  message?: string
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const label = t(`repro.security.status.${status}`)
  const Icon =
    status === 'safe' ? ShieldCheck : status === 'malicious' ? ShieldAlert : ShieldQuestion
  const tone =
    status === 'safe' ? 'text-success' : status === 'malicious' ? 'text-error' : 'text-warning'
  const detail = message ? `${label} · ${message}` : label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('inline-flex size-6 shrink-0 items-center justify-center', tone)}
          aria-label={detail}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  )
}

export function FileTreeView({
  kind,
  repoId,
  revision
}: {
  kind: RepoKind
  repoId: string
  revision: RepoRevisionSelection
}): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common', 'integrations', 'errors', 'downloads'])
  const [path, setPath] = useState('')
  // Selection is a full repo-relative path (plus the entry metadata the preview
  // header needs), independent of the browsed directory. It only resets when
  // repoId changes because the parent keys RepoDetail — and thus this
  // component — by repoId.
  const [selected, setSelected] = useState<FileTreeEntry | null>(null)
  const [checked, setChecked] = useState<Map<string, number>>(new Map())
  const [treeWidth, setTreeWidth] = useState(readFileTreeWidth)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const endpointKey = normalizeHubEndpoint(useAppStore((state) => state.settings.hubEndpoint))
  const openSettings = useAppStore((state) => state.openSettings)
  const push = useToasts((s) => s.push)
  const security = useSecurityGate()

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      dragRef.current = { startX: event.clientX, startWidth: treeWidth }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [treeWidth]
  )

  const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    setTreeWidth(
      clampFileTreeWidth(dragRef.current.startWidth + event.clientX - dragRef.current.startX)
    )
  }, [])

  const onResizePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  useEffect(() => {
    persistFileTreeWidth(treeWidth)
  }, [treeWidth])

  const tree = useQuery({
    queryKey: [
      'tree',
      endpointKey,
      kind,
      repoId,
      revision.requested,
      revision.resolvedCommit,
      path
    ],
    queryFn: async () => {
      try {
        const entries = await invoke('hub:fileTree', {
          kind,
          repoId,
          revision: revision.resolvedCommit,
          path: path || undefined
        })
        return { entries, source: 'hub' as const }
      } catch (err) {
        try {
          const snapshot = await invoke('cache:snapshot', {
            kind,
            repoId,
            commit: revision.resolvedCommit
          })
          if (snapshot) {
            return { entries: treeFromSnapshot(snapshot.files, path), source: 'cache' as const }
          }
        } catch {
          /* keep the Hub error */
        }
        throw err
      }
    }
  })
  const capacity = useDownloadCapacity()
  const cachedSnapshot = useQuery({
    queryKey: ['cache-snapshot', kind, repoId, revision.resolvedCommit],
    queryFn: () =>
      invoke('cache:snapshot', {
        kind,
        repoId,
        commit: revision.resolvedCommit
      }),
    staleTime: 30_000
  })
  const cachedSizes = useMemo(
    () => new Map((cachedSnapshot.data?.files ?? []).map((file) => [file.path, file.size])),
    [cachedSnapshot.data?.files]
  )
  const selectedRequiredBytes =
    selected?.type === 'file'
      ? estimatedWriteBytes(
          missingFileBytes([{ path: selected.path, size: selected.size }], cachedSizes),
          capacity.data
        )
      : undefined
  const selectedBlocked = downloadBlockedByCapacity(selectedRequiredBytes, capacity.data)
  const checkedFiles = [...checked].map(([filePath, size]) => ({ path: filePath, size }))
  const checkedRequiredBytes =
    checkedFiles.length > 0
      ? estimatedWriteBytes(missingFileBytes(checkedFiles, cachedSizes), capacity.data)
      : undefined
  const checkedBlocked = downloadBlockedByCapacity(checkedRequiredBytes, capacity.data)

  const targets = useQuery({
    queryKey: ['export-targets'],
    queryFn: () => invoke('export:targets', undefined),
    staleTime: 5 * 60_000
  })
  const integrationTasks = useQuery({
    queryKey: ['integration-tasks'],
    queryFn: () => invoke('integrationTasks:list', undefined),
    staleTime: Infinity
  })
  const activeExport = integrationTasks.data?.find(
    (task): task is ExportIntegrationTask =>
      task.kind === 'export' &&
      task.repoKind === kind &&
      task.repoId === repoId &&
      (task.status === 'preparing' || task.status === 'running')
  )

  const download = useMutation({
    mutationFn: async (files: string[]) => {
      const securityGrantId = await security.authorize({
        action: 'download',
        kind,
        repoId,
        revision: revision.requested,
        resolvedCommit: revision.resolvedCommit,
        files
      })
      return invoke('downloads:start', {
        request: {
          repoId,
          kind,
          revision: revision.requested,
          resolvedCommit: revision.resolvedCommit,
          files,
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
  const exportRun = useMutation({
    mutationFn: async (args: { tool: ExportTool; filePath: string }) => {
      const securityGrantId = await security.authorize({
        action: 'export',
        kind,
        repoId,
        revision: revision.requested,
        resolvedCommit: revision.resolvedCommit,
        files: [args.filePath]
      })
      return invoke('export:start', {
        request: {
          tool: args.tool,
          kind,
          repoId,
          filePath: args.filePath,
          revision: revision.requested,
          resolvedCommit: revision.resolvedCommit,
          securityGrantId
        }
      })
    },
    onSuccess: () => push(t('common:running'), 'info'),
    onError: (err) => push(describeError(t, err), 'error')
  })
  const cancelExport = useMutation({
    mutationFn: (id: string) => invoke('export:cancel', { id }),
    onError: (err) => push(describeError(t, err), 'error')
  })
  const fileCommands = useMemo(() => {
    if (!selected || selected.type !== 'file') return []
    const commands = [
      {
        id: `download-file:${kind}:${repoId}:${selected.path}`,
        label: t('downloads:commands.downloadSelectedFile', {
          file: selected.path.split('/').at(-1) ?? selected.path
        }),
        icon: ArrowDownToLine,
        disabled: download.isPending || selectedBlocked,
        run: async () => {
          await download.mutateAsync([selected.path])
        }
      }
    ]
    const supported = exportToolsFor(selected.path)
    for (const target of targets.data ?? []) {
      if (!target.detected || !supported.includes(target.tool)) continue
      commands.push({
        id: `export-file:${target.tool}:${kind}:${repoId}:${selected.path}`,
        label: t('detail:files.exportTo', { tool: TOOL_LABELS[target.tool] }),
        icon: Share,
        disabled: Boolean(activeExport) || exportRun.isPending,
        run: async () => {
          await exportRun.mutateAsync({ tool: target.tool, filePath: selected.path })
        }
      })
    }
    return commands
  }, [activeExport, download, exportRun, kind, repoId, selected, selectedBlocked, t, targets.data])
  useCommandActions('file-tree', fileCommands)

  const crumbs = path ? path.split('/') : []
  const treeEntries = tree.data?.entries
  const files = treeEntries?.filter((entry) => entry.type === 'file') ?? []
  const toggleChecked = (entry: FileTreeEntry): void => {
    if (entry.type !== 'file') return
    setChecked((prev) => {
      const next = new Map(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.set(entry.path, entry.size)
      return next
    })
  }

  // ArrowUp/Down moves the file selection within the current directory listing
  // when focus sits inside the tree (row buttons bubble here). Skip events a
  // descendant already claimed (e.g. the Radix dropdown trigger).
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (event.defaultPrevented || files.length === 0) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const index = files.findIndex((entry) => entry.path === selected?.path)
    const next =
      index === -1
        ? delta === 1
          ? 0
          : files.length - 1
        : Math.min(Math.max(index + delta, 0), files.length - 1)
    const entry = files[next]
    if (!entry) return
    setSelected(entry)
    event.currentTarget
      .querySelector(`[data-path="${CSS.escape(entry.path)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <div className="flex h-full min-w-0">
      {security.dialog}
      <div className="flex shrink-0 flex-col border-r" style={{ width: treeWidth }}>
        <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2 text-[12.5px] text-ink-muted">
          <button
            type="button"
            onClick={() => setPath('')}
            className="rounded px-1 hover:bg-panel hover:text-ink"
          >
            {t('detail:files.root')}
          </button>
          {tree.data?.source === 'cache' && (
            <span className="text-[11px] text-ink-faint">{t('detail:card.offline')}</span>
          )}
          {crumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="size-3 text-ink-faint" aria-hidden />
              <button
                type="button"
                onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
                className="rounded px-1 hover:bg-panel hover:text-ink"
              >
                {crumb}
              </button>
            </span>
          ))}
          <span className="nums ml-auto text-[11px] text-ink-faint">
            {capacity.data?.availableBytes === undefined
              ? t('downloads:capacity.availableUnknown')
              : t('downloads:capacity.available', {
                  size: formatBytes(capacity.data.availableBytes)
                })}
          </span>
        </div>
        {activeExport && (
          <div className="flex flex-col gap-1 border-b bg-panel px-3 py-2 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-ink-muted">
                {activeExport.filePath}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t('common:cancel')}
                loading={cancelExport.isPending}
                onClick={() => cancelExport.mutate(activeExport.id)}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
            <Progress
              value={activeExport.progress}
              indeterminate={activeExport.progress === undefined}
            />
          </div>
        )}
        {checked.size > 0 && (
          <div className="flex items-center gap-2 border-b px-3 py-1.5">
            <span className={cn('text-[11.5px]', checkedBlocked ? 'text-error' : 'text-ink-muted')}>
              {t('detail:files.selected', { count: checked.size })}
              {checkedRequiredBytes !== undefined ? ` · ${formatBytes(checkedRequiredBytes)}` : ''}
            </span>
            <Button
              variant="secondary"
              size="sm"
              loading={download.isPending}
              disabled={checkedBlocked}
              title={checkedBlocked ? t('downloads:capacity.insufficient') : undefined}
              onClick={() =>
                download.mutate([...checked.keys()], { onSuccess: () => setChecked(new Map()) })
              }
            >
              <ArrowDownToLine className="size-3.5" aria-hidden />
              {t('detail:files.downloadSelected')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setChecked(new Map())}>
              {t('detail:files.clearSelection')}
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" onKeyDown={onListKeyDown}>
          {tree.isLoading && (
            <div className="flex flex-col gap-1 p-1">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          )}
          {tree.isError && !tree.data && (
            <QueryErrorState
              compact
              error={tree.error}
              onRetry={() => void tree.refetch()}
              className="px-2"
            />
          )}
          {treeEntries?.length === 0 && (
            <div className="p-6 text-center text-[13px] text-ink-muted">
              {t('detail:files.empty')}
            </div>
          )}
          {treeEntries?.map((entry) => {
            const name = entry.path.split('/').at(-1) ?? entry.path
            const exportTools = exportToolsFor(name)
            const validTargets =
              targets.data?.filter(
                (target) => target.detected && exportTools.includes(target.tool)
              ) ?? []
            const isSelected = entry.type === 'file' && entry.path === selected?.path
            return (
              <div
                key={entry.path}
                data-path={entry.path}
                className={cn(
                  'group flex items-start gap-1.5 rounded-md px-2 py-1.5',
                  isSelected ? 'bg-select/10' : 'hover:bg-panel'
                )}
              >
                {entry.type === 'directory' ? (
                  <button
                    type="button"
                    onClick={() => setPath(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={name}
                  >
                    <Folder className="size-4 shrink-0 text-ink-muted" aria-hidden />
                    <span className="min-w-0 truncate text-[13px] font-medium">{name}</span>
                  </button>
                ) : (
                  <>
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 shrink-0 accent-select"
                      checked={checked.has(entry.path)}
                      aria-label={t('detail:files.selectFile', { file: name })}
                      onChange={() => toggleChecked(entry)}
                    />
                    <button
                      type="button"
                      onClick={() => setSelected(entry)}
                      className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                      title={entry.path}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <File
                          className={cn(
                            'size-4 shrink-0',
                            isSelected ? 'text-select' : 'text-ink-faint'
                          )}
                          aria-hidden
                        />
                        <span
                          className={cn(
                            'min-w-0 truncate font-mono text-[12.5px]',
                            isSelected && 'text-select'
                          )}
                        >
                          {name}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 pl-5 font-mono text-[11px] text-ink-faint">
                        {entry.lfs && <span>{t('detail:files.lfs')}</span>}
                        <span>{formatBytes(entry.size)}</span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {entry.security && (
                        <FileSecurityIcon
                          status={entry.security.status}
                          message={entry.security.message}
                        />
                      )}
                      {exportTools.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn(
                                'size-8 text-ink-faint',
                                !isSelected &&
                                  'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
                              )}
                              aria-label={t('detail:files.export')}
                              disabled={Boolean(activeExport) || exportRun.isPending}
                            >
                              <Share className="size-3.5" aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {targets.data && validTargets.length === 0 && (
                              <DropdownMenuItem disabled>
                                {t('detail:files.noTargets')}
                              </DropdownMenuItem>
                            )}
                            {validTargets.map((target) => (
                              <DropdownMenuItem
                                key={target.tool}
                                onSelect={() =>
                                  exportRun.mutate({ tool: target.tool, filePath: entry.path })
                                }
                              >
                                {t('detail:files.exportTo', { tool: TOOL_LABELS[target.tool] })}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'size-8 text-ink-faint',
                          !isSelected &&
                            'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
                        )}
                        aria-label={t('detail:files.download')}
                        title={
                          downloadBlockedByCapacity(
                            estimatedWriteBytes(
                              missingFileBytes(
                                [{ path: entry.path, size: entry.size }],
                                cachedSizes
                              ),
                              capacity.data
                            ),
                            capacity.data
                          )
                            ? t('downloads:capacity.insufficient')
                            : undefined
                        }
                        loading={download.isPending}
                        disabled={downloadBlockedByCapacity(
                          estimatedWriteBytes(
                            missingFileBytes([{ path: entry.path, size: entry.size }], cachedSizes),
                            capacity.data
                          ),
                          capacity.data
                        )}
                        onClick={() => download.mutate([entry.path])}
                      >
                        <ArrowDownToLine className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('detail:files.resize')}
        aria-valuemin={FILE_TREE_MIN_WIDTH}
        aria-valuemax={FILE_TREE_MAX_WIDTH}
        aria-valuenow={treeWidth}
        tabIndex={0}
        className="group/resize relative z-10 -ml-px w-2 shrink-0 cursor-col-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            const delta = event.key === 'ArrowRight' ? 16 : -16
            setTreeWidth((width) => clampFileTreeWidth(width + delta))
          }
        }}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover/resize:bg-select group-focus-visible/resize:bg-select" />
      </div>

      {targets.isError && (
        <QueryErrorState
          compact
          error={targets.error}
          onRetry={() => void targets.refetch()}
          title={t('integrations:export.targetsError')}
          className="min-w-0 flex-1"
        />
      )}

      {!targets.isError && selected ? (
        <div className="min-w-0 flex-1">
          <FilePreview
            key={selected.path}
            kind={kind}
            repoId={repoId}
            revision={revision}
            entry={selected}
            onDownload={() => {
              if (selectedBlocked) {
                push(t('downloads:capacity.insufficient'), 'error', {
                  action: {
                    label: t('downloads:capacity.openSettings'),
                    onClick: () => openSettings('downloads')
                  }
                })
                return
              }
              download.mutate([selected.path])
            }}
            downloading={download.isPending}
          />
        </div>
      ) : !targets.isError ? (
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <EmptyState
            icon={FileSearch}
            title={t('detail:preview.pickFile')}
            body={t('detail:preview.pickFileBody')}
          />
        </div>
      ) : null}
    </div>
  )
}

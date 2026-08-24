import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Database, ExternalLink } from 'lucide-react'
import type { DatasetRows, RepoRevisionSelection } from '@oh-my-huggingface/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { hubRepoUrl, normalizeHubEndpoint } from '@oh-my-huggingface/shared'
import { useAppStore } from '@/stores/app'

const PAGE_SIZE = 25

function Unavailable({ repoId }: { repoId: string }): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <Database className="size-8 text-ink-faint" aria-hidden />
      <p className="max-w-96 text-[12.5px] text-ink-muted">
        {t('detail:datasetPreview.unavailable')}
      </p>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => openExternal(hubRepoUrl('dataset', repoId, endpoint))}
      >
        <ExternalLink className="size-3.5" aria-hidden />
        {t('common:openOnHub')}
      </Button>
    </div>
  )
}

function TableSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 p-3">
      <Skeleton className="h-7" />
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="h-6" />
      ))}
    </div>
  )
}

function RowsTable({
  columns,
  rows,
  dim
}: {
  columns: string[]
  rows: string[][]
  dim?: boolean
}): React.JSX.Element {
  return (
    <table
      className={cn(
        'w-full border-collapse font-mono text-[12px] transition-opacity duration-150',
        dim && 'opacity-60'
      )}
    >
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col}
              className="sticky top-0 z-10 border-b border-border-card bg-panel px-3 py-2 text-left text-[11px] font-medium whitespace-nowrap text-ink-muted"
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr
            key={i}
            className="border-b border-border-card align-top last:border-b-0 hover:bg-panel/60"
          >
            {row.map((cell, j) => (
              <td key={j} className="px-3 py-1.5">
                <div className="max-w-80 truncate" title={cell}>
                  {cell}
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * When the datasets-server viewer is unavailable (huge datasets, failed
 * builds, some gated repos), fall back to the SSR sample rows the Hub itself
 * shows on the dataset page. Only when the page carries no sample either do
 * we declare the preview unavailable.
 */
function SampleFallback({ repoId }: { repoId: string }): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const endpointKey = normalizeHubEndpoint(endpoint)
  const sample = useQuery({
    queryKey: ['datasetSampleRows', repoId, endpointKey],
    queryFn: () => invoke('hub:datasetSampleRows', { repoId }),
    retry: false
  })

  if (sample.isPending) return <TableSkeleton />
  if (sample.isError || sample.data === null || sample.data === undefined) {
    return <Unavailable repoId={repoId} />
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b bg-panel/60 px-3 py-1.5 text-[12px] text-ink-muted">
        {t('detail:datasetPreview.sampleNote', { count: sample.data.rows.length })}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <RowsTable columns={sample.data.columns} rows={sample.data.rows} />
      </div>
    </div>
  )
}

function DefaultDatasetPreview({ repoId }: { repoId: string }): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const endpointKey = normalizeHubEndpoint(endpoint)
  const [config, setConfig] = useState<string | null>(null)
  const [split, setSplit] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  const splits = useQuery({
    queryKey: ['datasetSplits', repoId, endpointKey],
    queryFn: () => invoke('hub:datasetSplits', { repoId }),
    retry: false
  })

  const configs = useMemo(
    () => [...new Set((splits.data ?? []).map((s) => s.config))],
    [splits.data]
  )
  const activeConfig = config && configs.includes(config) ? config : configs[0]
  const splitOptions = useMemo(
    () => (splits.data ?? []).filter((s) => s.config === activeConfig).map((s) => s.split),
    [splits.data, activeConfig]
  )
  const activeSplit = split && splitOptions.includes(split) ? split : splitOptions[0]

  const rows = useQuery({
    queryKey: ['datasetRows', repoId, activeConfig, activeSplit, page, endpointKey],
    queryFn: () =>
      invoke('hub:datasetRows', {
        repoId,
        config: activeConfig ?? '',
        split: activeSplit ?? '',
        offset: page * PAGE_SIZE,
        length: PAGE_SIZE
      }),
    enabled: Boolean(activeConfig && activeSplit),
    placeholderData: keepPreviousData,
    // One quick retry absorbs transient blips (429s, network hiccups) while paginating.
    retry: 1
  })

  // Last rows actually fetched for this repo (placeholders excluded so a repo
  // switch can't leak the previous repo's rows). Kept so a failed page fetch
  // degrades to an inline retry banner instead of tearing the viewer down.
  const [lastGood, setLastGood] = useState<{ repoId: string; data: DatasetRows } | null>(null)
  if (rows.data && !rows.isPlaceholderData && rows.data !== lastGood?.data) {
    setLastGood({ repoId, data: rows.data })
  }
  const displayRows =
    rows.data ?? (rows.isError && lastGood?.repoId === repoId ? lastGood.data : undefined)

  if (splits.isError) return <SampleFallback repoId={repoId} />
  if (splits.isPending) return <TableSkeleton />
  if (splits.data.length === 0) return <SampleFallback repoId={repoId} />
  // The sample fallback is reserved for initial unavailability — the viewer has
  // never shown anything, so there is nothing to keep mounted.
  if (rows.isError && !displayRows) return <SampleFallback repoId={repoId} />

  const from = page * PAGE_SIZE + 1
  const to = page * PAGE_SIZE + (rows.data?.rows.length ?? 0)
  const total = rows.data?.total
  const hasNext = total !== undefined ? to < total : (rows.data?.rows.length ?? 0) === PAGE_SIZE

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Select
          value={activeConfig}
          onValueChange={(v) => {
            setConfig(v)
            setSplit(null)
            setPage(0)
          }}
        >
          <SelectTrigger className="min-w-32" aria-label={t('datasetPreview.config')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {configs.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={activeSplit}
          onValueChange={(v) => {
            setSplit(v)
            setPage(0)
          }}
        >
          <SelectTrigger className="min-w-28" aria-label={t('datasetPreview.split')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {splitOptions.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {rows.isError && (
        <div className="flex items-center justify-between gap-2 border-b bg-panel/60 px-3 py-1.5">
          <span className="text-[12px] text-ink-muted">{t('datasetPreview.rowsError')}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={rows.isFetching}
            onClick={() => void rows.refetch()}
          >
            {t('common:retry')}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.isPending && <TableSkeleton />}
        {displayRows && (
          <RowsTable
            columns={displayRows.columns}
            rows={displayRows.rows}
            dim={rows.isPlaceholderData || rows.isError}
          />
        )}
      </div>

      {displayRows && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5">
          <span className="text-[12px] text-ink-muted">
            {/* Range is derived from the live page; hide it while stale rows are shown. */}
            {rows.data &&
              (total !== undefined
                ? t('datasetPreview.range', { from, to, total })
                : t('datasetPreview.rangeNoTotal', { from, to }))}
          </span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('datasetPreview.prev')}
              disabled={page === 0 || rows.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('datasetPreview.next')}
              disabled={!hasNext || rows.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function DatasetPreview({
  repoId,
  revision,
  defaultRevision,
  onSelectRevision
}: {
  repoId: string
  revision: RepoRevisionSelection
  defaultRevision?: string
  onSelectRevision: (revision: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('common')
  if (!revision.isDefault) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Database className="size-8 text-warning" aria-hidden />
        <p className="max-w-lg text-[12.5px] text-ink-muted">
          {t('repro.dataset.revisionUnavailable', {
            commit: revision.resolvedCommit.slice(0, 8)
          })}
        </p>
        {defaultRevision && (
          <Button variant="secondary" size="sm" onClick={() => onSelectRevision(defaultRevision)}>
            {t('repro.dataset.switchDefaultRevision', { revision: defaultRevision })}
          </Button>
        )}
      </div>
    )
  }
  return <DefaultDatasetPreview key={revision.resolvedCommit} repoId={repoId} />
}

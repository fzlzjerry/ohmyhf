import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileQuestion } from 'lucide-react'
import type { RepoKind } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'
import { useResolvedRepoCommit } from '@/components/browse/revision-context'

const PAGE_SIZE = 25
/** Prefix window for Arrow IPC / Feather files (under hub:fileRange's 64 MiB cap). */
const MAX_ARROW_BYTES = 16 * 1024 * 1024

interface ArrowPreviewProps {
  kind: RepoKind
  repoId: string
  path: string
  size: number
  onDownload: () => void
  downloading: boolean
}

interface ArrowTablePreview {
  columns: string[]
  rows: string[][]
  numRows: number
  truncatedFile: boolean
}

function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
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

export function ArrowPreview({
  kind,
  repoId,
  path,
  size,
  onDownload,
  downloading
}: ArrowPreviewProps): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpointKey = useHubEndpointKey()
  const revision = useResolvedRepoCommit()
  const [page, setPage] = useState(0)

  const table = useQuery<ArrowTablePreview>({
    queryKey: ['arrowPreview', endpointKey, kind, repoId, revision, path, size],
    retry: false,
    queryFn: async () => {
      const end = Math.min(size, MAX_ARROW_BYTES) - 1
      if (end < 0) throw new Error('empty arrow file')
      const bytes = await invoke('hub:fileRange', { kind, repoId, path, revision, start: 0, end })
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const { tableFromIPC } = await import('apache-arrow')
      const arrow = tableFromIPC(copy.buffer)
      const columns = arrow.schema.fields.map((f) => f.name)
      const numRows = arrow.numRows
      const rows: string[][] = []
      const limit = Math.min(numRows, PAGE_SIZE * 40)
      const children = columns.map((col) => arrow.getChild(col))
      for (let i = 0; i < limit; i++) {
        rows.push(children.map((col) => cellText(col?.get(i))))
      }
      return {
        columns,
        rows,
        numRows,
        truncatedFile: size > MAX_ARROW_BYTES
      }
    }
  })

  if (table.isPending) return <TableSkeleton />
  if (table.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={FileQuestion}
          title={t('detail:arrowPreview.unreadableTitle')}
          body={t('detail:arrowPreview.unreadableBody')}
          action={
            <Button variant="secondary" size="sm" loading={downloading} onClick={onDownload}>
              <ArrowDownToLine className="size-3.5" aria-hidden />
              {t('detail:files.download')}
            </Button>
          }
        />
      </div>
    )
  }

  const { columns, rows, numRows, truncatedFile } = table.data
  const from = page * PAGE_SIZE
  const pageRows = rows.slice(from, from + PAGE_SIZE)
  const to = Math.min(rows.length, from + PAGE_SIZE)
  const hasNext = to < rows.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b px-4 py-2 text-[12px]">
        <span className="text-ink-muted">{t('detail:arrowPreview.rows', { count: numRows })}</span>
        <span className="text-ink-muted">
          {t('detail:arrowPreview.columns', { count: columns.length })}
        </span>
        <span className="text-ink-faint">{formatBytes(size)}</span>
      </div>
      {truncatedFile && (
        <div className="border-b bg-warning/10 px-3 py-1.5 text-[12px] text-ink-muted">
          {t('detail:arrowPreview.prefixOnly', { size: formatBytes(MAX_ARROW_BYTES) })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px]">
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
            {pageRows.map((row, i) => (
              <tr
                key={from + i}
                className="border-b border-border-card align-top last:border-b-0 hover:bg-panel/60"
              >
                {row.map((cell, ci) => (
                  <td key={ci} className="max-w-80 truncate px-3 py-1.5" title={cell}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5">
        <span className="text-[12px] text-ink-muted">
          {rows.length > 0 &&
            t('detail:datasetPreview.range', { from: from + 1, to, total: rows.length })}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('detail:datasetPreview.prev')}
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('detail:datasetPreview.next')}
            disabled={!hasNext}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}

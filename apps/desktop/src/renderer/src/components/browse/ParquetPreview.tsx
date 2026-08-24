import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileQuestion } from 'lucide-react'
import type { AsyncBuffer, FileMetaData } from 'hyparquet'
import type { RepoKind } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import {
  bytesToDataUri,
  formatParquetCell,
  imageMimeOfBytes,
  isUnsupportedCodecError
} from '@/lib/parquet'
import { cn, formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Lightbox } from '@/components/ui/lightbox'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'
import { useResolvedRepoCommit } from '@/components/browse/revision-context'

const PAGE_SIZE = 25

/** Skip thumbnailing images larger than this to keep the table light. */
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

function ParquetCell({
  value,
  onZoom
}: {
  value: unknown
  onZoom: (src: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('common')
  if (value instanceof Uint8Array && value.byteLength <= MAX_THUMBNAIL_BYTES) {
    const mime = imageMimeOfBytes(value)
    if (mime) {
      const src = bytesToDataUri(value, mime)
      return (
        <button
          type="button"
          aria-label={t('common:zoomImage')}
          className="max-h-16 max-w-32 cursor-zoom-in rounded outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          onClick={() => onZoom(src)}
        >
          <img
            src={src}
            alt=""
            className="max-h-16 max-w-32 rounded border border-border-card bg-white object-contain"
          />
        </button>
      )
    }
  }
  const text = formatParquetCell(value)
  return (
    <div className="max-w-80 truncate" title={text}>
      {text}
    </div>
  )
}

interface ParquetPreviewProps {
  kind: RepoKind
  repoId: string
  path: string
  /** File size from the tree entry; lets the AsyncBuffer skip a HEAD request. */
  size: number
  onDownload: () => void
  downloading: boolean
}

/**
 * AsyncBuffer whose slices are served by the authenticated main-process range
 * reader, so a large columnar file previews by fetching only its footer plus
 * the visible rows (never the whole file), and private/gated repos work because
 * the token stays in the main process. `slice` end is exclusive (JS convention);
 * the IPC contract is inclusive (HTTP Range), hence `end - 1`.
 */
function makeAsyncBuffer(
  kind: RepoKind,
  repoId: string,
  revision: string,
  path: string,
  byteLength: number
): AsyncBuffer {
  return {
    byteLength,
    async slice(start, end) {
      const s = Math.max(0, start < 0 ? byteLength + start : start)
      const e = Math.min(
        byteLength,
        end === undefined ? byteLength : end < 0 ? byteLength + end : end
      )
      if (e <= s) return new ArrayBuffer(0)
      const bytes = await invoke('hub:fileRange', {
        kind,
        repoId,
        path,
        revision,
        start: s,
        end: e - 1
      })
      // Copy into a fresh, exact ArrayBuffer (the view may sit inside a larger one).
      const out = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(out).set(bytes)
      return out
    }
  }
}

interface ParquetInfo {
  file: AsyncBuffer
  metadata: FileMetaData
  columns: string[]
  numRows: number
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

export function ParquetPreview({
  kind,
  repoId,
  path,
  size,
  onDownload,
  downloading
}: ParquetPreviewProps): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpointKey = useHubEndpointKey()
  const revision = useResolvedRepoCommit()
  const [page, setPage] = useState(0)
  const [lightbox, setLightbox] = useState<string>()

  const file = useMemo(
    () => makeAsyncBuffer(kind, repoId, revision, path, size),
    [kind, repoId, revision, path, size]
  )

  // Footer read only: schema + row count, no page data decompressed.
  const info = useQuery<ParquetInfo>({
    queryKey: ['parquetMeta', endpointKey, kind, repoId, revision, path, size],
    queryFn: async () => {
      const { parquetMetadataAsync, parquetSchema } = await import('hyparquet')
      const metadata = await parquetMetadataAsync(file)
      const schema = parquetSchema(metadata)
      const columns = schema.children.map((c) => c.element.name)
      return { file, metadata, columns, numRows: Number(metadata.num_rows) }
    },
    retry: false
  })

  const rows = useQuery<Record<string, unknown>[]>({
    queryKey: ['parquetRows', endpointKey, kind, repoId, revision, path, size, page],
    enabled: info.isSuccess,
    placeholderData: keepPreviousData,
    retry: false,
    queryFn: async () => {
      // Only hyparquet core (pure JS) — it decodes uncompressed + snappy, the
      // Hub's default codec. We deliberately do NOT pull in hyparquet-compressors:
      // its SNAPPY decoder instantiates WebAssembly at import time, which the
      // renderer CSP (script-src 'self', no wasm-unsafe-eval) blocks. Files using
      // a codec hyparquet can't decode throw "unsupported compression codec",
      // which surfaces as the download prompt below.
      const { parquetReadObjects } = await import('hyparquet')
      const data = info.data!
      return parquetReadObjects({
        file: data.file,
        metadata: data.metadata,
        // Decode by the column's logical type: real string columns stay strings,
        // raw BYTE_ARRAY columns come back as bytes (rendered as a thumbnail or a
        // "<N bytes>" label) instead of being force-decoded into UTF-8 garbage.
        utf8: false,
        rowStart: page * PAGE_SIZE,
        rowEnd: Math.min(data.numRows, (page + 1) * PAGE_SIZE)
      })
    }
  })

  if (info.isPending) return <TableSkeleton />
  if (info.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={FileQuestion}
          title={t('detail:parquetPreview.unreadableTitle')}
          body={t('detail:parquetPreview.unreadableBody')}
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

  const { columns, numRows } = info.data
  const from = page * PAGE_SIZE + 1
  const to = Math.min(numRows, (page + 1) * PAGE_SIZE)
  const hasNext = to < numRows
  const rowsUnsupported = rows.isError && isUnsupportedCodecError(rows.error.message)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b px-4 py-2 text-[12px]">
        <span className="text-ink-muted">
          {t('detail:parquetPreview.rows', { count: numRows })}
        </span>
        <span className="text-ink-muted">
          {t('detail:parquetPreview.columns', { count: columns.length })}
        </span>
        <span className="text-ink-faint">{formatBytes(size)}</span>
      </div>

      {rows.isError && (
        <div className="flex items-center justify-between gap-2 border-b bg-panel/60 px-3 py-1.5">
          <span className="text-[12px] text-ink-muted">
            {rowsUnsupported
              ? t('detail:parquetPreview.unsupportedCodec')
              : t('detail:datasetPreview.rowsError')}
          </span>
          {rowsUnsupported ? (
            <Button variant="secondary" size="sm" loading={downloading} onClick={onDownload}>
              {t('detail:files.download')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={rows.isFetching}
              onClick={() => void rows.refetch()}
            >
              {t('common:retry')}
            </Button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.isPending && <TableSkeleton />}
        {rows.data && (
          <table
            className={cn(
              'w-full border-collapse font-mono text-[12px] transition-opacity duration-150',
              (rows.isPlaceholderData || rows.isError) && 'opacity-60'
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
              {rows.data.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-border-card align-top last:border-b-0 hover:bg-panel/60"
                >
                  {columns.map((col) => (
                    <td key={col} className="px-3 py-1.5">
                      <ParquetCell value={row[col]} onZoom={setLightbox} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5">
        <span className="text-[12px] text-ink-muted">
          {numRows > 0 && t('detail:datasetPreview.range', { from, to, total: numRows })}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('detail:datasetPreview.prev')}
            disabled={page === 0 || rows.isFetching}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('detail:datasetPreview.next')}
            disabled={!hasNext || rows.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <Lightbox src={lightbox} onClose={() => setLightbox(undefined)} />
    </div>
  )
}

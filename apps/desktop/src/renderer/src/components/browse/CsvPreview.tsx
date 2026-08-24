import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { RepoKind } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { codeLanguageOf } from '@/lib/file-kinds'
import { delimiterOf, parseCsvPreview } from '@/lib/csv'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { CodeBlock } from '@/components/browse/CodeBlock'
import { Scissors } from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'
import { useResolvedRepoCommit } from '@/components/browse/revision-context'

const MAX_TEXT_BYTES = 512 * 1024
const PAGE_SIZE = 25

interface CsvPreviewProps {
  kind: RepoKind
  repoId: string
  path: string
}

function LoadingBlock(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 p-4">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

export function CsvPreview({ kind, repoId, path }: CsvPreviewProps): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpointKey = useHubEndpointKey()
  const revision = useResolvedRepoCommit()
  const [page, setPage] = useState(0)

  const text = useQuery({
    queryKey: ['fileText', endpointKey, kind, repoId, revision, path],
    queryFn: () =>
      invoke('hub:fileText', { kind, repoId, path, revision, maxBytes: MAX_TEXT_BYTES }),
    retry: false
  })

  const table = useMemo(() => {
    if (!text.data) return null
    try {
      return parseCsvPreview(text.data.content, delimiterOf(path))
    } catch {
      return null
    }
  }, [text.data, path])

  if (text.isPending) return <LoadingBlock />
  if (text.isError) {
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="max-w-96 text-[13px] text-ink-muted">{text.error.message}</p>
        <Button size="sm" onClick={() => void text.refetch()}>
          {t('common:retry')}
        </Button>
      </div>
    )
  }

  // Unparseable or header-less: fall back to the raw source view.
  if (!table || table.columns.length === 0) {
    return (
      <>
        {text.data.truncated && (
          <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-[12px]">
            <Scissors className="size-3.5 shrink-0 text-warning" aria-hidden />
            {t('detail:preview.truncated', { size: formatBytes(MAX_TEXT_BYTES) })}
          </div>
        )}
        <div className="p-3">
          <div className="overflow-hidden rounded-lg border border-border-card bg-panel [&_pre]:overflow-x-auto [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-relaxed [&_.shiki]:bg-transparent!">
            <CodeBlock key={path} code={text.data.content} language={codeLanguageOf(path)} />
          </div>
        </div>
      </>
    )
  }

  const { columns, rows } = table
  const from = page * PAGE_SIZE
  const pageRows = rows.slice(from, from + PAGE_SIZE)
  const to = Math.min(rows.length, from + PAGE_SIZE)
  const hasNext = to < rows.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {text.data.truncated && (
        <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-[12px]">
          <Scissors className="size-3.5 shrink-0 text-warning" aria-hidden />
          {t('detail:preview.truncated', { size: formatBytes(MAX_TEXT_BYTES) })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b px-4 py-2 text-[12px]">
        <span className="text-ink-muted">
          {t('detail:csvPreview.rows', { count: rows.length })}
        </span>
        <span className="text-ink-muted">
          {t('detail:csvPreview.columns', { count: columns.length })}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th
                  key={`${col}-${i}`}
                  className="sticky top-0 z-10 border-b border-border-card bg-panel px-3 py-2 text-left text-[11px] font-medium whitespace-nowrap text-ink-muted"
                >
                  {col || t('detail:csvPreview.emptyHeader', { index: i + 1 })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr
                key={from + ri}
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

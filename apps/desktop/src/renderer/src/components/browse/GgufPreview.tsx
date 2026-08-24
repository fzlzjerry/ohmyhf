import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, FileQuestion } from 'lucide-react'
import type { RepoKind } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { toGgufPreviewData } from '@/lib/gguf'
import { formatBytes } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'
import { useResolvedRepoCommit } from '@/components/browse/revision-context'

const MAX_GGUF_HEADER_BYTES = 8 * 1024 * 1024

interface GgufPreviewProps {
  kind: RepoKind
  repoId: string
  path: string
  size: number
  onDownload: () => void
  downloading: boolean
}

export function GgufPreview({
  kind,
  repoId,
  path,
  size,
  onDownload,
  downloading
}: GgufPreviewProps): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpointKey = useHubEndpointKey()
  const revision = useResolvedRepoCommit()

  const header = useQuery({
    queryKey: ['ggufHeader', endpointKey, kind, repoId, revision, path, size],
    retry: false,
    queryFn: async () => {
      const end = Math.min(size, MAX_GGUF_HEADER_BYTES) - 1
      if (end < 0) throw new Error('empty gguf file')
      const bytes = await invoke('hub:fileRange', { kind, repoId, path, revision, start: 0, end })
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const { ggufMetadata } = await import('hyllama')
      return toGgufPreviewData(ggufMetadata(copy.buffer))
    }
  })

  if (header.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-10 w-2/3" />
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-6" />
        ))}
      </div>
    )
  }

  if (header.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={FileQuestion}
          title={t('detail:ggufPreview.unreadableTitle')}
          body={t('detail:ggufPreview.unreadableBody')}
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

  const { metadata, tensors } = header.data
  const highlights = [
    'general.architecture',
    'general.name',
    'general.file_type',
    'general.quantization_version'
  ]
    .map((key) => (metadata[key] != null ? ([key, metadata[key]!] as const) : null))
    .filter((x): x is readonly [string, string] => x != null)

  const metaEntries = Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b px-4 py-3">
        <div>
          <div className="text-[11px] font-medium text-ink-faint">
            {t('detail:preview.tensors')}
          </div>
          <div className="nums font-mono text-[15px] font-semibold text-ink-strong">
            {tensors.length}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium text-ink-faint">
            {t('detail:ggufPreview.size')}
          </div>
          <div className="nums font-mono text-[15px] font-semibold text-ink-strong">
            {formatBytes(size)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {highlights.map(([key, value]) => (
            <Badge key={key} variant="outline" className="font-mono text-[10.5px]">
              {`${key.replace(/^general\./, '')} · ${value}`}
            </Badge>
          ))}
        </div>
      </div>

      {metaEntries.length > 0 && (
        <div className="max-h-40 overflow-auto border-b px-4 py-2">
          <table className="w-full table-fixed border-collapse font-mono text-[11.5px]">
            <tbody>
              {metaEntries.map(([key, value]) => (
                <tr key={key} className="border-b border-border-card/60 last:border-b-0">
                  <td className="w-1/3 truncate py-0.5 pr-3 text-ink-muted" title={key}>
                    {key}
                  </td>
                  <td className="truncate py-0.5 text-ink" title={value}>
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse font-mono text-[12px]">
          <thead>
            <tr className="text-left">
              <th className="sticky top-0 z-10 border-b bg-panel px-4 py-2 text-[11px] font-medium text-ink-muted">
                {t('detail:preview.colTensor')}
              </th>
              <th className="sticky top-0 z-10 w-24 border-b bg-panel px-3 py-2 text-[11px] font-medium text-ink-muted">
                {t('detail:preview.colDtype')}
              </th>
              <th className="sticky top-0 z-10 w-56 border-b bg-panel px-4 py-2 text-right text-[11px] font-medium text-ink-muted">
                {t('detail:preview.colShape')}
              </th>
            </tr>
          </thead>
          <tbody>
            {tensors.map((tensor) => (
              <tr key={tensor.name} className="border-b last:border-b-0 hover:bg-panel/60">
                <td className="truncate px-4 py-1 text-ink" title={tensor.name}>
                  {tensor.name}
                </td>
                <td className="px-3 py-1 whitespace-nowrap text-ink-muted">{tensor.dtype}</td>
                <td className="px-4 py-1 text-right whitespace-nowrap text-ink-muted">
                  {tensor.shape.length > 0 ? tensor.shape.join(' × ') : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

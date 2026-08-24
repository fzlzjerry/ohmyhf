import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, FileQuestion } from 'lucide-react'
import type { RepoKind } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { parseOnnxBytes } from '@/lib/onnx'
import { formatBytes } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'
import { useResolvedRepoCommit } from '@/components/browse/revision-context'

const MAX_ONNX_BYTES = 8 * 1024 * 1024

interface OnnxPreviewProps {
  kind: RepoKind
  repoId: string
  path: string
  size: number
  onDownload: () => void
  downloading: boolean
}

export function OnnxPreview({
  kind,
  repoId,
  path,
  size,
  onDownload,
  downloading
}: OnnxPreviewProps): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpointKey = useHubEndpointKey()
  const revision = useResolvedRepoCommit()

  const model = useQuery({
    queryKey: ['onnxPreview', endpointKey, kind, repoId, revision, path, size],
    retry: false,
    queryFn: async () => {
      if (size > MAX_ONNX_BYTES) {
        throw new Error('onnx too large for in-app preview')
      }
      const end = size - 1
      if (end < 0) throw new Error('empty onnx file')
      const bytes = await invoke('hub:fileRange', { kind, repoId, path, revision, start: 0, end })
      const parsed = await parseOnnxBytes(bytes)
      if (!parsed) throw new Error('failed to decode onnx model')
      return parsed
    }
  })

  if (model.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-10 w-2/3" />
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-6" />
        ))}
      </div>
    )
  }

  if (model.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={FileQuestion}
          title={t('detail:onnxPreview.unreadableTitle')}
          body={
            size > MAX_ONNX_BYTES
              ? t('detail:onnxPreview.tooLargeBody', { size: formatBytes(MAX_ONNX_BYTES) })
              : t('detail:onnxPreview.unreadableBody')
          }
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

  const data = model.data

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b px-4 py-3">
        <div>
          <div className="text-[11px] font-medium text-ink-faint">
            {t('detail:onnxPreview.nodes')}
          </div>
          <div className="nums font-mono text-[15px] font-semibold text-ink-strong">
            {data.nodeCount}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium text-ink-faint">
            {t('detail:onnxPreview.size')}
          </div>
          <div className="nums font-mono text-[15px] font-semibold text-ink-strong">
            {formatBytes(size)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {data.producerName && (
            <Badge variant="outline" className="font-mono text-[10.5px]">
              {data.producerVersion
                ? `${data.producerName} ${data.producerVersion}`
                : data.producerName}
            </Badge>
          )}
          {data.irVersion && (
            <Badge variant="outline" className="font-mono text-[10.5px]">
              {`ir ${data.irVersion}`}
            </Badge>
          )}
          {data.opsets.map((op) => (
            <Badge key={op} variant="outline" className="font-mono text-[10.5px]">
              {op}
            </Badge>
          ))}
        </div>
      </div>

      <div className="grid gap-3 border-b px-4 py-3 text-[12px] sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-medium text-ink-faint">
            {t('detail:onnxPreview.inputs')}
          </div>
          <ul className="space-y-0.5 font-mono text-ink">
            {data.inputs.length === 0 && (
              <li className="text-ink-muted">{t('detail:onnxPreview.none')}</li>
            )}
            {data.inputs.map((v) => (
              <li key={v.name} className="truncate" title={v.name}>
                {v.name}
                {v.type ? <span className="text-ink-muted">{` · ${v.type}`}</span> : null}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-ink-faint">
            {t('detail:onnxPreview.outputs')}
          </div>
          <ul className="space-y-0.5 font-mono text-ink">
            {data.outputs.length === 0 && (
              <li className="text-ink-muted">{t('detail:onnxPreview.none')}</li>
            )}
            {data.outputs.map((v) => (
              <li key={v.name} className="truncate" title={v.name}>
                {v.name}
                {v.type ? <span className="text-ink-muted">{` · ${v.type}`}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {data.graphName && (
        <div className="border-b px-4 py-2 text-[12px] text-ink-muted">
          {t('detail:onnxPreview.graph', { name: data.graphName })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse font-mono text-[12px]">
          <thead>
            <tr className="text-left">
              <th className="sticky top-0 z-10 border-b bg-panel px-4 py-2 text-[11px] font-medium text-ink-muted">
                {t('detail:onnxPreview.colNode')}
              </th>
              <th className="sticky top-0 z-10 w-40 border-b bg-panel px-3 py-2 text-[11px] font-medium text-ink-muted">
                {t('detail:onnxPreview.colOp')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.nodes.map((node, i) => (
              <tr key={`${node.name}-${i}`} className="border-b last:border-b-0 hover:bg-panel/60">
                <td className="truncate px-4 py-1 text-ink" title={node.name}>
                  {node.name}
                </td>
                <td className="px-3 py-1 whitespace-nowrap text-ink-muted">{node.opType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

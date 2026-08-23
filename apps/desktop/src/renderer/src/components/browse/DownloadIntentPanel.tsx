import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, Share } from 'lucide-react'
import type { ExportTool, RepoDetail, WeightFile } from '@oh-my-huggingface/shared'
import {
  exportToolsForFormat,
  listWeightFiles,
  preferredWeightFile
} from '@oh-my-huggingface/shared'
import { describeError } from '@/lib/errors'
import { invoke } from '@/lib/ipc'
import { formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useToasts } from '@/components/ui/toaster'

const TOOL_LABELS: Record<ExportTool, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  comfyui: 'ComfyUI'
}

export function weightsFromDetail(detail: RepoDetail | undefined): WeightFile[] {
  return listWeightFiles(detail?.siblings ?? [])
}

export function DownloadIntentPanel({
  kind,
  repoId,
  detail
}: {
  kind: RepoDetail['kind']
  repoId: string
  detail: RepoDetail | undefined
}): React.JSX.Element | null {
  const { t } = useTranslation(['detail', 'common', 'downloads', 'errors'])
  const push = useToasts((s) => s.push)
  const weights = useMemo(() => weightsFromDetail(detail), [detail])
  const preferred = useMemo(() => preferredWeightFile(weights), [weights])
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined)
  const selected =
    weights.find((file) => file.path === selectedPath) ?? preferred ?? weights[0] ?? null

  const targets = useQuery({
    queryKey: ['export-targets'],
    queryFn: () => invoke('export:targets', undefined),
    staleTime: 5 * 60_000,
    enabled: weights.length > 0
  })

  const download = useMutation({
    mutationFn: (files?: string[]) =>
      invoke('downloads:start', { request: { repoId, kind, files } }),
    onSuccess: () => push(t('detail:downloadStarted'), 'success'),
    onError: (err) => push(t('detail:downloadFailed', { error: err.message }), 'error')
  })

  const downloadExport = useMutation({
    mutationFn: (args: { tool: ExportTool; file: WeightFile }) =>
      invoke('downloads:start', {
        request: {
          repoId,
          kind,
          files: [args.file.path],
          autoExport: { tool: args.tool, filePath: args.file.path }
        }
      }),
    onSuccess: () => push(t('detail:intent.exportQueued'), 'success'),
    onError: (err) => push(describeError(t, err), 'error')
  })

  if (weights.length === 0 || !selected) return null

  const exportTools = exportToolsForFormat(selected.format)
  const detected =
    targets.data?.filter((target) => target.detected && exportTools.includes(target.tool)) ?? []

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border-card bg-card-gradient p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[12.5px] font-semibold text-ink-strong">{t('detail:intent.title')}</h3>
        {selected.size !== undefined && (
          <span className="nums font-mono text-[11.5px] text-ink-faint">
            {formatBytes(selected.size)}
          </span>
        )}
      </div>
      <p className="max-w-[65ch] text-[12px] text-ink-faint">{t('detail:intent.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selected.path} onValueChange={setSelectedPath}>
          <SelectTrigger className="h-8 min-w-48 max-w-80" aria-label={t('detail:intent.quant')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {weights.map((file) => (
              <SelectItem key={file.path} value={file.path}>
                <span className="font-mono text-[12.5px]">
                  {file.quant ?? file.label}
                  {file.size !== undefined ? ` · ${formatBytes(file.size)}` : ''}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="cta"
          size="sm"
          loading={download.isPending}
          onClick={() => download.mutate([selected.path])}
        >
          <ArrowDownToLine className="size-3.5" aria-hidden />
          {t('detail:intent.download')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={download.isPending}
          onClick={() => download.mutate(undefined)}
        >
          {t('detail:intent.downloadAll')}
        </Button>
        {detected.map((target) => (
          <Button
            key={target.tool}
            variant="secondary"
            size="sm"
            loading={downloadExport.isPending}
            onClick={() => downloadExport.mutate({ tool: target.tool, file: selected })}
          >
            <Share className="size-3.5" aria-hidden />
            {t('detail:intent.downloadExport', { tool: TOOL_LABELS[target.tool] })}
          </Button>
        ))}
      </div>
    </div>
  )
}

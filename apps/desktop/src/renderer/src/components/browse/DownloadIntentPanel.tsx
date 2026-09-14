import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, Share } from 'lucide-react'
import type {
  ExportTool,
  RepoDetail,
  RepoRevisionSelection,
  SecurityAction,
  WeightVariant
} from '@oh-my-huggingface/shared'
import {
  exportToolsForFormat,
  listWeightVariants,
  preferredWeightVariant,
  recommendWeightVariantForProfile
} from '@oh-my-huggingface/shared'
import { describeError } from '@/lib/errors'
import { invoke } from '@/lib/ipc'
import { formatBytes } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { useDownloadCapacity } from '@/hooks/use-download-capacity'
import {
  downloadBlockedByCapacity,
  estimatedWriteBytes,
  isDiskCapacityError
} from '@/hooks/use-download-capacity'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useToasts } from '@/components/ui/toaster'
import { useSecurityGate } from '@/hooks/use-security-gate'

const TOOL_LABELS: Record<ExportTool, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  comfyui: 'ComfyUI'
}

function missingSourceBytes(
  files: Array<{ path: string; size?: number }>,
  cachedSizes: ReadonlyMap<string, number>
): number | undefined {
  let total = 0
  for (const file of files) {
    if (file.size === undefined) return undefined
    if (cachedSizes.get(file.path) !== file.size) total += file.size
  }
  return total
}

export function DownloadIntentPanel({
  kind,
  repoId,
  detail,
  revision
}: {
  kind: RepoDetail['kind']
  repoId: string
  detail: RepoDetail | undefined
  revision: RepoRevisionSelection
}): React.JSX.Element | null {
  const { t } = useTranslation(['detail', 'common', 'downloads', 'errors'])
  const push = useToasts((state) => state.push)
  const openSettings = useAppStore((state) => state.openSettings)
  const security = useSecurityGate()
  const variants = useMemo(() => listWeightVariants(detail?.siblings ?? []), [detail?.siblings])
  const preferred = useMemo(() => preferredWeightVariant(variants), [variants])
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined)

  const capacity = useDownloadCapacity()
  const profile = useQuery({
    queryKey: ['local-runtime-profile'],
    queryFn: () => invoke('localRuntime:profile', undefined),
    enabled: variants.some((variant) => variant.format === 'gguf'),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false
  })
  const snapshot = useQuery({
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
    () => new Map((snapshot.data?.files ?? []).map((file) => [file.path, file.size])),
    [snapshot.data?.files]
  )
  const availableSourceBytes =
    capacity.data?.availableBytes === undefined
      ? undefined
      : Math.floor(capacity.data.availableBytes / capacity.data.writeMultiplier)
  const recommendation = useMemo(
    () =>
      profile.data
        ? recommendWeightVariantForProfile(variants, profile.data, availableSourceBytes)
        : { recommendedPath: undefined, estimates: [] },
    [availableSourceBytes, profile.data, variants]
  )
  const automaticPath = recommendation.recommendedPath ?? preferred?.path ?? variants[0]?.path
  const effectivePath =
    selectedPath && variants.some((variant) => variant.path === selectedPath)
      ? selectedPath
      : automaticPath
  const selected = variants.find((variant) => variant.path === effectivePath) ?? null
  const estimateByPath = useMemo(
    () => new Map(recommendation.estimates.map((estimate) => [estimate.path, estimate])),
    [recommendation.estimates]
  )
  const selectedEstimate = selected ? estimateByPath.get(selected.path) : undefined

  const selectedSourceBytes = selected?.complete
    ? missingSourceBytes(selected.files, cachedSizes)
    : undefined
  const allFiles = useMemo(
    () =>
      (detail?.siblings ?? []).map((file) => ({
        path: file.rfilename,
        size: file.size
      })),
    [detail?.siblings]
  )
  const allSourceBytes = allFiles.length > 0 ? missingSourceBytes(allFiles, cachedSizes) : undefined
  const selectedRequiredBytes = estimatedWriteBytes(selectedSourceBytes, capacity.data)
  const allRequiredBytes = estimatedWriteBytes(allSourceBytes, capacity.data)
  const selectedBlocked = downloadBlockedByCapacity(selectedRequiredBytes, capacity.data)
  const allBlocked = downloadBlockedByCapacity(allRequiredBytes, capacity.data)

  const targets = useQuery({
    queryKey: ['export-targets'],
    queryFn: () => invoke('export:targets', undefined),
    staleTime: 5 * 60_000,
    enabled: variants.some((variant) => variant.shardCount === undefined)
  })

  const download = useMutation({
    mutationFn: async (variant?: WeightVariant) => {
      if (variant && !variant.complete) {
        throw new Error(
          t('detail:intent.incomplete', {
            available: variant.files.length,
            expected: variant.shardCount
          })
        )
      }
      const files = variant?.files.map((file) => file.path)
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

  const downloadExport = useMutation({
    mutationFn: async (args: { tool: ExportTool; variant: WeightVariant }) => {
      if (args.variant.shardCount !== undefined) {
        throw new Error(t('detail:intent.multipartExportUnsupported'))
      }
      const files = args.variant.files.map((file) => file.path)
      const action: SecurityAction = 'export'
      const securityGrantId = await security.authorize({
        action,
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
          autoExport: { tool: args.tool, filePath: args.variant.path },
          securityGrantId
        }
      })
    },
    onSuccess: () => push(t('detail:intent.exportQueued'), 'success'),
    onError: (error) =>
      push(
        isDiskCapacityError(error) ? t('downloads:capacity.insufficient') : describeError(t, error),
        'error'
      )
  })

  if (variants.length === 0 || !selected) return null

  const exportTools = exportToolsForFormat(selected.format)
  const detected =
    selected.shardCount === undefined
      ? (targets.data?.filter((target) => target.detected && exportTools.includes(target.tool)) ??
        [])
      : []
  const fitVariant =
    selectedEstimate?.level === 'comfortable'
      ? 'success'
      : selectedEstimate?.level === 'unlikely'
        ? 'error'
        : 'warning'

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border-card bg-card-gradient p-3">
      {security.dialog}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[12.5px] font-semibold text-ink-strong">{t('detail:intent.title')}</h3>
        <div className="flex items-center gap-1.5">
          {selectedEstimate && (
            <Badge variant={fitVariant}>
              {selected.path === recommendation.recommendedPath
                ? t('detail:intent.recommended')
                : t('detail:intent.estimated')}{' '}
              · {t(`detail:intent.fit.${selectedEstimate.level}`)}
            </Badge>
          )}
          {selected.size !== undefined && (
            <span className="nums font-mono text-[11.5px] text-ink-faint">
              {formatBytes(selected.size)}
            </span>
          )}
        </div>
      </div>
      <p className="max-w-[65ch] text-[12px] text-ink-faint">{t('detail:intent.hint')}</p>
      <div className="nums flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
        <span>
          {t('downloads:capacity.selected', {
            size:
              selectedRequiredBytes === undefined
                ? t('downloads:capacity.unknown')
                : formatBytes(selectedRequiredBytes)
          })}
        </span>
        <span>
          {capacity.data?.availableBytes === undefined
            ? t('downloads:capacity.availableUnknown')
            : t('downloads:capacity.available', {
                size: formatBytes(capacity.data.availableBytes)
              })}
        </span>
        {allRequiredBytes !== undefined && (
          <span>{t('downloads:capacity.all', { size: formatBytes(allRequiredBytes) })}</span>
        )}
      </div>
      {selectedEstimate && (
        <p className="text-[11.5px] text-ink-faint">
          {t('detail:intent.estimateDetails', {
            memory: formatBytes(selectedEstimate.estimatedSystemMemoryBytes),
            gpu: formatBytes(selectedEstimate.estimatedGpuBytes)
          })}
        </p>
      )}
      {(selectedBlocked || allBlocked) && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-error/10 px-2.5 py-2 text-[12px] text-error">
          <span>
            {selectedBlocked
              ? t('downloads:capacity.insufficient')
              : t('downloads:capacity.insufficientAll')}
          </span>
          <Button variant="ghost" size="sm" onClick={() => openSettings('downloads')}>
            {t('downloads:capacity.openSettings')}
          </Button>
        </div>
      )}
      {!selected.complete && (
        <p
          role="status"
          className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[12px] text-ink"
        >
          {t('detail:intent.incomplete', {
            available: selected.files.length,
            expected: selected.shardCount
          })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selected.path} onValueChange={setSelectedPath}>
          <SelectTrigger
            className="h-auto min-h-8 w-full min-w-0 max-w-80 py-1.5 text-left"
            aria-label={t('detail:intent.quant')}
          >
            <SelectValue className="min-w-0 flex-1" />
          </SelectTrigger>
          <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-content-available-width)]">
            {variants.map((variant) => {
              const estimate = estimateByPath.get(variant.path)
              return (
                <SelectItem
                  key={variant.path}
                  value={variant.path}
                  className="[&>span:first-child]:min-w-0"
                >
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-left">
                    <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
                      {variant.label}
                    </span>
                    {variant.shardCount !== undefined && (
                      <span className="nums whitespace-nowrap text-[11.5px] text-ink-faint">
                        {t('detail:intent.parts', { count: variant.shardCount })}
                      </span>
                    )}
                    {variant.size !== undefined && (
                      <span className="nums whitespace-nowrap font-mono text-[11.5px] text-ink-faint">
                        {formatBytes(variant.size)}
                      </span>
                    )}
                    {variant.path === recommendation.recommendedPath && (
                      <span className="text-[11.5px] text-ink-faint">
                        {t('detail:intent.recommended')}
                      </span>
                    )}
                    {estimate && (
                      <span className="text-[11.5px] text-ink-faint">
                        {t(`detail:intent.fit.${estimate.level}`)}
                      </span>
                    )}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        <Button
          variant="cta"
          size="sm"
          loading={download.isPending}
          disabled={!selected.complete || selectedBlocked}
          onClick={() => download.mutate(selected)}
        >
          <ArrowDownToLine className="size-3.5" aria-hidden />
          {t('detail:intent.download')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={download.isPending}
          disabled={allBlocked}
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
            disabled={selectedBlocked}
            onClick={() => downloadExport.mutate({ tool: target.tool, variant: selected })}
          >
            <Share className="size-3.5" aria-hidden />
            {t('detail:intent.downloadExport', { tool: TOOL_LABELS[target.tool] })}
          </Button>
        ))}
      </div>
      {selected.shardCount !== undefined && (
        <p className="text-[11.5px] text-ink-faint">
          {t('detail:intent.multipartExportUnsupported')}
        </p>
      )}
    </div>
  )
}

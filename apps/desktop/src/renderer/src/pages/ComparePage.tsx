import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueries } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { CircleX, Columns3, Plus, X } from 'lucide-react'
import { isValidRepoId, normalizeHubEndpoint } from '@oh-my-huggingface/shared'
import { describeError } from '@/lib/errors'
import { invoke } from '@/lib/ipc'
import { formatCount, formatDate, formatParams } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { resolveLocale, useAppStore } from '@/stores/app'

const MAX_MODELS = 4

function formatMetricValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'boolean') return String(value)
  return undefined
}

/** Phase D: side-by-side model comparison. */
export function ComparePage(): React.JSX.Element {
  const { t } = useTranslation(['compare', 'common', 'errors'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)
  const [searchParams, setSearchParams] = useSearchParams()
  const ids = (searchParams.get('models') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id, index, all) => isValidRepoId(id) && all.indexOf(id) === index)
    .slice(0, MAX_MODELS)
  const [draft, setDraft] = useState('')
  const [draftInvalid, setDraftInvalid] = useState(false)

  const refs = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['repo-refs', endpointKey, 'model' as const, id],
      queryFn: async () => {
        const value = await invoke('hub:repoRefs', { kind: 'model', repoId: id })
        if (!value.defaultBranch) throw new Error('revision.defaultUnavailable')
        return value
      },
      retry: false
    }))
  })
  const selections = useQueries({
    queries: ids.map((id, index) => ({
      queryKey: [
        'repo-revision',
        endpointKey,
        'model' as const,
        id,
        refs[index]?.data?.defaultBranch ?? 'unresolved-default'
      ],
      queryFn: () =>
        invoke('hub:resolveRevision', {
          kind: 'model',
          repoId: id,
          revision: refs[index]!.data!.defaultBranch!
        }),
      enabled: Boolean(refs[index]?.data?.defaultBranch),
      retry: false
    }))
  })
  const results = useQueries({
    queries: ids.map((id, index) => ({
      queryKey: [
        'repo',
        endpointKey,
        'model' as const,
        id,
        refs[index]?.data?.defaultBranch ?? 'unresolved-default',
        selections[index]?.data?.resolvedCommit ?? 'unresolved'
      ],
      queryFn: () =>
        invoke('hub:repoDetail', {
          kind: 'model',
          repoId: id,
          revision: selections[index]?.data?.resolvedCommit
        }),
      enabled: Boolean(selections[index]?.data?.resolvedCommit)
    }))
  })
  const evalResults = useQueries({
    queries: ids.map((id, index) => ({
      queryKey: [
        'model-eval-results',
        endpointKey,
        'model',
        id,
        refs[index]?.data?.defaultBranch ?? 'unresolved-default',
        selections[index]?.data?.resolvedCommit ?? 'unresolved'
      ],
      queryFn: () =>
        invoke('hub:modelEvalResults', {
          repoId: id,
          revision: refs[index]!.data!.defaultBranch!,
          resolvedCommit: selections[index]!.data!.resolvedCommit
        }),
      enabled: Boolean(refs[index]?.data?.defaultBranch && selections[index]?.data?.resolvedCommit),
      retry: false
    }))
  })

  const updateIds = (next: string[]): void => {
    const normalized = [...new Set(next)].filter(isValidRepoId).slice(0, MAX_MODELS)
    const params = new URLSearchParams(searchParams)
    if (normalized.length > 0) params.set('models', normalized.join(','))
    else params.delete('models')
    setSearchParams(params, { replace: true })
  }

  const add = (): void => {
    const id = draft.trim()
    if (!id || ids.includes(id) || ids.length >= MAX_MODELS) return
    if (!isValidRepoId(id)) {
      setDraftInvalid(true)
      return
    }
    updateIds([...ids, id])
    setDraft('')
  }

  // Union of benchmark rows across the compared models, in first-seen order.
  const benchmarks = evalResults.map(
    (result) =>
      new Map(
        (result.data ?? []).map((evaluation) => [
          JSON.stringify(evaluation.identity),
          formatMetricValue(evaluation.value) ?? '—'
        ])
      )
  )
  const benchmarkLabels: string[] = []
  for (const map of benchmarks) {
    for (const label of map.keys()) {
      if (!benchmarkLabels.includes(label)) benchmarkLabels.push(label)
    }
  }

  const rows: Array<{ label: string; render: (i: number) => React.ReactNode }> = [
    {
      label: t('compare:attr.params'),
      render: (i) => {
        const v = results[i]?.data?.paramCount
        return v !== undefined ? <span className="font-mono">{formatParams(v)}</span> : '–'
      }
    },
    { label: t('compare:attr.license'), render: (i) => results[i]?.data?.license ?? '–' },
    { label: t('compare:attr.task'), render: (i) => results[i]?.data?.pipelineTag ?? '–' },
    { label: t('compare:attr.library'), render: (i) => results[i]?.data?.libraryName ?? '–' },
    {
      label: t('compare:attr.downloads'),
      render: (i) => {
        const v = results[i]?.data?.downloads
        return v !== undefined ? formatCount(v, locale) : '–'
      }
    },
    {
      label: t('compare:attr.likes'),
      render: (i) => {
        const v = results[i]?.data?.likes
        return v !== undefined ? formatCount(v, locale) : '–'
      }
    },
    {
      label: t('compare:attr.updated'),
      render: (i) => formatDate(results[i]?.data?.lastModified, locale) || '–'
    },
    {
      label: t('compare:attr.tags'),
      render: (i) => (
        <div className="flex flex-wrap gap-1">
          {(results[i]?.data?.tags ?? [])
            .filter((tag) => !tag.includes(':'))
            .slice(0, 8)
            .map((tag) => (
              <Badge key={tag} variant="outline" className="font-mono text-[10px]">
                {tag}
              </Badge>
            ))}
        </div>
      )
    }
  ]

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-5">
        <div>
          <h1 className="text-smd font-semibold text-ink-strong">{t('compare:title')}</h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">{t('compare:hint')}</p>
        </div>
        <div className="flex max-w-md gap-1.5">
          <Input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setDraftInvalid(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder={t('compare:addPlaceholder')}
            aria-invalid={draftInvalid || undefined}
            disabled={ids.length >= MAX_MODELS}
          />
          <Button
            variant="secondary"
            size="icon"
            aria-label={t('compare:add')}
            onClick={add}
            disabled={draft.trim() === '' || ids.length >= MAX_MODELS}
          >
            <Plus className="size-4" aria-hidden />
          </Button>
        </div>
        {draftInvalid && (
          <p role="alert" className="text-[12px] text-error">
            {t('compare:invalidId')}
          </p>
        )}
        {ids.length >= MAX_MODELS && (
          <p className="text-[12px] text-ink-faint">{t('compare:max')}</p>
        )}

        {ids.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center">
            <Columns3 className="size-7 text-ink-faint" aria-hidden />
            <p className="text-[12.5px] text-ink-muted">{t('compare:empty')}</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="text-ink-muted">
                    <th className="w-32 border-b border-border-card bg-panel p-2.5" />
                    {ids.map((id, i) => (
                      <th
                        key={id}
                        className="min-w-44 border-b border-border-card bg-panel p-2.5 text-left align-top"
                      >
                        <div className="flex items-start gap-1">
                          <span className="min-w-0 flex-1 font-mono font-medium break-all text-ink-strong">
                            {refs[i]?.isLoading ||
                            selections[i]?.isLoading ||
                            results[i]?.isLoading ? (
                              <Skeleton className="h-4 w-24" />
                            ) : (
                              id
                            )}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            aria-label={t('compare:remove')}
                            onClick={() => updateIds(ids.filter((x) => x !== id))}
                          >
                            <X className="size-3.5" aria-hidden />
                          </Button>
                        </div>
                        {(refs[i]?.isError || selections[i]?.isError || results[i]?.isError) && (
                          <div className="mt-1 flex items-start gap-1 text-[11px] font-normal text-error">
                            <CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
                            <span className="min-w-0">
                              {describeError(
                                t,
                                refs[i]?.error ?? selections[i]?.error ?? results[i]?.error
                              )}
                            </span>
                          </div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.label} className="border-b border-border-card last:border-b-0">
                      <td className="bg-panel/50 p-2.5 font-medium text-ink-muted">{row.label}</td>
                      {ids.map((id, i) => (
                        <td key={id} className="p-2.5 align-top">
                          {refs[i]?.isLoading ||
                          selections[i]?.isLoading ||
                          results[i]?.isLoading ? (
                            <Skeleton className="h-4 w-16" />
                          ) : refs[i]?.isError ||
                            selections[i]?.isError ||
                            results[i]?.isError ? null : ( // failed column: header carries the error
                            row.render(i)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <section className="flex flex-col gap-2">
              <h2 className="text-[13.5px] font-semibold text-ink-strong">
                {t('compare:benchmarks.title')}
              </h2>
              {benchmarkLabels.length === 0 ? (
                <p className="text-[12px] text-ink-muted">{t('compare:benchmarks.none')}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full border-collapse text-[13px]">
                    <tbody>
                      {benchmarkLabels.map((label) => (
                        <tr key={label} className="border-b border-border-card last:border-b-0">
                          <td className="sticky left-0 z-[1] w-64 bg-panel p-2.5 font-medium text-ink-muted">
                            <div className="max-w-60 truncate font-mono text-[11px]" title={label}>
                              {(() => {
                                try {
                                  const identity = JSON.parse(label) as {
                                    datasetId: string
                                    taskId: string
                                    config?: string
                                    split?: string
                                    revision?: string
                                    metric: string
                                  }
                                  return [
                                    identity.datasetId,
                                    identity.taskId,
                                    identity.config,
                                    identity.split,
                                    identity.revision,
                                    identity.metric
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')
                                } catch {
                                  return label
                                }
                              })()}
                            </div>
                          </td>
                          {ids.map((id, i) => (
                            <td key={id} className="nums min-w-44 p-2.5 align-top font-mono">
                              {evalResults[i]?.isLoading ? (
                                <Skeleton className="h-4 w-12" />
                              ) : evalResults[i]?.isError ? null : (
                                (benchmarks[i]?.get(label) ?? '—')
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

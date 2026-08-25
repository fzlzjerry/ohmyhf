import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { ArrowDownToLine, CircleX, Columns3, Heart, Plus, Search, X } from 'lucide-react'
import { isValidRepoId, normalizeHubEndpoint, type RepoSummary } from '@oh-my-huggingface/shared'
import { describeError } from '@/lib/errors'
import { invoke } from '@/lib/ipc'
import { cn, formatCount, formatDate, formatParams } from '@/lib/utils'
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

function modelIdentity(id: string): { name: string; namespace?: string } {
  const slash = id.lastIndexOf('/')
  if (slash < 0) return { name: id }
  return { name: id.slice(slash + 1), namespace: id.slice(0, slash) }
}

function ModelPicker({
  selectedIds,
  disabled,
  onSelect
}: {
  selectedIds: string[]
  disabled: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation(['compare', 'common', 'errors'])
  const settings = useAppStore((state) => state.settings)
  const appInfo = useAppStore((state) => state.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)
  const rootRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 180)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [])

  const search = useQuery({
    queryKey: ['compare-model-picker', endpointKey, debouncedQuery],
    queryFn: () =>
      invoke('hub:search', {
        query: {
          kind: 'model',
          search: debouncedQuery === '' ? undefined : debouncedQuery,
          sort: 'downloads',
          limit: 8
        }
      }),
    enabled: open && !disabled,
    staleTime: 60_000
  })
  const querySettled = query.trim() === debouncedQuery
  const candidates = querySettled
    ? (search.data?.items ?? []).filter((repo) => !selectedIds.includes(repo.id))
    : []
  const focusedIndex = candidates.length > 0 ? Math.min(activeIndex, candidates.length - 1) : 0
  const exactId = query.trim()
  const canAddExact = isValidRepoId(exactId) && !selectedIds.includes(exactId) && !disabled

  const select = (id: string): void => {
    onSelect(id)
    setQuery('')
    setDebouncedQuery('')
    setOpen(false)
    setActiveIndex(0)
  }

  return (
    <div ref={rootRef} className="w-full max-w-2xl">
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <Input
            value={query}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls="compare-model-options"
            aria-activedescendant={
              open && candidates[focusedIndex] ? `compare-model-option-${focusedIndex}` : undefined
            }
            aria-label={t('compare:addPlaceholder')}
            placeholder={t('compare:addPlaceholder')}
            className="pl-8"
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
              setOpen(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setOpen(true)
                setActiveIndex((current) =>
                  candidates.length > 0 ? (current + 1) % candidates.length : 0
                )
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setOpen(true)
                setActiveIndex((current) =>
                  candidates.length > 0 ? (current - 1 + candidates.length) % candidates.length : 0
                )
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const candidate = open ? candidates[focusedIndex] : undefined
                if (candidate) select(candidate.id)
                else if (canAddExact) select(exactId)
              }
              if (event.key === 'Escape') setOpen(false)
            }}
          />
        </div>
        <Button
          variant="secondary"
          size="icon"
          aria-label={t('compare:add')}
          title={t('compare:add')}
          onClick={() => select(exactId)}
          disabled={!canAddExact}
        >
          <Plus className="size-4" aria-hidden />
        </Button>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-faint">{t('compare:searchHint')}</p>

      {open && !disabled && (
        <div className="mt-2 overflow-hidden rounded-lg border bg-bg">
          <div className="flex h-8 items-center justify-between border-b bg-panel px-2.5 text-[11.5px] font-medium text-ink-muted">
            <span>{debouncedQuery === '' ? t('compare:popular') : t('compare:results')}</span>
            {(!querySettled || search.isFetching) && <span>{t('common:loading')}</span>}
          </div>
          <div
            id="compare-model-options"
            role={
              querySettled && !search.isPending && !search.isError && candidates.length > 0
                ? 'listbox'
                : 'status'
            }
            aria-label={t('compare:addPlaceholder')}
          >
            {!querySettled || search.isPending ? (
              <div className="flex flex-col gap-1 p-1.5">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-14" />
                ))}
              </div>
            ) : search.isError ? (
              <p role="alert" className="px-3 py-5 text-center text-[12.5px] text-error">
                {describeError(t, search.error)}
              </p>
            ) : candidates.length === 0 ? (
              <p className="px-3 py-5 text-center text-[12.5px] text-ink-muted">
                {t('compare:noResults')}
              </p>
            ) : (
              candidates.map((repo: RepoSummary, index) => {
                const active = index === focusedIndex
                const meta = [repo.pipelineTag, repo.libraryName].filter(Boolean).join(' · ')
                return (
                  <button
                    key={repo.id}
                    id={`compare-model-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={cn(
                      'flex w-full items-start gap-3 border-b border-border-card px-3 py-2.5 text-left outline-none last:border-b-0 hover:bg-panel focus-visible:bg-panel',
                      active && 'bg-select/10'
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => select(repo.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-ink-strong">
                          {repo.name}
                        </span>
                        <span className="truncate font-mono text-[11px] text-ink-faint">
                          {repo.author}
                        </span>
                      </div>
                      {repo.shortDescription && (
                        <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-muted">
                          {repo.shortDescription}
                        </p>
                      )}
                      {meta && <p className="mt-0.5 text-[11px] text-ink-faint">{meta}</p>}
                    </div>
                    <span className="nums flex shrink-0 items-center gap-2 pt-0.5 text-[11px] text-ink-faint">
                      <span className="inline-flex items-center gap-0.5">
                        <Heart className="size-3" aria-hidden />
                        {formatCount(repo.likes, locale)}
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <ArrowDownToLine className="size-3" aria-hidden />
                        {formatCount(repo.downloads, locale)}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
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

  const add = (id: string): void => {
    const normalized = id.trim()
    if (!isValidRepoId(normalized) || ids.includes(normalized) || ids.length >= MAX_MODELS) return
    updateIds([...ids, normalized])
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
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-5">
        <div>
          <h1 className="text-smd font-semibold text-ink-strong">{t('compare:title')}</h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">{t('compare:hint')}</p>
        </div>
        <ModelPicker selectedIds={ids} disabled={ids.length >= MAX_MODELS} onSelect={add} />
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
                    {ids.map((id, i) => {
                      const identity = modelIdentity(id)
                      return (
                        <th
                          key={id}
                          className="min-w-52 border-b border-border-card bg-panel p-2.5 text-left align-top"
                        >
                          <div className="flex items-start gap-1.5">
                            <div className="min-w-0 flex-1" title={id}>
                              {refs[i]?.isLoading ||
                              selections[i]?.isLoading ||
                              results[i]?.isLoading ? (
                                <Skeleton className="h-8 w-32" />
                              ) : (
                                <>
                                  <span className="block truncate text-[13.5px] font-semibold text-ink-strong">
                                    {identity.name}
                                  </span>
                                  {identity.namespace && (
                                    <span className="block truncate font-mono text-[11px] font-normal text-ink-faint">
                                      {identity.namespace}
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
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
                      )
                    })}
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

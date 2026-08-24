import { BarChart3, Columns3, ExternalLink } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import type { ModelEvalResult } from '@oh-my-huggingface/shared'
import { normalizeHubEndpoint } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { useAppStore } from '@/stores/app'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { QueryErrorState } from '@/components/errors/QueryErrorState'
import { Skeleton } from '@/components/ui/skeleton'

function identityKey(result: ModelEvalResult): string {
  return JSON.stringify(result.identity)
}

function formatValue(value: number | string): string {
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : value.toPrecision(6)
  return value
}

export function EvalResultsPanel({
  repoId,
  requestedRevision,
  resolvedCommit
}: {
  repoId: string
  requestedRevision: string
  resolvedCommit: string
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const endpointKey = normalizeHubEndpoint(useAppStore((state) => state.settings.hubEndpoint))
  const query = useQuery({
    queryKey: [
      'model-eval-results',
      endpointKey,
      'model',
      repoId,
      requestedRevision,
      resolvedCommit
    ],
    queryFn: () =>
      invoke('hub:modelEvalResults', {
        repoId,
        revision: requestedRevision,
        resolvedCommit
      }),
    retry: false
  })
  const datasetIds = useMemo(
    () => [...new Set((query.data ?? []).map((result) => result.identity.datasetId))],
    [query.data]
  )
  const leaderboardAvailability = useQueries({
    queries: datasetIds.map((datasetId) => ({
      queryKey: ['dataset-leaderboard-availability', endpointKey, datasetId],
      queryFn: () => invoke('hub:datasetLeaderboard', { repoId: datasetId, limit: 1 }),
      retry: false,
      staleTime: 5 * 60_000
    }))
  })

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-24" />
      </div>
    )
  }
  if (query.isError) {
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  }
  if (query.data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center text-ink-muted">
        <BarChart3 className="size-7 text-ink-faint" aria-hidden />
        <p className="text-[12.5px]">{t('repro.eval.empty')}</p>
      </div>
    )
  }

  const grouped = new Map<string, ModelEvalResult[]>()
  for (const result of query.data) {
    const key = `${result.identity.taskId}\0${result.identity.datasetId}`
    grouped.set(key, [...(grouped.get(key) ?? []), result])
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[14px] font-semibold text-ink-strong">{t('repro.eval.title')}</h2>
          <p className="mt-0.5 text-[11.5px] text-ink-faint">{t('repro.eval.identityHint')}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void navigate(`/compare?models=${encodeURIComponent(repoId)}`)}
        >
          <Columns3 className="size-3.5" aria-hidden />
          {t('repro.eval.addToCompare')}
        </Button>
      </div>
      {[...grouped.entries()].map(([group, results]) => {
        const first = results[0]!
        const leaderboard = leaderboardAvailability[datasetIds.indexOf(first.identity.datasetId)]
        return (
          <section key={group} className="overflow-hidden rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-panel px-3 py-2">
              <div>
                <h3 className="font-mono text-[12.5px] font-semibold text-ink-strong">
                  {first.identity.datasetId}
                </h3>
                <p className="text-[11px] text-ink-faint">{first.identity.taskId}</p>
              </div>
              {leaderboard?.isError ? (
                <span className="max-w-64 text-right text-[11px] text-ink-faint">
                  {t('repro.eval.leaderboardUnavailable')}
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={leaderboard?.isPending}
                  onClick={() => {
                    const params = new URLSearchParams({
                      model: repoId,
                      task: first.identity.taskId
                    })
                    if (first.identity.config) params.set('config', first.identity.config)
                    void navigate(`/leaderboards/${first.identity.datasetId}?${params.toString()}`)
                  }}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  {leaderboard?.isPending
                    ? t('repro.eval.checkingLeaderboard')
                    : t('repro.eval.leaderboard')}
                </Button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="border-b text-left text-ink-faint">
                    <th className="px-3 py-1.5">{t('repro.eval.metric')}</th>
                    <th className="px-3 py-1.5">{t('repro.eval.value')}</th>
                    <th className="px-3 py-1.5">{t('repro.eval.configSplitRevision')}</th>
                    <th className="px-3 py-1.5">{t('repro.eval.sourceDateNotes')}</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={identityKey(result)} className="border-b last:border-b-0">
                      <td className="px-3 py-2 font-mono">{result.identity.metric}</td>
                      <td className="px-3 py-2 font-mono font-semibold">
                        {formatValue(result.value)}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                        {[result.identity.config, result.identity.split, result.identity.revision]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-2 text-ink-muted">
                        <Badge variant={result.verified ? 'success' : 'outline'}>
                          {result.source}
                          {result.verified ? t('repro.eval.verifiedSuffix') : ''}
                        </Badge>
                        {(result.createdAt || result.notes) && (
                          <p className="mt-1 max-w-md text-[11px]">
                            {[result.createdAt, result.notes].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </div>
  )
}

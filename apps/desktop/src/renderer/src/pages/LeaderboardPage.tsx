import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, Columns3, Plus } from 'lucide-react'
import { normalizeHubEndpoint } from '@oh-my-huggingface/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { useAppStore } from '@/stores/app'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { QueryErrorState } from '@/components/errors/QueryErrorState'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

function displayValue(value: number | string): string {
  return typeof value === 'number' ? String(value) : value
}

export function LeaderboardPage(): React.JSX.Element {
  const { t } = useTranslation('common')
  const params = useParams()
  const datasetId = params['*'] ?? ''
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const currentModel = searchParams.get('model') ?? undefined
  const initialTask = searchParams.get('task') ?? ''
  const initialConfig = searchParams.get('config') ?? ''
  const [task, setTask] = useState(initialTask)
  const [config, setConfig] = useState(initialConfig)
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined])
  const cursor = cursorHistory.at(-1)
  const endpointKey = normalizeHubEndpoint(useAppStore((state) => state.settings.hubEndpoint))
  const page = useQuery({
    queryKey: ['dataset-leaderboard', endpointKey, datasetId, cursor],
    queryFn: () => invoke('hub:datasetLeaderboard', { repoId: datasetId, cursor, limit: 100 }),
    enabled: datasetId.length > 0,
    retry: false
  })

  const entries = useMemo(
    () =>
      (page.data?.entries ?? []).filter(
        (entry) =>
          !entry.identityProvided ||
          ((!task || entry.identity.taskId.toLowerCase().includes(task.toLowerCase())) &&
            (!config || (entry.identity.config ?? '').toLowerCase().includes(config.toLowerCase())))
      ),
    [config, page.data?.entries, task]
  )

  const addToCompare = (modelId: string): void => {
    const models = [...new Set([...(currentModel ? [currentModel] : []), modelId])].slice(0, 4)
    void navigate(`/compare?models=${models.map(encodeURIComponent).join(',')}`)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Button variant="ghost" size="sm" onClick={() => void navigate(-1)}>
              <ArrowLeft className="size-3.5" aria-hidden /> {t('repro.leaderboard.back')}
            </Button>
            <h1 className="mt-2 font-mono text-[16px] font-semibold text-ink-strong">
              {datasetId}
            </h1>
            <p className="mt-1 text-[12px] text-ink-muted">{t('repro.leaderboard.subtitle')}</p>
          </div>
          {currentModel && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigate(`/compare?models=${encodeURIComponent(currentModel)}`)}
            >
              <Columns3 className="size-3.5" aria-hidden />
              {t('repro.leaderboard.compareCurrent')}
            </Button>
          )}
        </div>

        <div className="grid max-w-xl grid-cols-2 gap-2">
          <Input
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder={t('repro.leaderboard.filterTask')}
          />
          <Input
            value={config}
            onChange={(event) => setConfig(event.target.value)}
            placeholder={t('repro.leaderboard.filterConfig')}
          />
        </div>

        {page.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-9" />
            ))}
          </div>
        ) : page.isError ? (
          <div className="rounded-lg border p-4">
            <QueryErrorState error={page.error} onRetry={() => void page.refetch()} />
            <p className="mt-2 text-[12px] text-ink-faint">{t('repro.leaderboard.unavailable')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="min-w-[56rem] w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b bg-panel text-left text-ink-faint">
                  <th className="sticky left-0 z-10 bg-panel px-3 py-2">
                    {t('repro.leaderboard.rankModel')}
                  </th>
                  <th className="px-3 py-2">{t('repro.leaderboard.task')}</th>
                  <th className="px-3 py-2">{t('repro.leaderboard.metric')}</th>
                  <th className="px-3 py-2">{t('repro.leaderboard.value')}</th>
                  <th className="px-3 py-2">{t('repro.leaderboard.configSplitRevision')}</th>
                  <th className="px-3 py-2">{t('repro.leaderboard.evidence')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => {
                  const highlighted = entry.modelId === currentModel
                  return (
                    <tr
                      key={`${entry.modelId}:${JSON.stringify(entry.identity)}:${index}`}
                      className={cn(
                        'border-b last:border-b-0',
                        highlighted && 'bg-select/10 ring-1 ring-inset ring-select/30'
                      )}
                    >
                      <td
                        className={cn(
                          'sticky left-0 z-[1] px-3 py-2',
                          highlighted ? 'bg-select/10' : 'bg-bg'
                        )}
                      >
                        <span className="mr-2 font-mono text-ink-faint">{entry.rank ?? '—'}</span>
                        <span className="font-mono font-semibold text-ink-strong">
                          {entry.modelId}
                        </span>
                        {highlighted && (
                          <Badge className="ml-2" variant="success">
                            {t('repro.leaderboard.current')}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {entry.identityProvided
                          ? entry.identity.taskId
                          : t('repro.leaderboard.notProvidedByApi')}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {entry.identityProvided
                          ? entry.identity.metric
                          : t('repro.leaderboard.rawScore')}
                        {entry.lowerIsBetter !== undefined && (
                          <span className="ml-1 text-[10px] text-ink-faint">
                            {t('repro.leaderboard.isBetter', {
                              direction: entry.lowerIsBetter
                                ? t('repro.leaderboard.lower')
                                : t('repro.leaderboard.higher')
                            })}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold">
                        {displayValue(entry.value)}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-muted">
                        {[entry.identity.config, entry.identity.split, entry.identity.revision]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-2 text-ink-muted">
                        <div>
                          {[
                            entry.verified ? t('repro.leaderboard.verified') : undefined,
                            entry.author?.name,
                            entry.pullRequest ? `PR #${entry.pullRequest}` : undefined,
                            entry.filename,
                            entry.revision ? `model ${entry.revision.slice(0, 12)}` : undefined,
                            entry.notes
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </div>
                        {entry.source && (
                          <button
                            type="button"
                            className={cn(
                              'mt-1 text-left text-[11px]',
                              entry.sourceUrl ? 'text-select hover:underline' : 'text-ink-faint'
                            )}
                            disabled={!entry.sourceUrl}
                            onClick={() => entry.sourceUrl && openExternal(entry.sourceUrl)}
                          >
                            {entry.source}
                            {entry.sourceExternal ? t('repro.leaderboard.externalSuffix') : ''}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => addToCompare(entry.modelId)}
                        >
                          <Plus className="size-3.5" aria-hidden />
                          {t('repro.leaderboard.compare')}
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {entries.length === 0 && (
              <p className="p-8 text-center text-[12.5px] text-ink-muted">
                {t('repro.leaderboard.noEntries')}
              </p>
            )}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={cursorHistory.length <= 1 || page.isFetching}
            onClick={() => setCursorHistory((history) => history.slice(0, -1))}
          >
            {t('repro.leaderboard.previousPage')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!page.data?.nextCursor || page.isFetching}
            onClick={() =>
              page.data?.nextCursor &&
              setCursorHistory((history) => [...history, page.data!.nextCursor])
            }
          >
            {t('repro.leaderboard.nextPage')}
          </Button>
        </div>
      </div>
    </div>
  )
}

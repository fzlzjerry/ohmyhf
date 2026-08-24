import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock3, Columns3, History, Search, SearchX, Trash2 } from 'lucide-react'
import { filterHistoryItems, type KindFilter } from '@/lib/history'
import { invoke } from '@/lib/ipc'
import { openRepo } from '@/lib/repo-open'
import { formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import { resolveLocale, useAppStore } from '@/stores/app'

export function HistoryPage(): React.JSX.Element {
  const { t } = useTranslation(['history', 'common', 'nav'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const push = useToasts((state) => state.push)
  const settings = useAppStore((state) => state.settings)
  const appInfo = useAppStore((state) => state.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [confirmClear, setConfirmClear] = useState(false)

  const history = useQuery({
    queryKey: ['history'],
    queryFn: () => invoke('history:list', undefined),
    // The detail page records visits outside React Query; always refresh when
    // returning so the newest repository is visible immediately.
    refetchOnMount: 'always'
  })
  const items = useMemo(() => history.data ?? [], [history.data])
  const filtered = useMemo(() => filterHistoryItems(items, query, kind), [items, kind, query])
  const filtering = query.trim() !== '' || kind !== 'all'

  const clear = useMutation({
    mutationFn: () => invoke('history:clear', undefined),
    onSuccess: () => {
      queryClient.setQueryData(['history'], [])
      setConfirmClear(false)
      setQuery('')
      setKind('all')
      push(t('history:cleared'), 'success')
    },
    onError: () => push(t('history:confirm.error'), 'error')
  })

  const resetFilters = (): void => {
    setQuery('')
    setKind('all')
  }

  let content: React.JSX.Element
  if (history.isLoading) {
    content = (
      <div className="flex flex-col gap-1" aria-label={t('common:loading')}>
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="flex h-[50px] flex-col justify-center gap-1.5 rounded-lg border border-border-card px-3"
          >
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    )
  } else if (history.isError) {
    content = (
      <EmptyState
        icon={History}
        title={t('history:error.title')}
        body={t('history:error.body')}
        action={
          <Button size="sm" onClick={() => void history.refetch()}>
            {t('common:retry')}
          </Button>
        }
      />
    )
  } else if (items.length === 0) {
    content = (
      <EmptyState icon={History} title={t('history:empty.title')} body={t('history:empty.body')} />
    )
  } else if (filtered.length === 0) {
    content = (
      <EmptyState
        icon={SearchX}
        title={t('history:filteredEmpty.title')}
        body={t('history:filteredEmpty.body')}
        action={
          <Button size="sm" onClick={resetFilters}>
            {t('history:clearFilters')}
          </Button>
        }
      />
    )
  } else {
    content = (
      <div className="flex flex-col gap-1">
        {filtered.map((item) => {
          const relativeTime = formatRelativeTime(item.viewedAt, locale)
          return (
            <div
              key={`${item.kind}:${item.repoId}`}
              className="group flex min-h-[50px] w-full items-center rounded-lg border border-border-card bg-card-gradient transition-colors duration-150 hover:border-border"
            >
              <button
                type="button"
                onClick={() =>
                  openRepo(
                    item.kind,
                    item.repoId,
                    settings.repoOpenTarget,
                    navigate,
                    settings.hubEndpoint,
                    item.revision
                  )
                }
                className="flex min-h-[48px] min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
              >
                <Badge variant="outline">{t(`common:kind.${item.kind}`)}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] font-medium text-ink-strong transition-colors duration-150 group-hover:text-hover-title">
                    {item.repoId}
                  </span>
                  {item.summary.pipelineTag ? (
                    <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
                      {item.summary.pipelineTag}
                    </span>
                  ) : null}
                  <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-ink-faint">
                    {item.revision && item.resolvedCommit ? (
                      <>
                        <span className="truncate">{item.revision}</span>
                        <span aria-hidden>·</span>
                        <span>{item.resolvedCommit.slice(0, 10)}</span>
                      </>
                    ) : (
                      <span>{t('common:repro.history.legacy')}</span>
                    )}
                  </span>
                </span>
                <span className="nums flex shrink-0 items-center gap-1 text-[11.5px] text-ink-faint">
                  <Clock3 className="size-3" aria-hidden />
                  {relativeTime}
                </span>
              </button>
              {item.kind === 'model' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="mr-2"
                  aria-label={`Add ${item.repoId} to compare`}
                  onClick={() =>
                    void navigate(`/compare?models=${encodeURIComponent(item.repoId)}`)
                  }
                >
                  <Columns3 className="size-4" aria-hidden />
                </Button>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
        <div className="flex min-h-8 items-center gap-2">
          <h1 className="text-[15px] font-semibold text-ink-strong">{t('history:title')}</h1>
          {history.data ? (
            <Badge variant="neutral" className="nums">
              {t('history:count', { count: items.length })}
            </Badge>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={items.length === 0 || history.isLoading}
            onClick={() => {
              clear.reset()
              setConfirmClear(true)
            }}
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t('history:clear')}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('history:searchPlaceholder')}
              aria-label={t('history:searchLabel')}
              data-list-search
              className="pl-8"
              disabled={!history.data || items.length === 0}
            />
          </div>
          <Select value={kind} onValueChange={(value) => setKind(value as KindFilter)}>
            <SelectTrigger
              className="w-32 shrink-0"
              aria-label={t('history:filterLabel')}
              disabled={!history.data || items.length === 0}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('history:filter.all')}</SelectItem>
              <SelectItem value="model">{t('common:kind.model')}</SelectItem>
              <SelectItem value="dataset">{t('common:kind.dataset')}</SelectItem>
              <SelectItem value="space">{t('common:kind.space')}</SelectItem>
            </SelectContent>
          </Select>
          {filtering ? (
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              {t('history:clearFilters')}
            </Button>
          ) : null}
        </div>

        {filtering && history.data ? (
          <p className="nums px-0.5 text-[11.5px] text-ink-faint" aria-live="polite">
            {t('history:showing', { shown: filtered.length, total: items.length })}
          </p>
        ) : null}

        {content}
      </div>

      <Dialog
        open={confirmClear}
        onOpenChange={(open) => {
          if (!clear.isPending) setConfirmClear(open)
        }}
      >
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold text-ink-strong">
            {t('history:confirm.title')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            {t('history:confirm.body', { count: items.length })}
          </DialogDescription>
          {clear.isError ? (
            <p role="alert" className="mt-3 text-[12.5px] text-error">
              {t('history:confirm.error')}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={clear.isPending}
              onClick={() => setConfirmClear(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={clear.isPending}
              onClick={() => clear.mutate()}
            >
              {t('history:confirm.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

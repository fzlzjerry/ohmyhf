import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDownToLine,
  ExternalLink,
  FileText,
  Heart,
  MessageSquare,
  RefreshCw,
  Search,
  ThumbsUp
} from 'lucide-react'
import type {
  DailyPapersPeriod,
  DailyPapersSort,
  PaperAuthor,
  PaperDocument,
  PaperSummary,
  RepoKind,
  RepoSummary
} from '@oh-my-huggingface/shared'
import { hubPaperUrl, normalizeHubEndpoint } from '@oh-my-huggingface/shared'
import { invoke, openExternal } from '@/lib/ipc'
import {
  dailyPapersRequest,
  formatPaperDay,
  githubRepoUrl,
  groupPapersByDay,
  paperDayKey,
  paperMatchesQuery
} from '@/lib/paper-periods'
import { repoAppPath } from '@/lib/repo-open'
import { cn, formatCount, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { QueryErrorState } from '@/components/errors/QueryErrorState'
import { MarkdownView } from '@/components/browse/MarkdownView'
import { PdfBytesViewer } from '@/components/browse/PdfBytesViewer'
import { PaperComments } from '@/components/community/PaperComments'
import { UpvoteButton } from '@/components/community/UpvoteButton'
import { resolveLocale, useAppStore } from '@/stores/app'

const PAPER_ROW_HEIGHT = 72
const DAY_ROW_HEIGHT = 28
const LOADER_ROW_HEIGHT = 40
const PERIODS: DailyPapersPeriod[] = ['daily', 'weekly', 'monthly']
type ReaderTab = 'abstract' | 'paper' | 'pdf' | 'comments'

function paperAuthors(paper: PaperSummary): PaperAuthor[] {
  if (paper.authorProfiles && paper.authorProfiles.length > 0) return paper.authorProfiles
  return paper.authors.map((name) => ({ name }))
}

function FilterChip({
  active,
  label,
  onClick
}: {
  active: boolean
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md border px-2.5 py-1 text-[12.5px] font-medium transition-colors duration-150',
        active
          ? 'border-border bg-bg text-ink-strong'
          : 'border-transparent text-ink-muted hover:text-ink'
      )}
    >
      {label}
    </button>
  )
}

function PaperRelatedSidebar({ paperId }: { paperId: string }): React.JSX.Element {
  const { t } = useTranslation(['papers', 'common'])
  const navigate = useNavigate()
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)
  const related = useQuery({
    queryKey: ['paper-related', paperId, endpointKey],
    queryFn: () => invoke('hub:paperRelated', { paperId }),
    enabled: paperId !== ''
  })

  const sections: Array<{ key: RepoKind; title: string; items: RepoSummary[] }> = [
    { key: 'model', title: t('papers:relatedModels'), items: related.data?.models ?? [] },
    { key: 'dataset', title: t('papers:relatedDatasets'), items: related.data?.datasets ?? [] },
    { key: 'space', title: t('papers:relatedSpaces'), items: related.data?.spaces ?? [] }
  ]
  const total = sections.reduce((sum, section) => sum + section.items.length, 0)

  return (
    <aside className="w-full shrink-0 border-t min-[1200px]:w-64 min-[1200px]:border-t-0 min-[1200px]:border-l">
      <div className="flex flex-col gap-3 p-4">
        <h2 className="text-[13px] font-semibold text-ink-strong">{t('papers:related')}</h2>
        {related.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </div>
        ) : related.isError ? (
          <QueryErrorState
            compact
            error={related.error}
            onRetry={() => void related.refetch()}
            title={t('papers:relatedError')}
          />
        ) : total === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-ink-muted">{t('papers:relatedEmpty')}</p>
        ) : (
          sections.map((section) =>
            section.items.length === 0 ? null : (
              <div key={section.key} className="flex flex-col gap-1">
                <h3 className="text-[11.5px] font-medium tracking-wide text-ink-faint uppercase">
                  {section.title}
                </h3>
                {section.items.map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => navigate(repoAppPath(section.key, repo.id))}
                    className="rounded-md px-1.5 py-1.5 text-left hover:bg-panel"
                    title={repo.id}
                  >
                    <span className="block truncate font-mono text-[12.5px] text-ink-strong">
                      {repo.id}
                    </span>
                    <span className="nums flex items-center gap-2 text-[11px] text-ink-faint">
                      <span className="inline-flex items-center gap-0.5">
                        <Heart className="size-3" aria-hidden />
                        {formatCount(repo.likes, locale)}
                      </span>
                      {section.key !== 'space' && (
                        <span className="inline-flex items-center gap-0.5">
                          <ArrowDownToLine className="size-3" aria-hidden />
                          {formatCount(repo.downloads, locale)}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )
          )
        )}
      </div>
    </aside>
  )
}

function PaperDocumentPane({
  paperId,
  format,
  active
}: {
  paperId: string
  format: 'markdown' | 'pdf'
  active: boolean
}): React.JSX.Element {
  const { t } = useTranslation(['papers', 'detail'])
  const endpointKey = normalizeHubEndpoint(useAppStore((s) => s.settings.hubEndpoint))
  const document = useQuery({
    queryKey: ['paper-document', format, paperId, endpointKey],
    queryFn: () => invoke('hub:paperDocument', { paperId, format }),
    enabled: active && paperId !== ''
  })

  if (!active) return <div />
  if (document.isPending) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-64" />
        <p className="text-[12.5px] text-ink-faint">
          {format === 'markdown'
            ? t('papers:reader.loadingMarkdown')
            : t('papers:reader.loadingPdf')}
        </p>
      </div>
    )
  }
  if (document.isError) {
    return (
      <QueryErrorState
        error={document.error}
        onRetry={() => void document.refetch()}
        title={
          format === 'markdown' ? t('papers:reader.markdownError') : t('papers:reader.pdfError')
        }
      />
    )
  }

  const payload = document.data as PaperDocument | undefined
  if (!payload) {
    return (
      <EmptyState
        icon={FileText}
        title={format === 'markdown' ? t('papers:reader.noMarkdown') : t('papers:reader.noPdf')}
      />
    )
  }
  if (payload.format === 'markdown') {
    if (payload.text.trim() === '') {
      return <EmptyState icon={FileText} title={t('papers:reader.noMarkdown')} />
    }
    return <MarkdownView markdown={payload.text} />
  }
  if (payload.tooLarge) {
    return <EmptyState icon={FileText} title={t('papers:reader.pdfTooLarge')} />
  }
  if (payload.bytes.byteLength === 0) {
    return <EmptyState icon={FileText} title={t('papers:reader.noPdf')} />
  }
  return (
    <div className="h-[min(70vh,40rem)] overflow-hidden rounded-md border">
      <PdfBytesViewer
        bytes={payload.bytes}
        errorTitle={t('papers:reader.pdfError')}
        errorBody={t('papers:reader.noPdf')}
        pageLabel={(page, total) => t('detail:preview.pdfPage', { page, total })}
        prevLabel={t('detail:datasetPreview.prev')}
        nextLabel={t('detail:datasetPreview.next')}
      />
    </div>
  )
}

/** Paper detail pane; reusable from SearchPage without leaving the search layout. */
export function PaperDetailPane({ paperId }: { paperId: string }): React.JSX.Element {
  const { t } = useTranslation(['papers', 'common', 'detail'])
  const navigate = useNavigate()
  const auth = useAppStore((s) => s.auth)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)
  const [tab, setTab] = useState<ReaderTab>('abstract')

  const paper = useQuery({
    queryKey: ['paper', paperId, endpointKey],
    queryFn: () => invoke('hub:paper', { paperId }),
    enabled: paperId !== ''
  })
  const selected = paper.data

  if (paper.isPending) {
    return (
      <div className="mx-auto flex max-w-[72ch] flex-col gap-4 p-6">
        <Skeleton className="h-8" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-40" />
      </div>
    )
  }

  if (paper.isError && selected === undefined) {
    return (
      <QueryErrorState
        error={paper.error}
        onRetry={() => void paper.refetch()}
        title={t('papers:detailError')}
        className="h-full"
      />
    )
  }

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState icon={FileText} title={t('papers:empty')} />
      </div>
    )
  }

  const authors = paperAuthors(selected)
  const github = selected.githubRepo ? githubRepoUrl(selected.githubRepo) : undefined

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto min-[1200px]:flex-row">
      <article className="mx-auto flex min-w-0 w-full max-w-[72ch] flex-1 flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          {auth.status === 'signedIn' && (
            <UpvoteButton
              upvotes={selected.upvotes}
              hubUrl={hubPaperUrl(selected.id, settings.hubEndpoint)}
              onToggle={(next) =>
                invoke('hub:paperUpvoteSet', { paperId: selected.id, upvoted: next })
              }
            />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl leading-snug font-semibold text-balance text-ink-strong">
              {selected.title}
            </h1>
            <p className="mt-1 font-mono text-[12px] text-ink-faint">{selected.id}</p>
          </div>
        </div>
        <div className="nums flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-faint">
          <span className="flex items-center gap-1">
            <ThumbsUp className="size-3.5" aria-hidden />
            {formatCount(selected.upvotes, locale)}
          </span>
          {selected.publishedAt && (
            <>
              <span className="text-decor" aria-hidden>
                ·
              </span>
              <span>
                {t('papers:published', {
                  time: formatRelativeTime(selected.publishedAt, locale)
                })}
              </span>
            </>
          )}
          {selected.submittedBy && (
            <>
              <span className="text-decor" aria-hidden>
                ·
              </span>
              <span>{t('papers:submittedBy', { name: selected.submittedBy })}</span>
            </>
          )}
        </div>
        {authors.length > 0 && (
          <p className="text-[12.5px] text-ink-muted">
            <span className="font-medium text-ink">{t('papers:authors')}: </span>
            {authors.map((author, index) => (
              <span key={`${author.name}:${author.username ?? index}`}>
                {index > 0 ? ', ' : null}
                {author.username ? (
                  <button
                    type="button"
                    className="text-select hover:underline"
                    onClick={() => navigate(`/users/${author.username}`)}
                  >
                    {author.name}
                  </button>
                ) : (
                  author.name
                )}
              </span>
            ))}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="cta" size="md" onClick={() => setTab('paper')}>
            <FileText className="size-3.5" aria-hidden />
            {t('papers:readHere')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openExternal(`https://arxiv.org/abs/${selected.id}`)}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('papers:readOnArxiv')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openExternal(hubPaperUrl(selected.id, settings.hubEndpoint))}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('papers:readOnHub')}
          </Button>
          {github && (
            <Button variant="ghost" size="sm" onClick={() => openExternal(github)}>
              <ExternalLink className="size-3.5" aria-hidden />
              {t('papers:openGithub')}
            </Button>
          )}
          {selected.projectPage && (
            <Button variant="ghost" size="sm" onClick={() => openExternal(selected.projectPage!)}>
              <ExternalLink className="size-3.5" aria-hidden />
              {t('papers:openProject')}
            </Button>
          )}
        </div>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as ReaderTab)}
          className="flex min-h-0 flex-col"
        >
          <TabsList>
            <TabsTrigger value="abstract">{t('papers:tabs.abstract')}</TabsTrigger>
            <TabsTrigger value="paper">{t('papers:tabs.paper')}</TabsTrigger>
            <TabsTrigger value="pdf">{t('papers:tabs.pdf')}</TabsTrigger>
            <TabsTrigger value="comments">{t('papers:tabs.comments')}</TabsTrigger>
          </TabsList>
          <TabsContent value="abstract" className="flex flex-col gap-4 pt-4">
            {selected.thumbnail && (
              <img
                src={selected.thumbnail}
                alt=""
                loading="lazy"
                decoding="async"
                className="max-h-64 w-full rounded-lg border object-cover"
              />
            )}
            {selected.aiSummary && (
              <section className="flex flex-col gap-1.5">
                <h2 className="text-[13px] font-semibold text-ink-strong">
                  {t('papers:aiSummary')}
                </h2>
                <p className="text-[13.5px] leading-[1.7] text-pretty text-ink-muted">
                  {selected.aiSummary}
                </p>
              </section>
            )}
            {selected.summary ? (
              <p className="text-[13.5px] leading-[1.7] text-pretty">{selected.summary}</p>
            ) : (
              <p className="text-[13px] text-ink-muted">{t('papers:noAbstract')}</p>
            )}
          </TabsContent>
          <TabsContent value="paper" className="pt-4">
            <PaperDocumentPane paperId={selected.id} format="markdown" active={tab === 'paper'} />
          </TabsContent>
          <TabsContent value="pdf" className="pt-4">
            <PaperDocumentPane paperId={selected.id} format="pdf" active={tab === 'pdf'} />
          </TabsContent>
          <TabsContent value="comments" className="pt-4">
            <PaperComments paperId={selected.id} />
          </TabsContent>
        </Tabs>
      </article>
      <PaperRelatedSidebar paperId={selected.id} />
    </div>
  )
}

export function PapersPage(): React.JSX.Element {
  const { t } = useTranslation(['papers', 'common'])
  const navigate = useNavigate()
  const params = useParams()
  const selectedId = params['*'] || undefined
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)
  const parentRef = useRef<HTMLDivElement>(null)
  const [period, setPeriod] = useState<DailyPapersPeriod>('daily')
  const [sort, setSort] = useState<DailyPapersSort>('publishedAt')
  const [query, setQuery] = useState('')

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError
  } = useInfiniteQuery({
    queryKey: ['papers', endpointKey, period, sort],
    queryFn: ({ pageParam }) =>
      invoke('hub:papers', dailyPapersRequest(period, sort, pageParam || undefined)),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null
  })

  const papers = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data])
  const visible = useMemo(
    () => papers.filter((item) => paperMatchesQuery(item, query)),
    [papers, query]
  )
  const rows = useMemo(() => groupPapersByDay(visible), [visible])
  const showLoader = hasNextPage && query.trim() === ''

  // TanStack Virtual exposes imperative functions that React Compiler cannot memoize safely.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length + (showLoader ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row) return LOADER_ROW_HEIGHT
      return row.type === 'day' ? DAY_ROW_HEIGHT : PAPER_ROW_HEIGHT
    },
    getItemKey: (index) => {
      const row = rows[index]
      if (!row) return 'loader'
      return row.type === 'day' ? `day:${row.day}` : row.paper.id
    },
    overscan: 8
  })
  const virtualItems = virtualizer.getVirtualItems()
  const stickyDay = useMemo(() => {
    for (const item of virtualItems) {
      const row = rows[item.index]
      if (row?.type === 'day') return row.day
      if (row?.type === 'paper') {
        return paperDayKey(row.paper.submittedOnDailyAt ?? row.paper.publishedAt)
      }
    }
    return undefined
  }, [rows, virtualItems])

  useEffect(() => {
    const last = virtualItems.at(-1)
    if (
      last &&
      last.index >= rows.length - 1 &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchNextPageError
    ) {
      void fetchNextPage()
    }
  }, [
    virtualItems,
    rows.length,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage
  ])

  return (
    <div className="flex h-full min-w-0">
      <section className="flex w-[24rem] shrink-0 flex-col border-r max-[1000px]:w-80">
        <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-smd font-semibold text-ink-strong">{t('papers:title')}</h1>
              <p className="text-[11.5px] leading-snug text-ink-faint">{t('papers:subtitle')}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('papers:refresh')}
              onClick={() => void refetch()}
            >
              <RefreshCw className="size-3.5" aria-hidden />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {PERIODS.map((value) => (
              <FilterChip
                key={value}
                active={period === value}
                label={t(`papers:period.${value}`)}
                onClick={() => setPeriod(value)}
              />
            ))}
            <span className="flex-1" />
            <FilterChip
              active={sort === 'publishedAt'}
              label={t('papers:sort.published')}
              onClick={() => setSort('publishedAt')}
            />
            <FilterChip
              active={sort === 'trending'}
              label={t('papers:sort.trending')}
              onClick={() => setSort('trending')}
            />
          </div>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('papers:search')}
              aria-label={t('papers:search')}
              className="h-8 pl-8"
            />
          </div>
        </div>
        {isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 10 }, (_, index) => (
              <Skeleton key={index} className="h-14" />
            ))}
          </div>
        ) : isError && data === undefined ? (
          <QueryErrorState
            error={error}
            onRetry={() => void refetch()}
            title={t('papers:listError')}
            compact
            className="min-h-0 flex-1"
          />
        ) : papers.length === 0 ? (
          <EmptyState icon={FileText} title={t('papers:empty')} className="flex-1" />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t('papers:emptySearch')}
            body={t('papers:emptyHint')}
            className="flex-1"
          />
        ) : (
          <div className="relative min-h-0 flex-1">
            {stickyDay && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 border-b bg-bg/95 px-3 py-1 text-[11px] font-medium text-ink-muted">
                {formatPaperDay(stickyDay, locale)}
              </div>
            )}
            <div ref={parentRef} className={cn('h-full overflow-y-auto', stickyDay && 'pt-7')}>
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualItems.map((row) => {
                  const item = rows[row.index]
                  if (!item) {
                    return (
                      <div
                        key="loader"
                        className="absolute inset-x-0 flex items-center justify-center text-[12px] text-ink-faint"
                        style={{ top: row.start, height: LOADER_ROW_HEIGHT }}
                      >
                        {isFetchNextPageError ? (
                          <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>
                            {t('papers:retryMore')}
                          </Button>
                        ) : (
                          t('common:loading')
                        )}
                      </div>
                    )
                  }
                  if (item.type === 'day') {
                    return (
                      <div
                        key={`day:${item.day}`}
                        className="absolute inset-x-0 flex items-center px-3 text-[11px] font-medium text-ink-faint"
                        style={{ top: row.start, height: DAY_ROW_HEIGHT }}
                      >
                        {formatPaperDay(item.day, locale)}
                      </div>
                    )
                  }
                  const paperItem = item.paper
                  const isSelected = paperItem.id === selectedId
                  return (
                    <button
                      key={paperItem.id}
                      type="button"
                      aria-current={isSelected ? 'true' : undefined}
                      title={paperItem.title}
                      onClick={() => navigate(`/papers/${paperItem.id}`)}
                      className={cn(
                        'absolute inset-x-1 flex flex-col justify-center gap-1 rounded-md px-2.5 text-left transition-colors duration-100',
                        isSelected ? 'bg-select/10' : 'hover:bg-panel'
                      )}
                      style={{ top: row.start + 2, height: PAPER_ROW_HEIGHT - 4 }}
                    >
                      <span
                        className={cn(
                          'line-clamp-2 text-[13px] leading-tight font-medium',
                          isSelected && 'text-select'
                        )}
                      >
                        {paperItem.title}
                      </span>
                      <span className="nums flex items-center gap-2 text-[11.5px] text-ink-faint">
                        <span className="flex items-center gap-0.5">
                          <ThumbsUp className="size-3" aria-hidden />
                          {formatCount(paperItem.upvotes, locale)}
                        </span>
                        <span className="text-decor" aria-hidden>
                          ·
                        </span>
                        <span>{formatRelativeTime(paperItem.publishedAt, locale)}</span>
                        {paperItem.numComments !== undefined && (
                          <>
                            <span className="text-decor" aria-hidden>
                              ·
                            </span>
                            <span className="flex items-center gap-0.5">
                              <MessageSquare className="size-3" aria-hidden />
                              {formatCount(paperItem.numComments, locale)}
                            </span>
                          </>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="min-w-0 flex-1 overflow-hidden">
        {selectedId ? (
          <PaperDetailPane key={selectedId} paperId={selectedId} />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <EmptyState icon={FileText} title={t('papers:select')} body={t('papers:selectHint')} />
          </div>
        )}
      </section>
    </div>
  )
}

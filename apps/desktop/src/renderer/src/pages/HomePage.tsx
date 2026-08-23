import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CloudOff, Newspaper, UserPlus } from 'lucide-react'
import {
  normalizeHubEndpoint,
  type PaperSummary,
  type PostSummary,
  type RepoSummary
} from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { describeError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { PaperRow, PostCard, RepoEventRow } from '@/components/home/FeedItems'
import { ActivityCard } from '@/components/home/ActivityFeedItems'
import { TrendingRail } from '@/components/home/TrendingRail'
import { PostComposer } from '@/components/community/PostComposer'
import { useHubSession } from '@/hooks/use-hub-session'
import { resolveLocale, useAppStore } from '@/stores/app'

const STALE_TIME = 5 * 60_000
const MAX_FOLLOWS = 8
const PAPERS_SHOWN = 3

type FeedItem =
  | { type: 'post'; key: string; ts: number; post: PostSummary }
  | { type: 'repo'; key: string; ts: number; repo: RepoSummary }
  | { type: 'paper'; key: string; ts: number; paper: PaperSummary }

function toTimestamp(iso: string | undefined): number {
  if (!iso) return 0
  const ts = new Date(iso).getTime()
  return Number.isNaN(ts) ? 0 : ts
}

export function HomePage(): React.JSX.Element {
  const { t } = useTranslation(['home', 'common', 'errors'])
  const navigate = useNavigate()
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)

  // Each source is an independent query: one failing (e.g. posts while the
  // endpoint is not implemented yet) must not blank the rest of the feed.
  const posts = useQuery({
    queryKey: ['home', 'posts', endpointKey],
    queryFn: () => invoke('hub:posts', {}),
    staleTime: STALE_TIME
  })

  const papers = useQuery({
    queryKey: ['home', 'papers', endpointKey],
    queryFn: () => invoke('hub:papers', {}),
    staleTime: STALE_TIME
  })

  // Shares the ['follows'] cache entry with the Inbox page.
  const follows = useQuery({
    queryKey: ['follows'],
    queryFn: () => invoke('follows:list', undefined),
    staleTime: STALE_TIME
  })

  // The REAL Hugging Face following list of the signed-in account drives the feed;
  // local follows extend it (and are the only source when signed out).
  const auth = useAppStore((s) => s.auth)
  const me = auth.status === 'signedIn' ? auth.user.name : undefined
  const hubSession = useHubSession()

  // The real huggingface.co home feed: the signed-in account's personalized
  // "following" activity stream. The Hub rejects Bearer tokens here (401), so
  // this waits for a Hub web session; the merged posts/repos/papers feed is
  // the fallback (token-only and signed-out).
  const recentActivity = useQuery({
    queryKey: ['home', 'recent-activity', endpointKey],
    enabled: hubSession,
    staleTime: STALE_TIME,
    queryFn: () => invoke('hub:recentActivity', {})
  })
  const activityItems = recentActivity.data?.items ?? []
  const personalized = hubSession && recentActivity.isSuccess && activityItems.length > 0

  const hubFollowing = useQuery({
    queryKey: ['hub-following', me, endpointKey],
    enabled: Boolean(me),
    staleTime: STALE_TIME,
    queryFn: () => invoke('hub:userFollowing', { username: me ?? '' })
  })

  const followTargets = useMemo(() => {
    const seen = new Set<string>()
    const targets: string[] = []
    for (const account of hubFollowing.data ?? []) {
      const key = account.name.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        targets.push(account.name)
      }
    }
    for (const follow of follows.data ?? []) {
      if (follow.type !== 'user' && follow.type !== 'org') continue
      const key = follow.target.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        targets.push(follow.target)
      }
    }
    return targets.slice(0, MAX_FOLLOWS)
  }, [hubFollowing.data, follows.data])

  const activity = useQuery({
    queryKey: ['home', 'activity', followTargets, endpointKey],
    enabled: followTargets.length > 0,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<RepoSummary[]> => {
      // allSettled: one broken author query must not sink the whole group.
      const results = await Promise.allSettled(
        followTargets.flatMap((author) => [
          invoke('hub:search', {
            query: { kind: 'model', author, sort: 'updated', limit: 3 }
          }),
          invoke('hub:search', {
            query: { kind: 'dataset', author, sort: 'updated', limit: 2 }
          })
        ])
      )
      const seen = new Set<string>()
      const repos: RepoSummary[] = []
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        for (const repo of result.value.items) {
          const key = `${repo.kind}:${repo.id}`
          if (!seen.has(key)) {
            seen.add(key)
            repos.push(repo)
          }
        }
      }
      return repos
    }
  })

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = []
    for (const post of posts.data?.items ?? []) {
      items.push({
        type: 'post',
        key: `post:${post.slug}`,
        ts: toTimestamp(post.publishedAt),
        post
      })
    }
    for (const repo of activity.data ?? []) {
      items.push({
        type: 'repo',
        key: `repo:${repo.kind}:${repo.id}`,
        ts: toTimestamp(repo.updatedAt),
        repo
      })
    }
    for (const paper of (papers.data?.items ?? []).slice(0, PAPERS_SHOWN)) {
      items.push({
        type: 'paper',
        key: `paper:${paper.id}`,
        ts: toTimestamp(paper.publishedAt),
        paper
      })
    }
    return items.sort((a, b) => b.ts - a.ts)
  }, [posts.data, activity.data, papers.data])

  // Disabled queries stay pending forever, hence the followTargets guard.
  const sourcesPending =
    posts.isPending ||
    papers.isPending ||
    follows.isPending ||
    (Boolean(me) && hubFollowing.isPending) ||
    (followTargets.length > 0 && activity.isPending)
  // When signed in, the personalized feed is the primary source: show skeletons
  // while it loads, and only fall through to the merged feed once it settles
  // empty or errored.
  const showSkeleton =
    (hubSession && recentActivity.isPending) ||
    (!personalized && feed.length === 0 && sourcesPending)
  const followSourcesSettled = follows.isSuccess && (!me || hubFollowing.isSuccess)
  // The "follow someone" nudge only applies to the fallback feed, not the
  // personalized stream (which already reflects the Hub following list).
  const showEmptyFollowing = !personalized && followSourcesSettled && followTargets.length === 0
  // Individual source failures are tolerated while anything renders, but a
  // feed that is empty BECAUSE sources failed needs a retry, not "nothing yet".
  const failedSources = [recentActivity, posts, papers, follows, hubFollowing, activity].filter(
    (q) => q.isError
  )

  return (
    <div className="animate-fade-rise flex h-full min-w-0">
      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-6 py-5">
          <h1 className="text-smd font-semibold text-ink-strong">{t('home:title')}</h1>

          <PostComposer />

          {showEmptyFollowing ? (
            <div className="rounded-lg border border-border-card bg-card-gradient">
              <EmptyState
                icon={UserPlus}
                title={t('home:feed.emptyFollowing')}
                body={t('home:feed.emptyFollowingBody')}
                action={
                  <Button size="sm" onClick={() => navigate('/inbox')}>
                    {t('home:feed.manageFollows')}
                  </Button>
                }
                className="py-8"
              />
            </div>
          ) : null}

          {showSkeleton ? (
            Array.from({ length: 4 }, (_, i) => (
              <div
                key={i}
                className="flex flex-col gap-3 rounded-lg border border-border-card bg-card-gradient p-4"
              >
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-8 rounded-full" />
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-2.5 w-20" />
                  </div>
                </div>
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            ))
          ) : personalized ? (
            activityItems.map((item, i) => (
              <ActivityCard key={`activity:${i}`} item={item} locale={locale} />
            ))
          ) : feed.length === 0 && !showEmptyFollowing && failedSources.length > 0 ? (
            <EmptyState
              icon={CloudOff}
              title={t('home:feed.error')}
              body={describeError(t, failedSources[0]!.error)}
              action={
                <Button size="sm" onClick={() => failedSources.forEach((q) => void q.refetch())}>
                  {t('common:retry')}
                </Button>
              }
            />
          ) : feed.length === 0 && !showEmptyFollowing ? (
            <EmptyState
              icon={Newspaper}
              title={t('home:feed.empty')}
              body={t('home:feed.emptyBody')}
            />
          ) : (
            feed.map((item) =>
              item.type === 'post' ? (
                <PostCard key={item.key} post={item.post} locale={locale} />
              ) : item.type === 'repo' ? (
                <RepoEventRow key={item.key} repo={item.repo} locale={locale} />
              ) : (
                <PaperRow key={item.key} paper={item.paper} locale={locale} />
              )
            )
          )}
        </div>
      </section>
      <TrendingRail />
    </div>
  )
}

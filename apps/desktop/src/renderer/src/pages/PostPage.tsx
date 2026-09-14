import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, FileWarning, MessageSquare } from 'lucide-react'
import { normalizeHubEndpoint, type PostSummary } from '@oh-my-huggingface/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { formatCount, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useToasts } from '@/components/ui/toaster'
import { MarkdownView } from '@/components/browse/MarkdownView'
import { CommentComposer } from '@/components/community/CommentComposer'
import { PostAttachments } from '@/components/community/PostAttachments'
import { PostComments } from '@/components/community/PostComments'
import { ReactionBar } from '@/components/community/ReactionBar'
import { ProfileAvatar } from '@/components/profile/ProfileAvatar'
import { UserLink } from '@/components/profile/UserLink'
import { useHubSession } from '@/hooks/use-hub-session'
import { resolveLocale, useAppStore } from '@/stores/app'

/** Apply one reaction toggle to cached post data (optimistic layer). */
function withReaction(
  post: PostSummary,
  emoji: string,
  active: boolean,
  user: string
): PostSummary {
  const rows = post.reactions.map((r) => ({ ...r, users: [...r.users] }))
  const row = rows.find((r) => r.emoji === emoji)
  if (active) {
    if (row && !row.users.includes(user)) {
      row.users.push(user)
      row.count += 1
    } else if (!row) {
      rows.push({ emoji, count: 1, users: [user] })
    }
  } else if (row && row.users.includes(user)) {
    row.users = row.users.filter((u) => u !== user)
    row.count = Math.max(0, row.count - 1)
  }
  const reactions = rows.filter((r) => r.count > 0)
  return {
    ...post,
    reactions,
    numReactions: reactions.reduce((acc, r) => acc + (r.count || 1), 0)
  }
}

/**
 * Full view of a single community post (/posts/:author/:slug).
 *
 * Reacting and commenting are Hub-web only — both 401 for every obtainable
 * token kind (live-verified 2026-07-11) — so they light up when a Hub web
 * session is connected and fall back to open-on-Hub links otherwise.
 */
export function PostPage(): React.JSX.Element {
  const { t } = useTranslation(['profile', 'common'])
  const navigate = useNavigate()
  const params = useParams()
  const author = params.author ?? ''
  const slug = params.slug ?? ''
  const auth = useAppStore((s) => s.auth)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = normalizeHubEndpoint(settings.hubEndpoint)
  const hubSession = useHubSession()
  const push = useToasts((s) => s.push)
  const queryClient = useQueryClient()
  const currentUser = auth.status === 'signedIn' ? auth.user.name : undefined
  // Quote-reply request threaded from a comment's button into the composer.
  const [quote, setQuote] = useState<{ text: string; nonce: number }>()

  const queryKey = ['post', author, slug, endpointKey]
  const post = useQuery({
    queryKey,
    queryFn: () => invoke('hub:postDetail', { author, slug }),
    enabled: author !== '' && slug !== ''
  })
  const data = post.data

  const react = useMutation({
    mutationFn: ({ emoji, active }: { emoji: string; active: boolean }) =>
      invoke('hub:postReactionSet', { author, slug, reaction: emoji, active }),
    onMutate: async ({ emoji, active }) => {
      const source = { auth: useAppStore.getState().auth, endpointKey, queryKey }
      await queryClient.cancelQueries({ queryKey })
      const current = useAppStore.getState()
      if (
        current.auth !== source.auth ||
        normalizeHubEndpoint(current.settings.hubEndpoint) !== source.endpointKey
      ) {
        return { ...source, prev: undefined }
      }
      const prev = queryClient.getQueryData<PostSummary>(queryKey)
      if (prev && currentUser !== undefined) {
        queryClient.setQueryData<PostSummary>(
          queryKey,
          withReaction(prev, emoji, active, currentUser)
        )
      }
      return { ...source, prev }
    },
    onError: (err, _vars, ctx) => {
      const current = useAppStore.getState()
      if (
        !ctx ||
        current.auth !== ctx.auth ||
        normalizeHubEndpoint(current.settings.hubEndpoint) !== ctx.endpointKey
      )
        return
      if (ctx.prev) queryClient.setQueryData(ctx.queryKey, ctx.prev)
      push(t('profile:reactions.error', { error: err.message }), 'error')
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey })
  })

  return (
    <div className="h-full overflow-y-auto">
      <article className="animate-fade-rise mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-5">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="size-3.5" aria-hidden />
            {t('common:back')}
          </Button>
        </div>

        {post.isPending && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {post.isError && (
          <EmptyState
            icon={FileWarning}
            title={t('profile:post.error.title')}
            body={post.error.message}
            action={
              <Button size="sm" onClick={() => void post.refetch()}>
                {t('common:retry')}
              </Button>
            }
          />
        )}

        {data && (
          <>
            <header className="flex items-center gap-3">
              <ProfileAvatar
                name={data.author}
                url={data.authorAvatarUrl}
                className="size-10 text-[14px]"
                isPro={data.authorIsPro === true}
                frame="compact"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <UserLink
                    username={data.author}
                    className="truncate text-[13.5px] font-medium text-ink-strong"
                  />
                  {data.authorFullname !== undefined && data.authorFullname !== '' && (
                    <span className="truncate text-[12.5px] text-ink-muted">
                      {data.authorFullname}
                    </span>
                  )}
                </div>
                <div className="nums text-[11.5px] text-ink-faint">
                  {formatRelativeTime(data.publishedAt, locale)}
                </div>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('common:openOnHub')}
                    onClick={() => openExternal(data.url)}
                  >
                    <ExternalLink className="size-4" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('common:openOnHub')}</TooltipContent>
              </Tooltip>
            </header>

            <MarkdownView markdown={data.content} kind="model" repoId={`${author}/${slug}`} />

            {data.attachments.length > 0 && <PostAttachments attachments={data.attachments} />}

            <footer className="flex flex-col gap-3 border-t pt-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="nums flex items-center gap-1 text-[12px] text-ink-faint">
                  <MessageSquare className="size-3.5" aria-hidden />
                  {formatCount(data.numComments ?? 0, locale)}
                </span>
                <ReactionBar
                  reactions={data.reactions}
                  postUrl={data.url}
                  locale={locale}
                  currentUser={currentUser}
                  onToggle={
                    hubSession ? (emoji, active) => react.mutate({ emoji, active }) : undefined
                  }
                  pending={react.isPending}
                />
              </div>
              <PostComments
                author={author}
                slug={slug}
                postUrl={data.url}
                onQuote={
                  hubSession
                    ? (content) => setQuote({ text: content, nonce: Date.now() })
                    : undefined
                }
              />
              {hubSession ? (
                <div className="flex flex-col gap-2">
                  <h2 className="text-[13px] font-semibold">{t('profile:post.comment.heading')}</h2>
                  <CommentComposer
                    key={`${author}/${slug}`}
                    kind="model"
                    repoId={`${author}/${slug}`}
                    placeholder={t('profile:post.comment.placeholder')}
                    quote={quote}
                    submit={(comment) => invoke('hub:postComment', { author, slug, comment })}
                    onSubmitted={() => {
                      push(t('profile:post.comment.posted'), 'success')
                      void queryClient.invalidateQueries({ queryKey })
                      void queryClient.invalidateQueries({
                        queryKey: ['post-comments', author, slug, endpointKey]
                      })
                    }}
                  />
                </div>
              ) : (
                <>
                  <p className="text-[12px] text-ink-faint">{t('profile:post.commentsOnHub')}</p>
                  <div>
                    <Button variant="cta" size="sm" onClick={() => openExternal(data.url)}>
                      <ExternalLink className="size-3.5" aria-hidden />
                      {t('profile:post.commentOnHub')}
                    </Button>
                  </div>
                </>
              )}
            </footer>
          </>
        )}
      </article>
    </div>
  )
}

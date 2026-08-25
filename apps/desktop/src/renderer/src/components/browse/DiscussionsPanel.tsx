import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Lock,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  Reply,
  Trash2
} from 'lucide-react'
import type {
  AuthState,
  DiscussionEvent,
  DiscussionSummary,
  DiscussionType,
  DiscussionStatusFilter,
  RepoKind
} from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { diffTotals, isDiffTruncated, parseUnifiedDiff } from '@/lib/diff'
import { appendQuote } from '@/lib/quote'
import { repoHubUrl } from '@/lib/repo-open'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useToasts } from '@/components/ui/toaster'
import { DiffStat, DiffView } from '@/components/browse/DiffView'
import { MarkdownEditor } from '@/components/browse/MarkdownEditor'
import { MarkdownView } from '@/components/browse/MarkdownView'
import { ReactionBar } from '@/components/community/ReactionBar'
import { WRITE_DISCUSSIONS_SCOPE, scopeMissing } from '@/lib/scopes'
import { UserLink } from '@/components/profile/UserLink'
import { useHubSession } from '@/hooks/use-hub-session'
import { resolveLocale, useAppStore } from '@/stores/app'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'

const STATUS_VARIANT = {
  open: 'success',
  closed: 'neutral',
  merged: 'select',
  draft: 'neutral'
} as const

/** GitHub/HF-style PR glyph color per lifecycle state. */
const PR_ICON_COLOR: Record<DiscussionSummary['status'], string> = {
  open: 'text-success',
  closed: 'text-error',
  merged: 'text-select',
  draft: 'text-ink-faint'
}

type StatusFilter = DiscussionStatusFilter | 'all'

const STATUS_FILTERS: readonly StatusFilter[] = ['open', 'closed', 'all']

function useDiscussionList(
  kind: RepoKind,
  repoId: string,
  type: DiscussionType,
  status: StatusFilter,
  endpointKey: string
) {
  return useInfiniteQuery({
    queryKey: ['discussions', kind, repoId, type, status, endpointKey],
    queryFn: ({ pageParam }) =>
      invoke('hub:discussions', {
        kind,
        repoId,
        type,
        status: status === 'all' ? undefined : status,
        cursor: pageParam === '' ? undefined : pageParam
      }),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null
  })
}

/** Statuses with a localized word under detail:discussions.status.*. */
const KNOWN_STATUSES: readonly string[] = ['open', 'closed', 'merged', 'draft']

/** Icon tint for status-change timeline rows; unknown statuses fall back to faint ink. */
const STATUS_EVENT_COLOR: Record<string, string> = {
  open: 'text-success',
  closed: 'text-error',
  merged: 'text-select'
}

function hasBody(event: DiscussionEvent): boolean {
  return event.content !== undefined && event.content.trim() !== ''
}

/** Maintainer = the repo namespace is the signed-in user or one of their orgs. */
function isRepoMaintainer(auth: AuthState, repoId: string): boolean {
  if (auth.status !== 'signedIn') return false
  const namespace = repoId.split('/')[0]
  return namespace === auth.user.name || auth.user.orgs.some((org) => org.name === namespace)
}

/** Real Hub comment ids are 24-hex; the mapper synthesizes String(i) for id-less events. */
const HEX_ID_RE = /^[0-9a-f]{24}$/

/**
 * One entry of the thread timeline. Comments (and unknown event types that carry
 * markdown) render as cards; commits and status changes render as lighter rows.
 * Unknown event types with no content render nothing. Comment cards surface
 * emoji reactions — actionable when a Hub web session is connected and the
 * event has a real comment id, read-only counts otherwise.
 */
function ThreadEvent({
  event,
  kind,
  repoId,
  locale,
  hubUrl,
  currentUser,
  onReact,
  reactPending,
  onQuote
}: {
  event: DiscussionEvent
  kind: RepoKind
  repoId: string
  locale: string
  /** Hub discussion URL for the read-only fallback affordance. */
  hubUrl: string
  currentUser?: string
  onReact?: (commentId: string, emoji: string, active: boolean) => void
  reactPending?: boolean
  /** Quote this comment into the reply box (only when replying is available). */
  onQuote?: (content: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation(['detail'])

  if (event.type === 'commit') {
    return (
      <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-ink-muted">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-panel ring-1 ring-border">
          <GitCommitHorizontal className="size-3.5 text-ink-faint" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{event.subject}</span>
        {event.oid !== undefined && event.oid !== '' && (
          <code className="shrink-0 font-mono text-[11px] text-ink-faint">
            {event.oid.slice(0, 7)}
          </code>
        )}
        <span className="shrink-0 text-[11.5px] text-ink-faint">
          {event.author !== undefined && event.author !== '' && (
            <UserLink username={event.author} className="hover:text-ink" />
          )}
          {' · '}
          {formatRelativeTime(event.createdAt, locale)}
        </span>
      </div>
    )
  }

  if (event.type === 'status-change') {
    const status = event.status
    if (status === undefined || status === '') return null
    const statusWord = KNOWN_STATUSES.includes(status)
      ? t(`detail:discussions.status.${status}`)
      : status
    return (
      <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-ink-muted">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-panel ring-1 ring-border">
          <GitPullRequest
            className={cn('size-3.5', STATUS_EVENT_COLOR[status] ?? 'text-ink-faint')}
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {t('detail:pr.statusChanged', { author: event.author ?? '', status: statusWord })}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-faint">
          {formatRelativeTime(event.createdAt, locale)}
        </span>
      </div>
    )
  }

  if (event.type === 'title-change') {
    if (event.titleFrom === undefined || event.titleTo === undefined) return null
    return (
      <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-ink-muted">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-panel ring-1 ring-border">
          <Pencil className="size-3.5 text-ink-faint" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {t('detail:pr.titleChanged', {
            author: event.author ?? '',
            from: event.titleFrom,
            to: event.titleTo
          })}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-faint">
          {formatRelativeTime(event.createdAt, locale)}
        </span>
      </div>
    )
  }

  if (event.type === 'pinning-change') {
    if (event.pinned === undefined) return null
    return (
      <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-ink-muted">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-panel ring-1 ring-border">
          <Pin className="size-3.5 text-ink-faint" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {t(event.pinned ? 'detail:pr.pinned' : 'detail:pr.unpinned', {
            author: event.author ?? ''
          })}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-faint">
          {formatRelativeTime(event.createdAt, locale)}
        </span>
      </div>
    )
  }

  if (event.type === 'locking-change') {
    if (event.locked === undefined) return null
    return (
      <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-ink-muted">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full ring-1',
            event.locked ? 'bg-error/10 ring-error/30' : 'bg-panel ring-border'
          )}
        >
          <Lock
            className={cn('size-3.5', event.locked ? 'text-error' : 'text-ink-faint')}
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {t(event.locked ? 'detail:pr.locked' : 'detail:pr.unlocked', {
            author: event.author ?? ''
          })}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-faint">
          {formatRelativeTime(event.createdAt, locale)}
        </span>
      </div>
    )
  }

  if (event.type === 'ref-deleted') {
    return (
      <div className="flex items-center gap-2.5 px-1 text-[12.5px] text-ink-muted">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-panel ring-1 ring-border">
          <Trash2 className="size-3.5 text-ink-faint" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {t('detail:pr.refDeleted', { author: event.author ?? '' })}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-faint">
          {formatRelativeTime(event.createdAt, locale)}
        </span>
      </div>
    )
  }

  // Comments always render (empty ones get a placeholder); other event types
  // only when they carry markdown content.
  if (event.type !== 'comment' && !hasBody(event)) return null
  const reactions = event.reactions ?? []
  const canReact = onReact !== undefined && HEX_ID_RE.test(event.id)
  return (
    <div className="rounded-lg border border-border-card bg-card-gradient p-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-muted">
        {event.author !== undefined && event.author !== '' && (
          <UserLink username={event.author} className="font-medium text-ink-strong" />
        )}
        <span className="text-ink-faint">{formatRelativeTime(event.createdAt, locale)}</span>
        {onQuote !== undefined && hasBody(event) && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-1.5 text-ink-faint"
            onClick={() => onQuote(event.content ?? '')}
          >
            <Reply className="size-3.5" aria-hidden />
            {t('detail:discussions.quoteReply')}
          </Button>
        )}
      </div>
      {hasBody(event) ? (
        <MarkdownView markdown={event.content ?? ''} kind={kind} repoId={repoId} />
      ) : (
        <p className="text-[12.5px] text-ink-faint italic">{t('detail:pr.noDescription')}</p>
      )}
      {(reactions.length > 0 || canReact) && (
        <div className="mt-2.5">
          <ReactionBar
            reactions={reactions}
            postUrl={hubUrl}
            locale={locale}
            currentUser={currentUser}
            onToggle={canReact ? (emoji, active) => onReact(event.id, emoji, active) : undefined}
            pending={reactPending}
          />
        </div>
      )}
    </div>
  )
}

function Thread({
  kind,
  repoId,
  num,
  onBack
}: {
  kind: RepoKind
  repoId: string
  num: number
  onBack: () => void
}): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common', 'auth'])
  const auth = useAppStore((s) => s.auth)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = useHubEndpointKey()
  const [reply, setReply] = useState('')
  // Bumped by a comment's "quote reply" to focus the editor after prefilling.
  const [quoteNonce, setQuoteNonce] = useState(0)
  const [tab, setTab] = useState('discussion')
  // Fetch the diff lazily: only once the Files-changed tab was activated.
  const [filesTabVisited, setFilesTabVisited] = useState(false)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)

  const thread = useQuery({
    queryKey: ['discussion', kind, repoId, num, endpointKey],
    queryFn: () => invoke('hub:discussionDetail', { kind, repoId, num })
  })
  const isPr = thread.data?.isPullRequest === true

  const diff = useQuery({
    queryKey: ['discussionDiff', kind, repoId, num, endpointKey],
    queryFn: () => invoke('hub:discussionDiff', { kind, repoId, num }),
    enabled: isPr && filesTabVisited,
    retry: false
  })

  const parsedDiff = useMemo(
    () => (diff.data !== undefined ? parseUnifiedDiff(diff.data) : null),
    [diff.data]
  )
  const totals = useMemo(() => (parsedDiff !== null ? diffTotals(parsedDiff) : null), [parsedDiff])
  const prRef = `refs/pr/${num}`

  const send = useMutation({
    mutationFn: () => invoke('hub:discussionComment', { kind, repoId, num, comment: reply }),
    onSuccess: () => {
      setReply('')
      void queryClient.invalidateQueries({ queryKey: ['discussion', kind, repoId, num] })
    },
    onError: (err) => push(err.message, 'error')
  })

  // Emoji reactions on comments need the Hub web session (cookie); the thread
  // refetch after settle is authoritative (server TTL is short).
  const hubSession = useHubSession()
  const currentUser = auth.status === 'signedIn' ? auth.user.name : undefined
  const react = useMutation({
    mutationFn: ({
      commentId,
      emoji,
      active
    }: {
      commentId: string
      emoji: string
      active: boolean
    }) =>
      invoke('hub:discussionReactionSet', {
        kind,
        repoId,
        num,
        commentId,
        reaction: emoji,
        active
      }),
    onError: (err) => push(t('detail:discussions.reactionError', { error: err.message }), 'error'),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ['discussion', kind, repoId, num] })
  })
  const discussionHubUrl = `${repoHubUrl(kind, repoId, settings.hubEndpoint)}/discussions/${num}`

  // Maintainer actions (owner of the repo namespace only).
  const isMaintainer = isRepoMaintainer(auth, repoId)
  const maintainerGated = isMaintainer && scopeMissing(auth, WRITE_DISCUSSIONS_SCOPE)
  // null = not editing; otherwise the in-progress title draft.
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeComment, setMergeComment] = useState('')

  const refreshThread = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['discussion', kind, repoId, num] })
    void queryClient.invalidateQueries({ queryKey: ['discussions', kind, repoId] })
  }

  const setStatus = useMutation({
    mutationFn: (status: 'open' | 'closed') =>
      invoke('hub:discussionStatusSet', {
        kind,
        repoId,
        num,
        status,
        // A non-empty reply draft rides along as the status-change comment.
        comment: reply.trim() === '' ? undefined : reply.trim()
      }),
    onSuccess: () => {
      setReply('')
      push(t('detail:maintainer.statusUpdated'), 'success')
      refreshThread()
    },
    onError: (err) => push(err.message, 'error')
  })

  const saveTitle = useMutation({
    mutationFn: (title: string) => invoke('hub:discussionTitleSet', { kind, repoId, num, title }),
    onSuccess: () => {
      setTitleDraft(null)
      push(t('detail:maintainer.titleUpdated'), 'success')
      refreshThread()
    },
    onError: (err) => push(err.message, 'error')
  })

  const merge = useMutation({
    mutationFn: () =>
      invoke('hub:prMerge', {
        kind,
        repoId,
        num,
        comment: mergeComment.trim() === '' ? undefined : mergeComment.trim()
      }),
    onSuccess: () => {
      setMergeOpen(false)
      setMergeComment('')
      push(t('detail:maintainer.merged'), 'success')
      refreshThread()
    },
    onError: (err) => push(err.message, 'error')
  })

  const status = thread.data?.status
  // The hub:discussionTitleSet schema requires 3-200 characters.
  const titleValid = titleDraft !== null && titleDraft.trim().length >= 3

  const maintainerBar = thread.data !== undefined && isMaintainer && (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
      {maintainerGated ? (
        <p className="text-[12px] text-ink-faint">{t('auth:missingWriteScope')}</p>
      ) : titleDraft !== null ? (
        <>
          <Input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            maxLength={200}
            aria-label={t('detail:maintainer.editTitle')}
            className="h-7 min-w-0 flex-1 text-[12.5px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && titleValid && !saveTitle.isPending) {
                saveTitle.mutate(titleDraft.trim())
              }
              if (e.key === 'Escape') setTitleDraft(null)
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!titleValid}
            loading={saveTitle.isPending}
            onClick={() => saveTitle.mutate(titleDraft.trim())}
          >
            {t('detail:maintainer.titleSave')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setTitleDraft(null)}>
            {t('common:cancel')}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" size="sm" onClick={() => setTitleDraft(thread.data?.title ?? '')}>
            <Pencil className="size-3.5" aria-hidden />
            {t('detail:maintainer.editTitle')}
          </Button>
          {(status === 'open' || status === 'closed') && (
            <Button
              variant="secondary"
              size="sm"
              loading={setStatus.isPending}
              onClick={() => setStatus.mutate(status === 'open' ? 'closed' : 'open')}
            >
              {status === 'open'
                ? reply.trim() === ''
                  ? t('detail:maintainer.close')
                  : t('detail:maintainer.closeWithComment')
                : reply.trim() === ''
                  ? t('detail:maintainer.reopen')
                  : t('detail:maintainer.reopenWithComment')}
            </Button>
          )}
          {isPr && status === 'open' && (
            <Button variant="secondary" size="sm" onClick={() => setMergeOpen(true)}>
              <GitMerge className="size-3.5" aria-hidden />
              {t('detail:maintainer.merge')}
            </Button>
          )}
        </>
      )}
    </div>
  )

  const mergeDialog = (
    <Dialog open={mergeOpen} onOpenChange={(open) => !open && setMergeOpen(false)}>
      <DialogContent>
        <DialogTitle className="text-[14px] font-semibold">
          {t('detail:maintainer.mergeConfirmTitle', { num })}
        </DialogTitle>
        <DialogDescription className="mt-2 text-[13px] text-ink-muted">
          {t('detail:maintainer.mergeConfirmBody')}
        </DialogDescription>
        <Textarea
          value={mergeComment}
          onChange={(e) => setMergeComment(e.target.value)}
          placeholder={t('detail:maintainer.mergeCommentPlaceholder')}
          rows={3}
          className="mt-3"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setMergeOpen(false)}>
            {t('common:cancel')}
          </Button>
          <Button variant="cta" size="sm" loading={merge.isPending} onClick={() => merge.mutate()}>
            {t('detail:maintainer.merge')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )

  const conversation = (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {thread.isLoading && <Skeleton className="h-24" />}
      <div className="flex flex-col gap-3">
        {thread.data?.events.map((event) => (
          <ThreadEvent
            key={event.id}
            event={event}
            kind={kind}
            repoId={repoId}
            locale={locale}
            hubUrl={discussionHubUrl}
            currentUser={currentUser}
            onReact={
              hubSession
                ? (commentId, emoji, active) => react.mutate({ commentId, emoji, active })
                : undefined
            }
            reactPending={react.isPending}
            onQuote={
              auth.status === 'signedIn'
                ? (content) => {
                    setReply((prev) => appendQuote(prev, content))
                    setQuoteNonce((n) => n + 1)
                  }
                : undefined
            }
          />
        ))}
      </div>
    </div>
  )

  const composer = (
    <div className="border-t p-3">
      {auth.status === 'signedIn' ? (
        <div className="flex flex-col gap-2">
          <MarkdownEditor
            value={reply}
            onChange={setReply}
            kind={kind}
            repoId={repoId}
            placeholder={t('detail:discussions.replyPlaceholder')}
            focusSignal={quoteNonce}
            onSubmit={() => {
              if (reply.trim() !== '' && !send.isPending) send.mutate()
            }}
          />
          <div className="flex justify-end">
            <Button
              variant="cta"
              size="sm"
              disabled={reply.trim() === ''}
              loading={send.isPending}
              onClick={() => send.mutate()}
            >
              {send.isPending ? t('detail:discussions.sending') : t('detail:discussions.send')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-center text-[12.5px] text-ink-muted">
          {t('detail:discussions.signInToReply')}
        </p>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t('common:back')}>
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <span className="min-w-0 truncate text-[13.5px] font-medium text-ink-strong">
          {thread.data?.title}
        </span>
        {thread.data && (
          <Badge variant={STATUS_VARIANT[thread.data.status]}>
            {t(`detail:discussions.status.${thread.data.status}`)}
          </Badge>
        )}
      </div>
      {maintainerBar}
      {mergeDialog}
      {isPr && (
        <div
          aria-label={t('detail:pr.refsLabel')}
          className="flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5"
        >
          {thread.data?.baseRef !== undefined && (
            <code className="rounded border bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
              {thread.data.baseRef}
            </code>
          )}
          <ArrowLeft className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
          <code className="rounded border bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {prRef}
          </code>
        </div>
      )}
      {isPr ? (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value)
            if (value === 'files') setFilesTabVisited(true)
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="shrink-0 px-2">
            <TabsTrigger value="discussion">{t('detail:pr.tabDiscussion')}</TabsTrigger>
            <TabsTrigger value="files">
              <span className="inline-flex items-center gap-1.5">
                {t('detail:pr.tabFiles')}
                {totals !== null && (
                  <DiffStat additions={totals.additions} deletions={totals.deletions} />
                )}
              </span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="discussion" className="min-h-0 flex-1">
            <div className="flex h-full flex-col">
              {conversation}
              {composer}
            </div>
          </TabsContent>
          <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto">
            {diff.isLoading && (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-8" />
                <Skeleton className="h-40" />
              </div>
            )}
            {diff.isError && (
              <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                <p className="max-w-sm text-[12.5px] text-ink-muted">{diff.error.message}</p>
                <Button size="sm" onClick={() => void diff.refetch()}>
                  {t('common:retry')}
                </Button>
              </div>
            )}
            {parsedDiff !== null && (
              <DiffView
                files={parsedDiff}
                truncated={diff.data !== undefined && isDiffTruncated(diff.data)}
              />
            )}
          </TabsContent>
        </Tabs>
      ) : (
        <>
          {conversation}
          {composer}
        </>
      )}
    </div>
  )
}

function SegmentButton({
  active,
  onClick,
  label,
  count
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded px-2.5 py-1 text-[12.5px] font-medium transition-colors duration-150',
        active ? 'bg-bg text-ink-strong ring-1 ring-border' : 'text-ink-muted hover:text-ink'
      )}
    >
      {label}
      {count !== undefined && <span className="nums text-[11px] text-ink-faint">{count}</span>}
    </button>
  )
}

export function DiscussionsPanel({
  kind,
  repoId,
  onActiveDiscussion
}: {
  kind: RepoKind
  repoId: string
  /** Mirrors the currently open discussion number to the parent (deep-link target). */
  onActiveDiscussion?: (num: number | null) => void
}): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = useHubEndpointKey()
  const [selected, setSelected] = useState<number | null>(null)
  const [segment, setSegment] = useState<DiscussionType>('discussion')
  const [status, setStatus] = useState<StatusFilter>('open')

  const select = (num: number | null): void => {
    setSelected(num)
    onActiveDiscussion?.(num)
  }
  // Clear the parent's deep-link target when the panel unmounts (tab switch /
  // repo change) so the open-on-Hub button falls back to the repo home page.
  useEffect(() => () => onActiveDiscussion?.(null), [onActiveDiscussion])

  // Keep both feeds mounted so their server-reported totals remain visible.
  // Switching segments no longer trades one useful count for the other.
  const discussionList = useDiscussionList(kind, repoId, 'discussion', status, endpointKey)
  const pullRequestList = useDiscussionList(kind, repoId, 'pull_request', status, endpointKey)
  const list = segment === 'discussion' ? discussionList : pullRequestList
  const discussions = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data]
  )
  const discussionCount =
    discussionList.data?.pages[0]?.total ??
    (discussionList.data
      ? discussionList.data.pages.reduce((sum, page) => sum + page.items.length, 0)
      : undefined)
  const pullRequestCount =
    pullRequestList.data?.pages[0]?.total ??
    (pullRequestList.data
      ? pullRequestList.data.pages.reduce((sum, page) => sum + page.items.length, 0)
      : undefined)

  const changeSegment = (next: DiscussionType): void => {
    setSegment(next)
    if (selected !== null) select(null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-0.5 rounded-md border bg-panel p-0.5">
          <SegmentButton
            active={segment === 'discussion'}
            onClick={() => changeSegment('discussion')}
            label={t('detail:discussions.segment.discussions')}
            count={discussionCount}
          />
          <SegmentButton
            active={segment === 'pull_request'}
            onClick={() => changeSegment('pull_request')}
            label={t('detail:discussions.segment.pullRequests')}
            count={pullRequestCount}
          />
        </div>
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setStatus(filter)}
              aria-pressed={status === filter}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11.5px] transition-colors duration-150',
                status === filter
                  ? 'border-select/40 bg-select/10 text-select dark:text-ink-strong'
                  : 'text-ink-muted hover:bg-panel hover:text-ink'
              )}
            >
              {t(`detail:discussions.filter.${filter}`)}
            </button>
          ))}
          <NewDiscussionButton
            kind={kind}
            repoId={repoId}
            defaultPullRequest={segment === 'pull_request'}
            onCreated={(num) => {
              void discussionList.refetch()
              void pullRequestList.refetch()
              select(num)
            }}
          />
        </div>
      </div>
      {selected !== null ? (
        <div className="min-h-0 flex-1">
          <Thread kind={kind} repoId={repoId} num={selected} onBack={() => select(null)} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {list.isLoading && (
            <div className="flex flex-col gap-1 p-1">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          )}
          {list.isError && (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <p className="max-w-sm text-[12.5px] text-ink-muted">{list.error.message}</p>
              <Button size="sm" onClick={() => void list.refetch()}>
                {t('common:retry')}
              </Button>
            </div>
          )}
          {list.data !== undefined && discussions.length === 0 && (
            <div className="p-6 text-center text-[13px] text-ink-muted">
              {segment === 'pull_request' ? t('detail:pr.empty') : t('detail:discussions.empty')}
            </div>
          )}
          {discussions.map((discussion: DiscussionSummary) => (
            <button
              key={discussion.num}
              type="button"
              onClick={() => select(discussion.num)}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-150 outline-none hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            >
              {discussion.isPullRequest ? (
                <GitPullRequest
                  className={cn('size-4 shrink-0', PR_ICON_COLOR[discussion.status])}
                  aria-label={t('detail:discussions.pullRequest')}
                />
              ) : (
                <MessageSquare className="size-4 shrink-0 text-ink-faint" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px]">{discussion.title}</span>
              <Badge variant={STATUS_VARIANT[discussion.status]}>
                {t(`detail:discussions.status.${discussion.status}`)}
              </Badge>
              <span className="w-20 shrink-0 text-right text-[11.5px] text-ink-faint">
                {formatRelativeTime(discussion.createdAt, locale)}
              </span>
            </button>
          ))}
          {list.hasNextPage && (
            <div className="flex justify-center py-2">
              <Button
                variant="secondary"
                size="sm"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {t('detail:discussions.loadMore')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * "New" button + dialog for opening a discussion or draft PR on the repo
 * (the same API huggingface_hub's create_discussion/create_pull_request use;
 * bearer-token authenticated). The description editor supports attachment
 * upload whenever a Hub web session is connected.
 */
function NewDiscussionButton({
  kind,
  repoId,
  defaultPullRequest,
  onCreated
}: {
  kind: RepoKind
  repoId: string
  /** Preselect the PR flavor when the panel is on the Pull requests segment. */
  defaultPullRequest: boolean
  onCreated: (num: number) => void
}): React.JSX.Element | null {
  const { t } = useTranslation(['detail', 'common', 'auth'])
  const auth = useAppStore((s) => s.auth)
  const push = useToasts((s) => s.push)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [asPr, setAsPr] = useState(defaultPullRequest)

  const create = useMutation({
    mutationFn: () =>
      invoke('hub:discussionCreate', {
        kind,
        repoId,
        title: title.trim(),
        description: description.trim(),
        pullRequest: asPr
      }),
    onSuccess: ({ num }) => {
      setOpen(false)
      setTitle('')
      setDescription('')
      push(t('detail:discussions.create.created'), 'success')
      onCreated(num)
    },
    onError: (err) => push(t('detail:discussions.create.error', { error: err.message }), 'error')
  })

  if (auth.status !== 'signedIn') return null
  const missingScope = scopeMissing(auth, WRITE_DISCUSSIONS_SCOPE)

  return (
    <>
      <Button
        variant="cta"
        size="sm"
        className="ml-1 h-6 px-2 text-[11.5px]"
        onClick={() => {
          setAsPr(defaultPullRequest)
          setOpen(true)
        }}
      >
        <Plus className="size-3.5" aria-hidden />
        {t('detail:discussions.create.new')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[34rem]">
          <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold">
            {asPr ? (
              <GitPullRequest className="size-4" aria-hidden />
            ) : (
              <MessageSquare className="size-4" aria-hidden />
            )}
            {t('detail:discussions.create.title', { repoId })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('detail:discussions.create.title', { repoId })}
          </DialogDescription>

          {missingScope ? (
            <p className="mt-3 text-[12.5px] text-ink-faint">{t('auth:missingWriteScope')}</p>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex items-center gap-0.5 self-start rounded-md border bg-panel p-0.5">
                <SegmentButton
                  active={!asPr}
                  onClick={() => setAsPr(false)}
                  label={t('detail:discussions.create.discussion')}
                />
                <SegmentButton
                  active={asPr}
                  onClick={() => setAsPr(true)}
                  label={t('detail:discussions.create.pullRequest')}
                />
              </div>
              {asPr && (
                <p className="text-[12px] text-ink-faint">
                  {t('detail:discussions.create.prHint')}
                </p>
              )}
              <Input
                value={title}
                maxLength={200}
                placeholder={t('detail:discussions.create.titlePlaceholder')}
                onChange={(e) => setTitle(e.target.value)}
              />
              <MarkdownEditor
                value={description}
                onChange={setDescription}
                kind={kind}
                repoId={repoId}
                placeholder={t('detail:discussions.create.bodyPlaceholder')}
              />
              <div className="flex justify-end gap-2 border-t pt-3">
                <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
                  {t('common:cancel')}
                </Button>
                <Button
                  variant="cta"
                  size="sm"
                  loading={create.isPending}
                  disabled={title.trim() === '' || description.trim() === ''}
                  onClick={() => create.mutate()}
                >
                  {t('detail:discussions.create.submit')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

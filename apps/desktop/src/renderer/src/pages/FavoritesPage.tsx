import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Columns3, Heart, Star, X } from 'lucide-react'
import type { FavoriteItem, RepoKind, RepoSummary } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { openRepo } from '@/lib/repo-open'
import { formatCount, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { pushUndo } from '@/components/ui/toaster'
import { resolveLocale, useAppStore } from '@/stores/app'

function RepoRow({
  kind,
  repoId,
  pipelineTag,
  likes,
  meta,
  onOpen,
  onCompare,
  onRemove
}: {
  kind: RepoKind
  repoId: string
  pipelineTag?: string
  likes: number
  meta: string
  onOpen: () => void
  onCompare?: () => void
  onRemove?: () => void
}): React.JSX.Element {
  const { t } = useTranslation(['common'])
  const locale = resolveLocale(
    useAppStore((s) => s.settings),
    useAppStore((s) => s.appInfo)
  )
  return (
    <div className="group flex items-center gap-2.5 rounded-lg border border-border-card bg-card-gradient px-3 py-2.5 transition-colors duration-150 hover:border-border">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
      >
        <Badge variant="outline">{t(`common:kind.${kind}`)}</Badge>
        <span className="min-w-0 truncate font-mono text-[13px] font-medium text-ink-strong transition-colors duration-150 group-hover:text-hover-title">
          {repoId}
        </span>
        {pipelineTag && (
          <span className="hidden text-[11.5px] text-ink-faint sm:block">{pipelineTag}</span>
        )}
        <span className="nums ml-auto flex items-center gap-1.5 text-[11.5px] text-ink-faint">
          <span className="flex items-center gap-0.5">
            <Star className="size-3" aria-hidden />
            {formatCount(likes, locale)}
          </span>
          <span className="text-decor" aria-hidden>
            ·
          </span>
          <span>{meta}</span>
        </span>
      </button>
      {onCompare && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Add ${repoId} to compare`}
          onClick={onCompare}
        >
          <Columns3 className="size-4" aria-hidden />
        </Button>
      )}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common:remove')}
          className="text-ink-faint hover:text-ink-strong focus-visible:text-ink-strong"
          onClick={onRemove}
        >
          <X className="size-4" aria-hidden />
        </Button>
      )}
    </div>
  )
}

export function FavoritesPage(): React.JSX.Element {
  const { t } = useTranslation(['nav', 'common', 'browse', 'detail'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const auth = useAppStore((s) => s.auth)
  const locale = resolveLocale(settings, appInfo)
  const [tab, setTab] = useState('local')

  const favorites = useQuery({
    queryKey: ['favorites'],
    queryFn: () => invoke('favorites:list', undefined)
  })
  const username = auth.status === 'signedIn' ? auth.user.name : undefined
  const likes = useQuery({
    queryKey: ['user-likes', username],
    queryFn: () => invoke('hub:userLikes', { username: username ?? '' }),
    enabled: username !== undefined
  })
  const remove = useMutation({
    mutationFn: (fav: FavoriteItem) =>
      invoke('favorites:remove', { kind: fav.kind, repoId: fav.repoId }),
    onSuccess: (list, fav) => {
      queryClient.setQueryData(['favorites'], list)
      pushUndo(t('detail:favoriteRemoved'), {
        label: t('common:undo'),
        onClick: () => {
          void invoke('favorites:add', { summary: fav.summary }).then((restored) =>
            queryClient.setQueryData(['favorites'], restored)
          )
        }
      })
    }
  })

  const open = (kind: RepoKind, repoId: string): void => {
    openRepo(kind, repoId, settings.repoOpenTarget, navigate, settings.hubEndpoint)
  }

  const localList = (): React.JSX.Element => {
    if (favorites.isLoading) {
      return (
        <div className="flex flex-col gap-1">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="flex h-[46px] flex-col justify-center gap-1.5 rounded-lg border border-border-card px-3"
            >
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      )
    }
    if (favorites.error) {
      return (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="max-w-72 text-[13px] text-ink-muted">{t('common:error.network')}</p>
          <Button size="sm" onClick={() => void favorites.refetch()}>
            {t('common:retry')}
          </Button>
        </div>
      )
    }
    if (favorites.data?.length === 0) {
      return (
        <EmptyState
          icon={Star}
          title={t('detail:favoritesEmpty.title')}
          body={t('detail:favoritesEmpty.body')}
        />
      )
    }
    return (
      <div className="flex flex-col gap-1">
        {favorites.data?.map((fav) => (
          <RepoRow
            key={`${fav.kind}:${fav.repoId}`}
            kind={fav.kind}
            repoId={fav.repoId}
            pipelineTag={fav.summary.pipelineTag}
            likes={fav.summary.likes}
            meta={formatRelativeTime(fav.addedAt, locale)}
            onOpen={() => open(fav.kind, fav.repoId)}
            onCompare={
              fav.kind === 'model'
                ? () => void navigate(`/compare?models=${encodeURIComponent(fav.repoId)}`)
                : undefined
            }
            onRemove={() => remove.mutate(fav)}
          />
        ))}
      </div>
    )
  }

  const hubList = (): React.JSX.Element => {
    if (!username) {
      return (
        <EmptyState
          icon={Heart}
          title={t('detail:favoritesEmpty.hubSignedOutTitle')}
          body={t('detail:favoritesEmpty.hubSignedOutBody')}
        />
      )
    }
    if (likes.isLoading) {
      return (
        <div className="flex flex-col gap-1">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[46px]" />
          ))}
        </div>
      )
    }
    if (likes.error) {
      return (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="max-w-72 text-[13px] text-ink-muted">{t('common:error.network')}</p>
          <Button size="sm" onClick={() => void likes.refetch()}>
            {t('common:retry')}
          </Button>
        </div>
      )
    }
    if (!likes.data?.length) {
      return (
        <EmptyState
          icon={Heart}
          title={t('detail:favoritesEmpty.hubTitle')}
          body={t('detail:favoritesEmpty.hubBody')}
        />
      )
    }
    return (
      <div className="flex flex-col gap-1">
        {likes.data.map((repo: RepoSummary) => (
          <RepoRow
            key={`${repo.kind}:${repo.id}`}
            kind={repo.kind}
            repoId={repo.id}
            pipelineTag={repo.pipelineTag}
            likes={repo.likes}
            meta={t('detail:favoritesEmpty.likedOnHub')}
            onOpen={() => open(repo.kind, repo.id)}
            onCompare={
              repo.kind === 'model'
                ? () => void navigate(`/compare?models=${encodeURIComponent(repo.id)}`)
                : undefined
            }
          />
        ))}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
        <h1 className="text-[15px] font-semibold text-ink-strong">{t('nav:favorites')}</h1>
        <p className="text-[12.5px] text-ink-faint">{t('detail:favoritesEmpty.splitHint')}</p>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="local">{t('nav:favoritesLocal')}</TabsTrigger>
            <TabsTrigger value="hub">{t('nav:favoritesHub')}</TabsTrigger>
          </TabsList>
          <TabsContent value="local" className="mt-3">
            {localList()}
          </TabsContent>
          <TabsContent value="hub" className="mt-3">
            {hubList()}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

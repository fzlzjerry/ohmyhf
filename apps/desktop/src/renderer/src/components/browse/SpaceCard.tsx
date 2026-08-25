import { useTranslation } from 'react-i18next'
import { Heart } from 'lucide-react'
import type { RepoSummary } from '@oh-my-huggingface/shared'
import { hubThemeColor } from '@/lib/theme-colors'
import { cn, formatCount } from '@/lib/utils'

export interface SpaceCardProps {
  repo: RepoSummary
  selected: boolean
  onSelect: (repo: RepoSummary) => void
  locale: string
}

export function SpaceCard({ repo, selected, onSelect, locale }: SpaceCardProps): React.JSX.Element {
  const { t } = useTranslation(['browse', 'common'])
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(repo)}
      className={cn(
        'relative flex h-full min-w-0 flex-col overflow-hidden rounded-lg p-2.5 text-left text-white outline-none',
        'transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-focus',
        selected && 'ring-2 ring-select'
      )}
      style={{
        background: `linear-gradient(135deg, ${hubThemeColor(repo.colorFrom)}, ${hubThemeColor(repo.colorTo)})`
      }}
    >
      {/* Bottom scrim keeps the white text readable on light gradients. */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-black/25 to-black/10"
        aria-hidden
      />
      <div className="relative flex w-full min-w-0 items-center gap-1.5">
        {repo.emoji && (
          <span className="shrink-0 text-[15px] leading-none" aria-hidden>
            {repo.emoji}
          </span>
        )}
        <span className="min-w-0 truncate text-[13px] font-semibold">{repo.name}</span>
      </div>
      {repo.shortDescription && (
        <p className="relative mt-1 line-clamp-2 text-[12px] leading-4 text-white/90">
          {repo.shortDescription}
        </p>
      )}
      <div className="relative mt-auto flex w-full items-center gap-2 pt-1.5 text-[11px] text-white/85">
        <span className="min-w-0 truncate">{repo.author}</span>
        {repo.runtimeStage === 'RUNNING' ? (
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            {t('common:running')}
          </span>
        ) : repo.runtimeStage ? (
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-white/90">
            <span className="size-1.5 rounded-full bg-white/50" aria-hidden />
            {repo.runtimeStage.toLowerCase().replace(/_/g, ' ')}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5" title={t('browse:likes')}>
          <Heart className="size-3" aria-hidden />
          <span className="nums">{formatCount(repo.likes, locale)}</span>
        </span>
      </div>
    </button>
  )
}

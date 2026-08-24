import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, MonitorOff, RotateCw } from 'lucide-react'
import type { RepoDetail, RepoRevisionSelection } from '@oh-my-huggingface/shared'
import { openExternal } from '@/lib/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { hubRepoUrl } from '@oh-my-huggingface/shared'
import { useAppStore } from '@/stores/app'

const ERROR_STAGES = new Set(['BUILD_ERROR', 'CONFIG_ERROR', 'RUNTIME_ERROR'])

/**
 * Embeds a live Space (its *.hf.space app) in a sandboxed iframe. Only mounted
 * while the "Run" tab is active — Radix unmounts inactive TabsContent, so
 * leaving the tab tears the iframe down and stops its network/CPU use.
 */
export function SpaceRunner({
  repoId,
  detail,
  selectedRevision,
  defaultRevision,
  onSelectRevision
}: {
  repoId: string
  detail: RepoDetail | undefined
  selectedRevision: RepoRevisionSelection
  defaultRevision?: string
  onSelectRevision: (revision: string) => void
}): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  // Bumping the key remounts the iframe — the only reliable cross-origin reload.
  const [frameKey, setFrameKey] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const hubUrl = hubRepoUrl('space', repoId, endpoint)
  const versionBanner = !selectedRevision.isDefault ? (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-warning/10 px-3 py-2 text-[12px] text-ink-muted">
      <span>
        {t('common:repro.space.liveWarning', {
          commit: selectedRevision.resolvedCommit.slice(0, 8)
        })}
      </span>
      {defaultRevision && (
        <Button variant="secondary" size="sm" onClick={() => onSelectRevision(defaultRevision)}>
          {t('common:repro.space.goDefault')}
        </Button>
      )}
    </div>
  ) : null

  if (!detail) {
    return (
      <div className="flex h-full flex-col">
        {versionBanner}
        <div className="flex flex-1 flex-col gap-3 p-4">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="min-h-0 w-full flex-1" />
        </div>
      </div>
    )
  }

  const stage = detail.runtimeStage ?? 'UNKNOWN'
  const domain = detail.spaceDomain

  if (stage !== 'RUNNING' || !domain) {
    const stageLabel = stage.toLowerCase().replace(/_/g, ' ')
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        {versionBanner}
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={MonitorOff}
            title={t('detail:run.notRunningTitle')}
            body={t('detail:run.notRunning', { stage: stageLabel })}
            action={
              <div className="flex flex-col items-center gap-2.5">
                <Badge variant={ERROR_STAGES.has(stage) ? 'error' : 'neutral'}>
                  <span className="size-1.5 rounded-full bg-current opacity-60" aria-hidden />
                  {stageLabel}
                </Badge>
                <Button variant="secondary" size="sm" onClick={() => openExternal(hubUrl)}>
                  <ExternalLink className="size-3.5" aria-hidden />
                  {t('common:openOnHub')}
                </Button>
              </div>
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {versionBanner}
      <div className="flex shrink-0 items-center gap-2 border-b py-1.5 pr-1.5 pl-3">
        <Badge variant="success" className="shrink-0">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          {t('common:running')}
        </Badge>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint"
          title={domain}
        >
          {domain}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('detail:run.reload')}
              onClick={() => {
                setLoaded(false)
                setFrameKey((k) => k + 1)
              }}
            >
              <RotateCw className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('detail:run.reload')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('common:openOnHub')}
              onClick={() => openExternal(hubUrl)}
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('common:openOnHub')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative min-h-0 flex-1">
        {!loaded && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg p-6">
            <Skeleton className="h-40 w-full max-w-md" />
            <p className="text-[12.5px] text-ink-muted">{t('detail:run.loading')}</p>
          </div>
        )}
        <iframe
          key={frameKey}
          src={`https://${domain}`}
          title={repoId}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
          allow="clipboard-read; clipboard-write; microphone; camera; fullscreen"
          className="block h-full w-full border-0 bg-white"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  )
}

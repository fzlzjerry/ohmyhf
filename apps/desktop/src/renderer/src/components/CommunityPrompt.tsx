import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { BarChart3, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PROJECT_REPOSITORY_URL, TELEMETRY_DOCUMENTATION_URL } from '@oh-my-huggingface/shared'
import { Button } from '@/components/ui/button'
import { useToasts } from '@/components/ui/toaster'
import { hasBlockingOverlay, useBlockingOverlay } from '@/hooks/use-blocking-overlay'
import { invoke } from '@/lib/ipc'
import { useAppStore } from '@/stores/app'

const PROMPT_DELAY_MS = 10_000
const PROMPT_RETRY_DELAY_MS = 30_000

type Prompt =
  | { kind: 'telemetry'; claimId: string; acknowledged: boolean }
  | { kind: 'star'; claimId: string; promptNumber: number | null }

type PushToast = ReturnType<typeof useToasts.getState>['push']

function pushProjectOpenRetry(push: PushToast, message: string, actionLabel: string): void {
  push(message, 'error', {
    duration: null,
    action: {
      label: actionLabel,
      onClick: () => retryProjectOpen(push, message, actionLabel)
    }
  })
}

function retryProjectOpen(push: PushToast, fallbackMessage: string, actionLabel: string): void {
  void invoke('system:openExternal', { url: PROJECT_REPOSITORY_URL }).catch((error: unknown) =>
    pushProjectOpenRetry(
      push,
      error instanceof Error ? error.message : fallbackMessage,
      actionLabel
    )
  )
}

function isForeground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * One quiet community card per app session. The telemetry opt-out disclosure
 * is always offered before the later Star reminder so users never receive two
 * asks at once. A Star claim is only consumed after this foreground renderer
 * acknowledges the visible card.
 */
export function CommunityPrompt(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const telemetryEnabled = useAppStore((s) => s.settings.telemetryEnabled)
  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen)
  const blockingOverlay = useBlockingOverlay()
  const setSettings = useAppStore((s) => s.setSettings)
  const push = useToasts((s) => s.push)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [pending, setPending] = useState(false)
  const [foreground, setForeground] = useState(isForeground)
  const [announcement, setAnnouncement] = useState('')
  const [attemptNumber, setAttemptNumber] = useState(0)
  const attemptInFlight = useRef(false)
  const askClaimedThisSession = useRef(false)
  const mounted = useRef(true)
  const consentAcksInFlight = useRef(new Set<string>())
  const starAcksInFlight = useRef(new Set<string>())
  const announcedPrompt = useRef<string | null>(null)
  const telemetryEnabledWhenShown = useRef<boolean | null>(null)
  const dismissPrompt = useCallback((): void => {
    announcedPrompt.current = null
    setAnnouncement('')
    setPrompt(null)
  }, [])

  // Settings can resolve the same disclosure while the card is temporarily
  // hidden. Dismiss only when the persisted preference changes; an enabled
  // opt-out default must not hide the first-run notice by itself.
  useEffect(() => {
    if (prompt?.kind !== 'telemetry') {
      telemetryEnabledWhenShown.current = null
      return
    }
    if (telemetryEnabledWhenShown.current === null) {
      telemetryEnabledWhenShown.current = telemetryEnabled
      return
    }
    if (telemetryEnabled === telemetryEnabledWhenShown.current) return
    let canceled = false
    window.queueMicrotask(() => {
      if (!canceled) dismissPrompt()
    })
    return () => {
      canceled = true
    }
  }, [dismissPrompt, prompt, telemetryEnabled])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const updateForeground = (): void => setForeground(isForeground())
    document.addEventListener('visibilitychange', updateForeground)
    window.addEventListener('focus', updateForeground)
    window.addEventListener('blur', updateForeground)
    return () => {
      document.removeEventListener('visibilitychange', updateForeground)
      window.removeEventListener('focus', updateForeground)
      window.removeEventListener('blur', updateForeground)
    }
  }, [])

  useEffect(() => {
    if (
      !foreground ||
      settingsOpen ||
      paletteOpen ||
      shortcutsOpen ||
      blockingOverlay ||
      prompt ||
      attemptInFlight.current ||
      askClaimedThisSession.current
    ) {
      return
    }
    const delay = attemptNumber === 0 ? PROMPT_DELAY_MS : PROMPT_RETRY_DELAY_MS
    const timer = window.setTimeout(() => {
      // Re-read browser state at the moment of the IPC call; a blur can race the
      // React state update that normally cancels this timer.
      if (!isForeground() || hasBlockingOverlay()) {
        setAttemptNumber((current) => current + 1)
        return
      }
      if (attemptInFlight.current || askClaimedThisSession.current) return
      attemptInFlight.current = true
      void (async () => {
        let claimed = false
        try {
          const telemetry = await invoke('telemetry:claimConsentPrompt', undefined)
          if (telemetry.show) {
            claimed = true
            askClaimedThisSession.current = true
            setPrompt({
              kind: 'telemetry',
              claimId: telemetry.claimId,
              acknowledged: false
            })
            return
          }
          const star = await invoke('starReminder:claim', undefined)
          if (star.show) {
            claimed = true
            askClaimedThisSession.current = true
            setPrompt({ kind: 'star', claimId: star.claimId, promptNumber: null })
          }
        } catch {
          // Community prompts are optional and must never affect app startup.
          // A later foreground retry can recover transient IPC or SQLite errors.
        } finally {
          attemptInFlight.current = false
          if (mounted.current && !claimed && !askClaimedThisSession.current) {
            setAttemptNumber((current) => current + 1)
          }
        }
      })()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [attemptNumber, blockingOverlay, foreground, paletteOpen, prompt, settingsOpen, shortcutsOpen])

  const telemetryClaimId = prompt?.kind === 'telemetry' ? prompt.claimId : null
  const telemetryAcknowledged = prompt?.kind === 'telemetry' && prompt.acknowledged
  const starClaimId = prompt?.kind === 'star' ? prompt.claimId : null
  const starPromptNumber = prompt?.kind === 'star' ? prompt.promptNumber : null
  const promptSuppressed =
    !foreground || settingsOpen || paletteOpen || shortcutsOpen || blockingOverlay

  useEffect(() => {
    if (promptSuppressed || !telemetryClaimId || telemetryAcknowledged) return
    // A blur or portal insertion can race the React state/MutationObserver
    // update. Re-read the DOM immediately before consuming a visible display.
    if (!isForeground() || hasBlockingOverlay()) return
    if (consentAcksInFlight.current.has(telemetryClaimId)) return
    consentAcksInFlight.current.add(telemetryClaimId)

    void invoke('telemetry:acknowledgeConsentPrompt', { claimId: telemetryClaimId })
      .then((result) => {
        if (!result.accepted) {
          setPrompt((current) =>
            current?.kind === 'telemetry' && current.claimId === telemetryClaimId ? null : current
          )
          return
        }
        setPrompt((current) =>
          current?.kind === 'telemetry' && current.claimId === telemetryClaimId
            ? { ...current, acknowledged: true }
            : current
        )
      })
      .catch(() => {
        // Leave the persistent reservation unconsumed so a later renderer can
        // reclaim it, but remove this card because its visible state is unknown.
        setPrompt((current) =>
          current?.kind === 'telemetry' && current.claimId === telemetryClaimId ? null : current
        )
      })
      .finally(() => consentAcksInFlight.current.delete(telemetryClaimId))
  }, [promptSuppressed, telemetryAcknowledged, telemetryClaimId])

  useEffect(() => {
    if (promptSuppressed || !starClaimId || starPromptNumber !== null) return
    if (!isForeground() || hasBlockingOverlay()) return
    if (starAcksInFlight.current.has(starClaimId)) return
    starAcksInFlight.current.add(starClaimId)

    void invoke('starReminder:acknowledgeShown', { claimId: starClaimId })
      .then((result) => {
        if (!result.accepted) {
          setPrompt((current) =>
            current?.kind === 'star' && current.claimId === starClaimId ? null : current
          )
          return
        }
        setPrompt((current) =>
          current?.kind === 'star' && current.claimId === starClaimId
            ? { ...current, promptNumber: result.promptNumber }
            : current
        )
      })
      .catch(() => {
        setPrompt((current) =>
          current?.kind === 'star' && current.claimId === starClaimId ? null : current
        )
      })
      .finally(() => starAcksInFlight.current.delete(starClaimId))
  }, [promptSuppressed, starClaimId, starPromptNumber])

  const promptAcknowledged = prompt
    ? prompt.kind === 'telemetry'
      ? prompt.acknowledged
      : prompt.promptNumber !== null
    : false
  const promptIdentity = prompt ? `${prompt.kind}:${prompt.claimId}` : null
  const promptTitle = prompt
    ? t(
        prompt.kind === 'telemetry'
          ? 'settings:community.telemetry.title'
          : 'settings:community.star.title'
      )
    : ''

  useEffect(() => {
    if (
      !prompt ||
      promptSuppressed ||
      !promptAcknowledged ||
      !promptIdentity ||
      announcedPrompt.current === promptIdentity
    ) {
      return
    }
    let canceled = false
    window.queueMicrotask(() => {
      if (canceled) return
      announcedPrompt.current = promptIdentity
      setAnnouncement(promptTitle)
    })
    return () => {
      canceled = true
    }
  }, [prompt, promptAcknowledged, promptIdentity, promptSuppressed, promptTitle])

  const respond = useCallback(
    async (action: 'open' | 'later' | 'disable'): Promise<void> => {
      if (pending || prompt?.kind !== 'star' || prompt.promptNumber === null) return
      setPending(true)
      try {
        const result = await invoke('starReminder:respond', {
          claimId: prompt.claimId,
          action
        })
        if (result.accepted && result.outcome === 'opened' && !result.externalOpened) {
          pushProjectOpenRetry(push, t('common:error.generic'), t('settings:community.star.open'))
        }
        dismissPrompt()
      } catch (error) {
        // Keep the reminder visible for retry when no atomic response was accepted.
        push(error instanceof Error ? error.message : t('common:error.generic'), 'error')
      } finally {
        setPending(false)
      }
    },
    [dismissPrompt, pending, prompt, push, t]
  )

  const declineTelemetry = useCallback(async (): Promise<void> => {
    if (pending || prompt?.kind !== 'telemetry' || !prompt.acknowledged) return
    setPending(true)
    try {
      const result = await invoke('telemetry:resolveConsentPrompt', {
        claimId: prompt.claimId,
        decision: 'decline'
      })
      if (!result.accepted) {
        push(t('common:error.generic'), 'error')
        return
      }
      const settings = await invoke('settings:set', { patch: { telemetryEnabled: false } })
      setSettings(settings)
      dismissPrompt()
    } catch (error) {
      // Keep the choice visible until main confirms the explicit local decision.
      push(error instanceof Error ? error.message : t('common:error.generic'), 'error')
    } finally {
      setPending(false)
    }
  }, [dismissPrompt, pending, prompt, push, setSettings, t])

  useEffect(() => {
    if (!prompt || promptSuppressed) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        pending ||
        !promptAcknowledged ||
        hasBlockingOverlay()
      ) {
        return
      }
      event.preventDefault()
      if (prompt.kind === 'telemetry') {
        void declineTelemetry()
      } else {
        void respond('later')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [declineTelemetry, pending, prompt, promptAcknowledged, promptSuppressed, respond])

  let card: React.ReactNode = null

  if (prompt && !promptSuppressed && prompt.kind === 'telemetry') {
    const enable = async (): Promise<void> => {
      if (pending) return
      setPending(true)
      try {
        const settings = await invoke('settings:set', { patch: { telemetryEnabled: true } })
        setSettings(settings)
        dismissPrompt()
      } catch (error) {
        push(error instanceof Error ? error.message : t('common:error.generic'), 'error')
      } finally {
        setPending(false)
      }
    }

    const openDetails = async (): Promise<void> => {
      try {
        await invoke('system:openExternal', { url: TELEMETRY_DOCUMENTATION_URL })
      } catch (error) {
        push(error instanceof Error ? error.message : t('common:error.generic'), 'error')
      }
    }

    card = (
      <PromptCard
        kind="telemetry"
        icon={BarChart3}
        title={t('settings:community.telemetry.title')}
        body={t('settings:community.telemetry.body')}
      >
        <Button
          data-community-action="telemetry-accept"
          size="sm"
          variant="cta"
          loading={pending}
          disabled={!prompt.acknowledged}
          onClick={() => void enable()}
        >
          {t('settings:community.telemetry.accept')}
        </Button>
        <Button
          data-community-action="telemetry-details"
          size="sm"
          variant="ghost"
          disabled={pending || !prompt.acknowledged}
          onClick={() => void openDetails()}
        >
          {t('settings:community.telemetry.details')}
        </Button>
        <Button
          data-community-action="telemetry-decline"
          size="sm"
          variant="ghost"
          disabled={pending || !prompt.acknowledged}
          onClick={() => void declineTelemetry()}
        >
          {t('settings:community.telemetry.decline')}
        </Button>
      </PromptCard>
    )
  } else if (prompt && !promptSuppressed && prompt.kind === 'star') {
    const acknowledged = prompt.promptNumber !== null
    const finalPrompt = (prompt.promptNumber ?? 0) >= 2
    card = (
      <PromptCard
        kind="star"
        icon={Star}
        title={t('settings:community.star.title')}
        body={t('settings:community.star.body')}
      >
        <Button
          data-community-action="star-open"
          size="sm"
          variant="cta"
          loading={pending}
          disabled={!acknowledged}
          onClick={() => void respond('open')}
        >
          {!pending && <Star className="size-3.5" aria-hidden />}
          {t('settings:community.star.open')}
        </Button>
        <Button
          data-community-action="star-later"
          size="sm"
          variant="secondary"
          disabled={pending || !acknowledged}
          onClick={() => void respond('later')}
        >
          {t(finalPrompt ? 'settings:community.star.laterFinal' : 'settings:community.star.later')}
        </Button>
        {!finalPrompt && (
          <button
            type="button"
            data-community-action="star-disable"
            disabled={pending || !acknowledged}
            onClick={() => void respond('disable')}
            className="rounded-md px-1.5 py-1 text-[11.5px] text-ink-faint transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-50"
          >
            {t('settings:community.star.disable')}
          </button>
        )}
      </PromptCard>
    )
  }

  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {card}
    </>
  )
}

function PromptCard({
  kind,
  icon: Icon,
  title,
  body,
  children
}: {
  kind: Prompt['kind']
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
  children: React.ReactNode
}): React.JSX.Element {
  const titleId = useId()
  const bodyId = useId()
  return (
    <section
      role="region"
      data-community-prompt={kind}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-auto flex flex-col gap-3 rounded-xl border bg-elevated p-4 text-ink shadow-overlay"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-brand-ink">
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 id={titleId} className="text-[13.5px] font-semibold text-ink-strong">
            {title}
          </h2>
          <p id={bodyId} className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            {body}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">{children}</div>
    </section>
  )
}

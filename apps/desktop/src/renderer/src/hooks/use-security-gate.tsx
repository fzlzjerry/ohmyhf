import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Ban, ShieldQuestion } from 'lucide-react'
import type { SecurityPreflightRequest, SecurityPreflightResult } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

interface PendingConfirmation {
  result: SecurityPreflightResult
  resolve: (grantId: string | undefined) => void
  reject: (error: Error) => void
}

function securityError(result: SecurityPreflightResult): Error {
  const error = new Error(
    result.decision === 'block'
      ? `security.blocked:${result.reasons.join(',')}`
      : 'security.confirmationCanceled'
  )
  error.name = result.decision === 'block' ? 'SecurityBlockedError' : 'SecurityConfirmationError'
  return error
}

/** Renderer UX for the main-process SecurityGate. It never changes a decision. */
export function useSecurityGate(): {
  authorize: (request: SecurityPreflightRequest) => Promise<string | undefined>
  dialog: React.JSX.Element
} {
  const { t } = useTranslation('common')
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const closingByAction = useRef(false)

  const authorize = useCallback(
    async (request: SecurityPreflightRequest): Promise<string | undefined> => {
      const result = await invoke('security:preflight', { request })
      if (result.decision === 'allow') return undefined
      if (result.decision === 'block') throw securityError(result)
      return new Promise<string | undefined>((resolve, reject) => {
        setPending({ result, resolve, reject })
      })
    },
    []
  )

  const close = (accepted: boolean): void => {
    const current = pending
    if (!current) return
    closingByAction.current = true
    setPending(null)
    if (!accepted) current.reject(securityError(current.result))
    queueMicrotask(() => {
      closingByAction.current = false
    })
  }

  const confirm = async (): Promise<void> => {
    const current = pending
    const challengeId = current?.result.challengeId
    if (!current || !challengeId) return
    try {
      const grant = await invoke('security:confirm', { challengeId })
      closingByAction.current = true
      setPending(null)
      current.resolve(grant.grantId)
    } catch (error) {
      closingByAction.current = true
      setPending(null)
      current.reject(error instanceof Error ? error : new Error(String(error)))
    } finally {
      queueMicrotask(() => {
        closingByAction.current = false
      })
    }
  }

  const result = pending?.result
  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !closingByAction.current) close(false)
      }}
    >
      <DialogContent className="w-[34rem] max-h-[80vh] overflow-y-auto">
        <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-ink-strong">
          {result?.decision === 'block' ? (
            <Ban className="size-4 text-danger" aria-hidden />
          ) : result?.report.overall === 'unknown' ? (
            <ShieldQuestion className="size-4 text-warning" aria-hidden />
          ) : (
            <AlertTriangle className="size-4 text-warning" aria-hidden />
          )}
          {t('repro.security.dialogTitle')}
        </DialogTitle>
        <DialogDescription className="mt-2 text-[12.5px] text-ink-muted">
          {t('repro.security.exactScope')}
        </DialogDescription>
        {result && (
          <div className="mt-3 flex flex-col gap-3 text-[12px]">
            <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 rounded-md border bg-panel p-3">
              <dt className="text-ink-faint">{t('repro.security.repository')}</dt>
              <dd className="truncate font-mono">{result.report.repoId}</dd>
              <dt className="text-ink-faint">{t('repro.security.commit')}</dt>
              <dd className="font-mono">{result.report.resolvedCommit}</dd>
              <dt className="text-ink-faint">{t('repro.security.hubConclusion')}</dt>
              <dd className="font-medium">{t(`repro.security.status.${result.report.overall}`)}</dd>
              <dt className="text-ink-faint">{t('repro.security.checked')}</dt>
              <dd>{result.report.checkedAt}</dd>
            </dl>
            <div>
              <p className="mb-1 font-medium text-ink-strong">{t('repro.security.reasons')}</p>
              <ul className="list-disc space-y-1 pl-5 text-ink-muted">
                {result.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 font-medium text-ink-strong">{t('repro.security.evidence')}</p>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2 font-mono text-[11px]">
                {result.report.evidence.map((evidence, index) => (
                  <li key={`${evidence.source}:${evidence.filePath ?? ''}:${index}`}>
                    <span className="font-semibold">
                      {t(`repro.security.status.${evidence.status}`)}
                    </span>
                    {' · '}
                    {evidence.source}
                    {evidence.filePath ? ` · ${evidence.filePath}` : ''}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => close(false)}>
                {t('cancel')}
              </Button>
              <Button variant="cta" size="sm" onClick={() => void confirm()}>
                {t('repro.security.confirmAction')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )

  return { authorize, dialog }
}

import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SecurityPreflightResult } from '@oh-my-huggingface/shared'
import { Badge } from '@/components/ui/badge'

export function SecurityReportPanel({
  result,
  error
}: {
  result?: SecurityPreflightResult
  error?: Error | null
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const unknown = t('repro.general.unknownNotProvided')
  if (error) {
    return (
      <section className="border-t p-4" aria-labelledby="security-report-title">
        <h2 id="security-report-title" className="text-[13px] font-semibold text-ink-strong">
          {t('repro.security.title')}
        </h2>
        <p role="alert" className="mt-2 text-[12px] text-error">
          {t('repro.security.requestFailed', { error: error.message })}
        </p>
      </section>
    )
  }
  if (!result) {
    return (
      <section className="border-t p-4" aria-labelledby="security-report-title">
        <h2 id="security-report-title" className="text-[13px] font-semibold text-ink-strong">
          {t('repro.security.title')}
        </h2>
        <p className="mt-2 text-[12px] text-ink-muted">{t('repro.security.loading')}</p>
      </section>
    )
  }

  const report = result.report
  const Icon =
    result.decision === 'allow'
      ? ShieldCheck
      : result.decision === 'block'
        ? ShieldAlert
        : ShieldQuestion
  return (
    <section className="border-t p-4" aria-labelledby="security-report-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="security-report-title" className="text-[13px] font-semibold text-ink-strong">
          {t('repro.security.title')}
        </h2>
        <Badge
          variant={
            result.decision === 'allow'
              ? 'success'
              : result.decision === 'block'
                ? 'error'
                : 'warning'
          }
        >
          <Icon className="size-3" aria-hidden />
          {t(`repro.security.decision.${result.decision}`)}
        </Badge>
        <span className="font-mono text-[10.5px] text-ink-faint">
          {t('repro.security.checkedAt', {
            commit: report.resolvedCommit.slice(0, 12),
            checkedAt: report.checkedAt
          })}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-ink-faint">{t('repro.security.commitSignature')}</dt>
        <dd className="text-ink-muted">{report.commit?.signature ?? unknown}</dd>
        <dt className="text-ink-faint">{t('repro.security.commitAuthor')}</dt>
        <dd className="text-ink-muted">{report.commit?.authors?.join(', ') || unknown}</dd>
        <dt className="text-ink-faint">{t('repro.security.commitTime')}</dt>
        <dd className="text-ink-muted">{report.commit?.createdAt ?? unknown}</dd>
        <dt className="text-ink-faint">{t('repro.security.license')}</dt>
        <dd className="text-ink-muted">{report.provenance?.license ?? unknown}</dd>
        <dt className="text-ink-faint">{t('repro.security.library')}</dt>
        <dd className="text-ink-muted">{report.provenance?.library ?? unknown}</dd>
        <dt className="text-ink-faint">{t('repro.security.baseModel')}</dt>
        <dd className="text-ink-muted">{report.provenance?.baseModels?.join(', ') || unknown}</dd>
        <dt className="text-ink-faint">{t('repro.security.customCode')}</dt>
        <dd className="text-ink-muted">
          {report.provenance?.customCode === undefined
            ? unknown
            : report.provenance.customCode
              ? t('repro.security.declared')
              : t('repro.security.notDeclared')}
        </dd>
      </dl>

      {result.reasons.length > 0 && (
        <p className="mt-3 text-[11.5px] text-ink-muted">
          {t('repro.security.policyReasons', { reasons: result.reasons.join(', ') })}
        </p>
      )}
      <div className="mt-3 overflow-x-auto rounded-md border border-border-card">
        <table className="w-full min-w-[38rem] text-left text-[11px]">
          <thead className="bg-panel text-ink-faint">
            <tr>
              <th className="px-2 py-1.5 font-medium">{t('repro.security.conclusion')}</th>
              <th className="px-2 py-1.5 font-medium">{t('repro.security.source')}</th>
              <th className="px-2 py-1.5 font-medium">{t('repro.security.file')}</th>
              <th className="px-2 py-1.5 font-medium">{t('repro.security.timeDetails')}</th>
            </tr>
          </thead>
          <tbody>
            {report.evidence.map((evidence, index) => (
              <tr
                key={`${evidence.source}:${evidence.filePath ?? ''}:${index}`}
                className="border-t border-border-card"
              >
                <td className="px-2 py-1.5 font-medium">
                  {t(`repro.security.status.${evidence.status}`)}
                </td>
                <td className="px-2 py-1.5 font-mono text-ink-muted">{evidence.source}</td>
                <td className="max-w-72 truncate px-2 py-1.5 font-mono text-ink-muted">
                  {evidence.filePath ?? t('repro.security.repositoryLevel')}
                </td>
                <td className="px-2 py-1.5 text-ink-faint">
                  {[evidence.checkedAt, evidence.message].filter(Boolean).join(' · ') || unknown}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 font-mono text-[10px] break-all text-ink-faint">
        {t('repro.security.evidenceFingerprint', { fingerprint: report.fingerprint })}
      </p>
    </section>
  )
}

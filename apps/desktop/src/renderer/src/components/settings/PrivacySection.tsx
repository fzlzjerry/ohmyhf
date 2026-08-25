import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TELEMETRY_DOCUMENTATION_URL } from '@oh-my-huggingface/shared'
import { BarChart3, Download, FolderOpen, HardDrive, RefreshCw, Trash2, Upload } from 'lucide-react'
import { invoke } from '@/lib/ipc'
import { changeLanguage } from '@/i18n'
import { formatBytes, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToasts } from '@/components/ui/toaster'
import { resolveLocale, useAppStore } from '@/stores/app'

type ClearCategory = 'favorites' | 'history' | 'downloads' | 'follows' | 'inbox' | 'otherKv'

const CLEAR_CATEGORIES: ClearCategory[] = [
  'favorites',
  'history',
  'downloads',
  'follows',
  'inbox',
  'otherKv'
]

const DEFAULT_CLEAR: Record<ClearCategory, boolean> = {
  favorites: true,
  history: true,
  downloads: true,
  follows: true,
  inbox: true,
  otherKv: true
}

export function PrivacySection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const appInfo = useAppStore((s) => s.appInfo)
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [telemetryError, setTelemetryError] = useState<string | null>(null)
  const [signOutAlso, setSignOutAlso] = useState(false)
  const [categories, setCategories] = useState(DEFAULT_CLEAR)

  const locale = resolveLocale(settings, appInfo)
  const cachePath = settings.hfCacheDir ?? appInfo?.hfCacheDir ?? '—'
  const anyCategory = CLEAR_CATEGORIES.some((key) => categories[key])

  const report = useQuery({
    queryKey: ['cache'],
    queryFn: () => invoke('cache:scan', undefined),
    staleTime: 5 * 60_000
  })
  const telemetryStatus = useQuery({
    queryKey: ['telemetry-status'],
    queryFn: () => invoke('telemetry:status', undefined)
  })
  const telemetryConfigured = telemetryStatus.data?.configured === true
  const lastCapture = telemetryStatus.data?.lastCapture

  const clearLocal = useMutation({
    mutationFn: () =>
      invoke('privacy:clearLocalData', {
        ...categories,
        signOut: signOutAlso
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['favorites'] })
      void queryClient.invalidateQueries({ queryKey: ['follows'] })
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
      void queryClient.invalidateQueries({ queryKey: ['downloads'] })
      push(
        result.signedOut
          ? t('settings:privacy.local.successSignedOut')
          : t('settings:privacy.local.success'),
        'success'
      )
      setConfirmOpen(false)
      setSignOutAlso(false)
      setCategories(DEFAULT_CLEAR)
    },
    onError: (err) => {
      push(err.message, 'error')
    }
  })

  const exportSettings = useMutation({
    mutationFn: () => invoke('settings:export', undefined),
    onSuccess: (result) => {
      if (result.canceled) return
      push(t('settings:privacy.transfer.exportSuccess'), 'success')
    },
    onError: (err) => push(err.message, 'error')
  })

  const importSettings = useMutation({
    mutationFn: () => invoke('settings:import', undefined),
    onSuccess: (result) => {
      if (result.canceled) return
      setSettings(result.settings)
      void changeLanguage(resolveLocale(result.settings, appInfo))
      push(t('settings:privacy.transfer.importSuccess'), 'success')
    },
    onError: (err) => push(err.message, 'error')
  })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-smd font-semibold text-ink-strong">{t('settings:privacy.title')}</h2>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink-strong">
          <BarChart3 className="size-4 shrink-0" aria-hidden />
          {t('settings:privacy.telemetry.title')}
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          {t('settings:privacy.telemetry.description')}
        </p>
        <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-ink-strong">
              {t('settings:privacy.telemetry.enabled')}
            </span>
            <span className="text-[12px] text-ink-muted">
              {t(
                !telemetryConfigured
                  ? 'settings:privacy.telemetry.unconfiguredHint'
                  : settings.telemetryEnabled
                    ? 'settings:privacy.telemetry.enabledHint'
                    : 'settings:privacy.telemetry.disabledHint'
              )}
            </span>
          </div>
          <Switch
            checked={telemetryConfigured && settings.telemetryEnabled}
            disabled={!telemetryConfigured}
            onCheckedChange={(telemetryEnabled) => {
              setTelemetryError(null)
              void updateSettings({ telemetryEnabled })
                .then(() => telemetryStatus.refetch())
                .catch((error: unknown) => {
                  const message = error instanceof Error ? error.message : t('common:error.generic')
                  setTelemetryError(message)
                  push(message, 'error')
                })
            }}
          />
        </label>
        {telemetryError && (
          <p role="alert" className="text-[12px] text-error">
            {telemetryError}
          </p>
        )}
        {telemetryConfigured && settings.telemetryEnabled && lastCapture && (
          <p className="text-[12px] text-ink-muted">
            {t('settings:privacy.telemetry.lastCapture', {
              event: lastCapture.event,
              status: t(`settings:privacy.telemetry.captureStatus.${lastCapture.status}`),
              time: formatRelativeTime(lastCapture.at, locale)
            })}
          </p>
        )}
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void invoke('system:openExternal', { url: TELEMETRY_DOCUMENTATION_URL }).catch(
                (error: Error) => push(error.message, 'error')
              )
            }}
          >
            {t('settings:community.telemetry.details')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink-strong">
          <HardDrive className="size-4 shrink-0" aria-hidden />
          {t('settings:privacy.cache.title')}
        </div>
        <div className="flex flex-col gap-1.5 text-[12.5px]">
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-ink-faint">{t('settings:privacy.cache.path')}</span>
            <span className="min-w-0 break-all font-mono text-ink-muted">{cachePath}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-ink-faint">{t('settings:privacy.cache.size')}</span>
            {report.isLoading ? (
              <Skeleton className="h-4 w-24" />
            ) : report.isError ? (
              <span className="text-ink-muted">{t('settings:privacy.cache.scanFailed')}</span>
            ) : (
              <span className="nums text-ink-muted">
                {formatBytes(report.data?.totalSize ?? 0)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              closeSettings()
              navigate('/cache')
            }}
          >
            <FolderOpen className="size-3.5" aria-hidden />
            {t('settings:privacy.cache.open')}
          </Button>
          {report.isError && (
            <Button variant="ghost" size="sm" onClick={() => void report.refetch()}>
              <RefreshCw className="size-3.5" aria-hidden />
              {t('settings:privacy.cache.retry')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="text-[13px] font-medium text-ink-strong">
          {t('settings:privacy.local.title')}
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          {t('settings:privacy.local.description')}
        </p>
        <div>
          <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
            <Trash2 className="size-3.5" aria-hidden />
            {t('settings:privacy.local.clear')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="text-[13px] font-medium text-ink-strong">
          {t('settings:privacy.transfer.title')}
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          {t('settings:privacy.transfer.description')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={exportSettings.isPending}
            onClick={() => exportSettings.mutate()}
          >
            <Download className="size-3.5" aria-hidden />
            {t('settings:privacy.transfer.export')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={importSettings.isPending}
            onClick={() => importSettings.mutate()}
          >
            <Upload className="size-3.5" aria-hidden />
            {t('settings:privacy.transfer.import')}
          </Button>
        </div>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!clearLocal.isPending) {
            setConfirmOpen(open)
            if (!open) {
              setSignOutAlso(false)
              setCategories(DEFAULT_CLEAR)
            }
          }
        }}
      >
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold">
            {t('settings:privacy.local.confirmTitle')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-ink-muted">
            {t('settings:privacy.local.confirmBody')}
          </DialogDescription>
          <div className="mt-3 flex flex-col gap-2">
            {CLEAR_CATEGORIES.map((key) => (
              <label
                key={key}
                className="flex items-center justify-between gap-3 text-[13px] text-ink"
              >
                <span>{t(`settings:privacy.local.items.${key}`)}</span>
                <Switch
                  checked={categories[key]}
                  onCheckedChange={(checked) =>
                    setCategories((prev) => ({ ...prev, [key]: checked }))
                  }
                  disabled={clearLocal.isPending}
                />
              </label>
            ))}
          </div>
          <label className="mt-4 flex items-center justify-between gap-3 text-[13px] text-ink">
            <span>{t('settings:privacy.local.signOutAlso')}</span>
            <Switch
              checked={signOutAlso}
              onCheckedChange={setSignOutAlso}
              disabled={clearLocal.isPending}
            />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={clearLocal.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={clearLocal.isPending}
              disabled={!anyCategory && !signOutAlso}
              onClick={() => clearLocal.mutate()}
            >
              {t('settings:privacy.local.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

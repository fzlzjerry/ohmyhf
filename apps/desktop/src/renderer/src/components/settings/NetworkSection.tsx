import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Globe, RotateCcw, Wifi } from 'lucide-react'
import {
  DEFAULT_HUB_ENDPOINT,
  HUB_ENDPOINT_PRESETS,
  normalizeHubEndpoint
} from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { isHubRemoteQuery } from '@/lib/query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToasts } from '@/components/ui/toaster'
import { useAppStore } from '@/stores/app'

const DEFAULT_PROXY_PLACEHOLDER = 'http://127.0.0.1:7890'
const ENDPOINT_INPUT_ID = 'settings-network-endpoint'
const ENDPOINT_ERROR_ID = 'settings-network-endpoint-error'
const PROXY_INPUT_ID = 'settings-network-proxy'
const PROXY_ERROR_ID = 'settings-network-proxy-error'

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Empty → null; otherwise require http(s) URL. */
function parseOptionalUrl(raw: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!isHttpUrl(trimmed)) return { ok: false }
  return { ok: true, value: trimmed.replace(/\/$/, '') }
}

export function NetworkSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setAuth = useAppStore((s) => s.setAuth)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)

  const [endpointDraft, setEndpointDraft] = useState(settings.hubEndpoint ?? '')
  const [proxyDraft, setProxyDraft] = useState(settings.proxyUrl ?? '')
  const [endpointError, setEndpointError] = useState(false)
  const [proxyError, setProxyError] = useState(false)
  const [syncedEndpoint, setSyncedEndpoint] = useState(settings.hubEndpoint)
  const [syncedProxy, setSyncedProxy] = useState(settings.proxyUrl)

  const applyNetworkSettings = async (
    hubEndpoint: string | null,
    proxyUrl: string | null
  ): Promise<void> => {
    const previousEndpoint = normalizeHubEndpoint(settings.hubEndpoint)
    const endpointChanged = previousEndpoint !== normalizeHubEndpoint(hubEndpoint)
    if (endpointChanged) {
      await queryClient.cancelQueries({
        predicate: (query) => isHubRemoteQuery(query.queryKey)
      })
    }
    await updateSettings({ hubEndpoint, proxyUrl })
    if (!endpointChanged) return
    // Every endpoint-aware remote key ends in its canonical endpoint. Remove
    // only the old partition, then reset any legacy/unkeyed active observers
    // against the newly attached main-process HubClient.
    queryClient.removeQueries({
      predicate: (query) =>
        isHubRemoteQuery(query.queryKey) && query.queryKey.at(-1) === previousEndpoint
    })
    await queryClient.resetQueries({
      predicate: (query) =>
        isHubRemoteQuery(query.queryKey) && query.queryKey.at(-1) !== previousEndpoint
    })
    setAuth(await invoke('auth:refreshUser', undefined))
  }

  // Reset drafts when store values change externally (e.g. reset / apply from elsewhere).
  if (settings.hubEndpoint !== syncedEndpoint) {
    setSyncedEndpoint(settings.hubEndpoint)
    setEndpointDraft(settings.hubEndpoint ?? '')
  }
  if (settings.proxyUrl !== syncedProxy) {
    setSyncedProxy(settings.proxyUrl)
    setProxyDraft(settings.proxyUrl ?? '')
  }

  const apply = useMutation({
    mutationFn: async () => {
      const endpoint = parseOptionalUrl(endpointDraft)
      const proxy = parseOptionalUrl(proxyDraft)
      setEndpointError(!endpoint.ok)
      setProxyError(!proxy.ok)
      if (!endpoint.ok || !proxy.ok) {
        throw new Error(t('settings:network.invalidUrl'))
      }
      await applyNetworkSettings(
        endpoint.value === null ? null : normalizeHubEndpoint(endpoint.value),
        proxy.value
      )
    },
    onSuccess: () => push(t('settings:network.saved'), 'success'),
    onError: (err) => push(err.message, 'error')
  })

  const test = useMutation({
    // Probe the drafts as typed (untouched drafts equal the applied config),
    // so type endpoint → Test reflects what Apply would do.
    mutationFn: async () => {
      const endpoint = parseOptionalUrl(endpointDraft)
      const proxy = parseOptionalUrl(proxyDraft)
      setEndpointError(!endpoint.ok)
      setProxyError(!proxy.ok)
      if (!endpoint.ok || !proxy.ok) {
        throw new Error(t('settings:network.invalidUrl'))
      }
      return invoke('network:testConnection', {
        endpoint: endpoint.value === null ? null : normalizeHubEndpoint(endpoint.value),
        proxyUrl: proxy.value
      })
    },
    onSuccess: (result) => {
      if (result.ok) push(t('settings:network.testOk'), 'success')
      else push(t('settings:network.testFail', { error: result.error }), 'error')
    },
    onError: (err) => push(err.message, 'error')
  })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-smd font-semibold text-ink-strong">{t('settings:network.title')}</h2>

      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        {t('settings:network.description')}
      </p>
      <p className="text-[12px] text-ink-faint">{t('settings:network.tokenWarning')}</p>
      <p className="text-[12px] text-ink-faint">{t('settings:network.offlineHint')}</p>

      <div className="flex flex-wrap gap-2">
        {HUB_ENDPOINT_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant="secondary"
            size="sm"
            onClick={() => {
              const value = preset.endpoint
              setEndpointDraft(value ?? '')
              setEndpointError(false)
              void applyNetworkSettings(value, settings.proxyUrl).then(() =>
                push(t('settings:network.saved'), 'success')
              )
            }}
          >
            {t(`settings:network.presets.${preset.id}`)}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <label htmlFor={ENDPOINT_INPUT_ID} className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-strong">
            {t('settings:network.hubEndpoint')}
          </span>
          <Input
            id={ENDPOINT_INPUT_ID}
            value={endpointDraft}
            placeholder={DEFAULT_HUB_ENDPOINT}
            spellCheck={false}
            aria-invalid={endpointError}
            aria-describedby={endpointError ? ENDPOINT_ERROR_ID : undefined}
            onChange={(e) => {
              setEndpointDraft(e.target.value)
              setEndpointError(false)
            }}
          />
          {endpointError && (
            <span id={ENDPOINT_ERROR_ID} className="text-[12px] text-error">
              {t('settings:network.invalidUrl')}
            </span>
          )}
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEndpointDraft('')
              setEndpointError(false)
              void applyNetworkSettings(null, settings.proxyUrl).then(() =>
                push(t('settings:network.resetEndpoint'), 'success')
              )
            }}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {t('settings:network.reset')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <label htmlFor={PROXY_INPUT_ID} className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-strong">
            {t('settings:network.proxyUrl')}
          </span>
          <Input
            id={PROXY_INPUT_ID}
            value={proxyDraft}
            placeholder={DEFAULT_PROXY_PLACEHOLDER}
            spellCheck={false}
            aria-invalid={proxyError}
            aria-describedby={proxyError ? PROXY_ERROR_ID : undefined}
            onChange={(e) => {
              setProxyDraft(e.target.value)
              setProxyError(false)
            }}
          />
          {proxyError && (
            <span id={PROXY_ERROR_ID} className="text-[12px] text-error">
              {t('settings:network.invalidUrl')}
            </span>
          )}
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setProxyDraft('')
              setProxyError(false)
              void updateSettings({ proxyUrl: null }).then(() =>
                push(t('settings:network.resetProxy'), 'success')
              )
            }}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {t('settings:network.reset')}
          </Button>
        </div>
      </div>

      <p className="text-[12px] text-ink-faint">{t('settings:network.downloadWarning')}</p>

      <div className="flex flex-wrap gap-2">
        <Button variant="cta" size="sm" loading={apply.isPending} onClick={() => apply.mutate()}>
          <Globe className="size-3.5" aria-hidden />
          {t('settings:network.apply')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={test.isPending}
          onClick={() => test.mutate()}
        >
          <Wifi className="size-3.5" aria-hidden />
          {t('settings:network.test')}
        </Button>
      </div>
    </section>
  )
}

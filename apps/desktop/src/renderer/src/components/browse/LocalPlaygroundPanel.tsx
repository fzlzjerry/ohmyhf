import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import {
  Bot,
  CircleStop,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  LockKeyhole,
  Play,
  Send,
  Square,
  Trash2
} from 'lucide-react'
import {
  normalizeHubEndpoint,
  type LocalChatMessage,
  type LocalRuntimeKind,
  type LocalRuntimeState,
  type RepoDetail,
  type RepoRevisionSelection
} from '@oh-my-huggingface/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { useIpcEvent } from '@/hooks/use-ipc-event'
import { useSecurityGate } from '@/hooks/use-security-gate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useToasts } from '@/components/ui/toaster'
import { formatBytes } from '@/lib/utils'
import { useAppStore } from '@/stores/app'

const FIT_ORDER = { comfortable: 0, tight: 1, unknown: 2, unlikely: 3 } as const
const MAX_GGUF_HEADER_BYTES = 8 * 1024 * 1024

interface RuntimeHeader {
  architecture?: string
  chatTemplate: boolean
  contextLength?: number
  layerCount?: number
  embeddingLength?: number
  kvHeadCount?: number
}

function positiveMetadataNumber(
  metadata: Record<string, unknown>,
  architecture: string | undefined,
  suffix: string
): number | undefined {
  const exact = architecture ? metadata[`${architecture}.${suffix}`] : undefined
  const fallback =
    exact ?? Object.entries(metadata).find(([key]) => key.endsWith(`.${suffix}`))?.[1]
  const value = typeof fallback === 'bigint' ? Number(fallback) : Number(fallback)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function LocalPlaygroundPanel({
  repoId,
  detail,
  revision
}: {
  repoId: string
  detail?: RepoDetail
  revision: RepoRevisionSelection
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const push = useToasts((state) => state.push)
  const hubEndpoint = useAppStore((state) => state.settings.hubEndpoint)
  const security = useSecurityGate()
  const ggufs = useMemo(
    () =>
      (detail?.siblings ?? [])
        .filter((file) => file.rfilename.toLowerCase().endsWith('.gguf'))
        .map((file) => ({ path: file.rfilename, size: file.size ?? 0 })),
    [detail?.siblings]
  )
  const [filePath, setFilePath] = useState<string>('')
  const selected = ggufs.find((file) => file.path === filePath) ?? ggufs[0]
  const [runtime, setRuntime] = useState<LocalRuntimeKind | null>(null)
  const [contextLength, setContextLength] = useState(4096)
  const [maxTokens, setMaxTokens] = useState(512)
  const [temperature, setTemperature] = useState(0.7)
  const [gpuLayers, setGpuLayers] = useState<'auto' | number>('auto')
  const [fitConfirmed, setFitConfirmed] = useState(false)
  const [runtimeState, setRuntimeState] = useState<LocalRuntimeState>({ status: 'idle' })
  const [messages, setMessages] = useState<LocalChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [streamId, setStreamId] = useState<string | null>(null)

  const discoveries = useQuery({
    queryKey: ['local-runtime-discovery'],
    queryFn: () => invoke('localRuntime:discover', undefined),
    staleTime: 30_000
  })
  const presets = useQuery({
    queryKey: ['local-runtime-presets', repoId, revision.resolvedCommit],
    queryFn: () =>
      invoke('localRuntime:presets', {
        repoId,
        resolvedCommit: revision.resolvedCommit
      })
  })
  const selectBinary = useMutation({
    mutationFn: (kind: LocalRuntimeKind) => invoke('localRuntime:selectBinary', { kind }),
    onSuccess: async (result) => {
      if (result?.available) {
        setRuntime(result.kind)
        push(`${result.kind} is ready.`, 'success')
      } else if (result) {
        push(result.error ?? `${result.kind} does not provide the required chat API.`, 'error')
      }
      await discoveries.refetch()
    },
    onError: (error) => push(error.message, 'error')
  })
  const available = (discoveries.data ?? []).filter((item) => item.available)
  const unavailable = (discoveries.data ?? []).filter((item) => !item.available)
  const exactFile = useQuery({
    queryKey: [
      'local-runtime-file-metadata',
      normalizeHubEndpoint(hubEndpoint),
      'model',
      repoId,
      revision.requested,
      revision.resolvedCommit,
      selected?.path
    ],
    enabled: Boolean(selected),
    retry: false,
    queryFn: async () => {
      if (!selected) throw new Error('runtime.ggufMissing')
      const parent = selected.path.split('/').slice(0, -1).join('/') || undefined
      const tree = await invoke('hub:fileTree', {
        kind: 'model',
        repoId,
        revision: revision.resolvedCommit,
        path: parent
      })
      const entry = tree.find((item) => item.type === 'file' && item.path === selected.path)
      if (!entry) throw new Error('runtime.ggufMissing')
      return entry
    }
  })
  const selectedSize = exactFile.data?.size ?? selected?.size ?? 0
  const header = useQuery({
    queryKey: [
      'local-runtime-gguf-header',
      normalizeHubEndpoint(hubEndpoint),
      'model',
      repoId,
      revision.requested,
      revision.resolvedCommit,
      selected?.path,
      selectedSize
    ],
    enabled: Boolean(selected),
    retry: false,
    queryFn: async (): Promise<RuntimeHeader> => {
      if (!selected) throw new Error('runtime.ggufMissing')
      const cached = await invoke('localRuntime:inspectCachedGguf', {
        repoId,
        resolvedCommit: revision.resolvedCommit,
        filePath: selected.path
      })
      if (cached) {
        return {
          architecture: cached.architecture,
          chatTemplate: cached.hasChatTemplate,
          contextLength: cached.contextLength,
          layerCount: cached.layerCount,
          embeddingLength: cached.embeddingLength,
          kvHeadCount: cached.kvHeadCount
        }
      }
      if (selectedSize <= 0) throw new Error('runtime.emptyGguf')
      const end = Math.min(selectedSize, MAX_GGUF_HEADER_BYTES) - 1
      const bytes = await invoke('hub:fileRange', {
        kind: 'model',
        repoId,
        path: selected.path,
        revision: revision.resolvedCommit,
        start: 0,
        end
      })
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const { ggufMetadata } = await import('hyllama')
      const raw = ggufMetadata(copy.buffer).metadata as Record<string, unknown>
      const architecture =
        typeof raw['general.architecture'] === 'string' ? raw['general.architecture'] : undefined
      return {
        architecture,
        chatTemplate: Object.entries(raw).some(
          ([key, value]) => key.startsWith('tokenizer.chat_template') && typeof value === 'string'
        ),
        contextLength: positiveMetadataNumber(raw, architecture, 'context_length'),
        layerCount: positiveMetadataNumber(raw, architecture, 'block_count'),
        embeddingLength: positiveMetadataNumber(raw, architecture, 'embedding_length'),
        kvHeadCount:
          positiveMetadataNumber(raw, architecture, 'attention.head_count_kv') ??
          positiveMetadataNumber(raw, architecture, 'attention.head_count')
      }
    }
  })
  const cachedFile = useQuery({
    queryKey: [
      'cache-file',
      normalizeHubEndpoint(hubEndpoint),
      'model',
      repoId,
      revision.resolvedCommit,
      selected?.path
    ],
    enabled: Boolean(selected),
    queryFn: () =>
      invoke('cache:resolveFile', {
        kind: 'model',
        repoId,
        commit: revision.resolvedCommit,
        path: selected!.path
      })
  })
  const effectiveContextLength = Math.min(
    contextLength,
    header.data?.contextLength ?? contextLength
  )
  const fits = useQueries({
    queries: available.map((item) => ({
      queryKey: [
        'local-fit',
        normalizeHubEndpoint(hubEndpoint),
        repoId,
        revision.resolvedCommit,
        selected?.path,
        item.kind,
        selectedSize,
        effectiveContextLength,
        header.data?.layerCount,
        header.data?.embeddingLength,
        header.data?.kvHeadCount,
        Boolean(cachedFile.data)
      ],
      queryFn: () =>
        invoke('localRuntime:assess', {
          runtime: item.kind,
          fileSize: selectedSize,
          contextLength: effectiveContextLength,
          layerCount: header.data?.layerCount,
          embeddingLength: header.data?.embeddingLength,
          kvHeadCount: header.data?.kvHeadCount,
          cached: Boolean(cachedFile.data)
        }),
      enabled: Boolean(selected) && header.isSuccess
    }))
  })
  const recommended = available
    .map((item, index) => ({ item, fit: fits[index]?.data }))
    .sort((a, b) => {
      const fit = FIT_ORDER[a.fit?.level ?? 'unknown'] - FIT_ORDER[b.fit?.level ?? 'unknown']
      if (fit !== 0) return fit
      if (a.item.kind === b.item.kind) return 0
      const llama = a.item.kind === 'llama.cpp' ? a.item : b.item
      if (
        llama.capabilities.autoFit ||
        (llama.capabilities.gpuOffload && header.data?.layerCount)
      ) {
        return a.item.kind === 'llama.cpp' ? -1 : 1
      }
      return a.item.kind === 'ollama' ? -1 : 1
    })[0]?.item.kind
  const effectiveRuntime = runtime ?? recommended ?? 'llama.cpp'
  const selectedDiscovery = available.find((item) => item.kind === effectiveRuntime)
  const selectedFit = fits[available.findIndex((item) => item.kind === effectiveRuntime)]?.data
  const needsFitConfirmation = selectedFit?.level === 'unknown' || selectedFit?.level === 'unlikely'
  const headerIncompatible =
    header.isSuccess && (!header.data.architecture || !header.data.chatTemplate)

  useQuery({
    queryKey: ['local-runtime-state'],
    queryFn: async () => {
      const state = await invoke('localRuntime:getState', undefined)
      setRuntimeState(state)
      return state
    },
    staleTime: Infinity
  })

  useIpcEvent(
    'evt:localRuntime',
    useCallback((state) => setRuntimeState(state), [])
  )
  useIpcEvent(
    'evt:localInference',
    useCallback(
      (event) => {
        setStreamId((current) => {
          if (current !== event.id) return current
          if (event.delta) {
            setMessages((currentMessages) => {
              const next = [...currentMessages]
              const last = next.at(-1)
              if (last?.role === 'assistant') {
                next[next.length - 1] = { ...last, content: `${last.content}${event.delta}` }
              }
              return next
            })
          }
          return event.done ? null : current
        })
        if (event.error) push(event.error, 'error')
      },
      [push]
    )
  )

  const start = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error('No GGUF selected')
      const grantId = await security.authorize({
        action: 'local-run',
        kind: 'model',
        repoId,
        revision: revision.requested,
        resolvedCommit: revision.resolvedCommit,
        files: [selected.path]
      })
      const cached = await invoke('cache:resolveFile', {
        kind: 'model',
        repoId,
        commit: revision.resolvedCommit,
        path: selected.path
      })
      if (!cached) {
        await invoke('downloads:start', {
          request: {
            kind: 'model',
            repoId,
            revision: revision.requested,
            resolvedCommit: revision.resolvedCommit,
            files: [selected.path],
            securityGrantId: grantId,
            postAction: {
              kind: 'local-run',
              runtime: effectiveRuntime,
              filePath: selected.path,
              contextLength: effectiveContextLength,
              maxTokens,
              temperature,
              gpuLayers,
              allowTightFit: fitConfirmed
            }
          }
        })
        return { queued: true as const }
      }
      const state = await invoke('localRuntime:start', {
        request: {
          runtime: effectiveRuntime,
          repoId,
          revision: revision.requested,
          resolvedCommit: revision.resolvedCommit,
          filePath: selected.path,
          contextLength: effectiveContextLength,
          maxTokens,
          temperature,
          gpuLayers,
          securityGrantId: grantId,
          allowTightFit: fitConfirmed
        }
      })
      if (state.status === 'error') throw new Error(state.error ?? 'Local runtime failed')
      return { queued: false as const }
    },
    onSuccess: (result) =>
      push(
        result.queued
          ? 'Download queued; local run will resume after verification.'
          : 'Local model is ready.',
        'success'
      ),
    onError: (error) =>
      push(
        error.message === 'runtime.oomAfterRetry' ? t('repro.local.oomAdvice') : error.message,
        'error'
      )
  })

  const stop = useMutation({
    mutationFn: () => invoke('localRuntime:stop', undefined),
    onError: (error) => push(error.message, 'error')
  })
  const removeImported = useMutation({
    mutationFn: (modelName: string) => invoke('localRuntime:removeImportedModel', { modelName }),
    onSuccess: (result) => {
      if (result.removed) push('The ohmyhf-managed Ollama copy was deleted.', 'success')
    },
    onError: (error) => push(error.message, 'error')
  })
  const exportRunLock = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error('No GGUF selected')
      const parent = selected.path.split('/').slice(0, -1).join('/') || undefined
      const tree = await invoke('hub:fileTree', {
        kind: 'model',
        repoId,
        revision: revision.resolvedCommit,
        path: parent
      })
      const entry = tree.find((item) => item.type === 'file' && item.path === selected.path)
      if (!entry || (!entry.lfs?.oid && !entry.oid)) {
        throw new Error('Immutable Hub object id is unavailable for the selected GGUF')
      }
      return invoke('lockfile:export', {
        lock: {
          format: 'ohmyhf-lock/v1',
          version: 1,
          createdAt: new Date().toISOString(),
          hubEndpoint: normalizeHubEndpoint(hubEndpoint),
          resources: [
            {
              kind: 'model',
              repoId,
              requestedRevision: revision.requested,
              resolvedCommit: revision.resolvedCommit,
              files: [
                {
                  path: selected.path,
                  size: entry.size,
                  lfsSha256: entry.lfs?.oid,
                  gitBlobOid: entry.lfs ? undefined : entry.oid
                }
              ],
              runtime: {
                runtime: effectiveRuntime,
                filePath: selected.path,
                contextLength: effectiveContextLength,
                maxTokens,
                temperature,
                gpuLayers
              }
            }
          ]
        }
      })
    },
    onSuccess: (result) => {
      if (!result.canceled) push(`Run lockfile saved: ${result.path}`, 'success')
    },
    onError: (error) => push(error.message, 'error')
  })

  const send = (): void => {
    const content = draft.trim()
    if (!content || streamId || runtimeState.status !== 'ready') return
    const id = crypto.randomUUID()
    const outgoing: LocalChatMessage[] = [...messages, { role: 'user', content }]
    setMessages([...outgoing, { role: 'assistant', content: '' }])
    setDraft('')
    setStreamId(id)
    void invoke('localRuntime:chatStream', {
      id,
      request: { messages: outgoing, maxTokens, temperature }
    }).catch((error) => {
      setStreamId(null)
      push(error.message, 'error')
    })
  }

  if (ggufs.length === 0) {
    return <p className="p-6 text-[12.5px] text-ink-muted">{t('repro.local.noGguf')}</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {security.dialog}
      <div className="flex flex-wrap items-end gap-2 border-b p-3">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-[11.5px] text-ink-muted">
          GGUF
          <select
            className="h-8 rounded-md border bg-panel px-2 font-mono text-[11.5px] text-ink"
            value={selected?.path}
            onChange={(event) => {
              setFilePath(event.target.value)
              setFitConfirmed(false)
            }}
          >
            {ggufs.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path} · {formatBytes(file.size)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-muted">
          {t('repro.local.runtime')}
          <select
            className="h-8 rounded-md border bg-panel px-2 text-[12px] text-ink"
            value={effectiveRuntime}
            onChange={(event) => setRuntime(event.target.value as LocalRuntimeKind)}
          >
            {(discoveries.data ?? []).map((item) => (
              <option key={item.kind} value={item.kind} disabled={!item.available}>
                {item.kind}
                {item.kind === recommended ? t('repro.local.recommendedSuffix') : ''}
                {!item.available ? t('repro.local.unavailableSuffix') : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-muted">
          {t('repro.local.context')}
          <Input
            className="w-24"
            type="number"
            min={128}
            max={1_048_576}
            value={effectiveContextLength}
            onChange={(event) => {
              setContextLength(Number(event.target.value))
              setFitConfirmed(false)
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-muted">
          {t('repro.local.maxTokens')}
          <Input
            className="w-24"
            type="number"
            min={1}
            max={32_768}
            value={maxTokens}
            onChange={(event) => setMaxTokens(Number(event.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-muted">
          {t('repro.local.temperature')}
          <Input
            className="w-24"
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(event) => setTemperature(Number(event.target.value))}
          />
        </label>
        {effectiveRuntime === 'llama.cpp' && (
          <label className="flex flex-col gap-1 text-[11.5px] text-ink-muted">
            {t('repro.local.gpuLayers')}
            <Input
              className="w-24"
              type="text"
              inputMode="numeric"
              value={gpuLayers}
              onChange={(event) => {
                const value = event.target.value.trim().toLowerCase()
                setGpuLayers(value === '' || value === 'auto' ? 'auto' : Math.max(0, Number(value)))
              }}
            />
          </label>
        )}
        {selectedFit && (
          <Badge variant={selectedFit.level === 'comfortable' ? 'success' : 'warning'}>
            {selectedFit.level}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          loading={exportRunLock.isPending}
          onClick={() => exportRunLock.mutate()}
        >
          <LockKeyhole className="size-3.5" aria-hidden /> {t('repro.local.exportRunLock')}
        </Button>
        {runtimeState.status === 'ready' ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={stop.isPending}
              onClick={() => stop.mutate()}
            >
              <Square className="size-3.5" aria-hidden />
              {runtimeState.runtime === 'ollama' ? t('repro.local.unload') : t('repro.local.stop')}
            </Button>
            {runtimeState.runtime === 'ollama' && runtimeState.modelName && (
              <Button
                variant="danger"
                size="sm"
                loading={removeImported.isPending}
                onClick={() => removeImported.mutate(runtimeState.modelName!)}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t('repro.local.deleteImportedCopy')}
              </Button>
            )}
          </>
        ) : (
          <Button
            variant="cta"
            size="sm"
            loading={
              start.isPending ||
              runtimeState.status === 'starting' ||
              runtimeState.status === 'preparing'
            }
            disabled={
              !selectedDiscovery ||
              !header.isSuccess ||
              headerIncompatible ||
              (needsFitConfirmation && !fitConfirmed)
            }
            onClick={() => start.mutate()}
          >
            <Play className="size-3.5" aria-hidden /> {t('repro.local.downloadRun')}
          </Button>
        )}
      </div>

      {selectedFit && (
        <div className="border-b bg-panel/40 px-3 py-2 text-[11.5px] text-ink-muted">
          {t('repro.local.fitDetails', {
            weights: formatBytes(selectedFit.estimatedWeightBytes),
            memory: formatBytes(selectedFit.estimatedSystemMemoryBytes),
            gpu: formatBytes(selectedFit.estimatedGpuBytes),
            disk: formatBytes(selectedFit.requiredDiskBytes),
            availableMemory: formatBytes(selectedFit.availableMemoryBytes),
            availableGpu:
              selectedFit.availableGpuMemoryBytes !== undefined
                ? formatBytes(selectedFit.availableGpuMemoryBytes)
                : t('repro.local.unknownValue')
          })}
        </div>
      )}

      {presets.data && presets.data.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-select/5 px-3 py-2 text-[12px] text-ink-muted">
          {t('repro.local.presetAvailable')}
          {presets.data.map((preset) => (
            <Button
              key={`${preset.runtime}:${preset.filePath}:${preset.createdAt}`}
              variant="secondary"
              size="sm"
              onClick={() => {
                setFilePath(preset.filePath)
                setRuntime(preset.runtime)
                setContextLength(preset.contextLength)
                setMaxTokens(preset.maxTokens)
                setTemperature(preset.temperature)
                setGpuLayers(preset.gpuLayers ?? 'auto')
                setFitConfirmed(false)
              }}
            >
              {t('repro.local.applyPreset', {
                runtime: preset.runtime,
                contextLength: preset.contextLength
              })}
            </Button>
          ))}
          <span>{t('repro.local.applyDoesNotStart')}</span>
        </div>
      )}

      {discoveries.isSuccess && unavailable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-3 py-2 text-[12px] text-ink-muted">
          {available.length === 0
            ? t('repro.local.noRuntime')
            : t('repro.local.optionalRuntimeUnavailable', {
                runtimes: unavailable.map((item) => item.kind).join(', ')
              })}
          {unavailable.map((item) => (
            <Button
              key={item.kind}
              variant="secondary"
              size="sm"
              loading={selectBinary.isPending && selectBinary.variables === item.kind}
              onClick={() => selectBinary.mutate(item.kind)}
            >
              <FolderOpen className="size-3.5" aria-hidden />
              {t('repro.local.selectBinary', { runtime: item.kind })}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openExternal('https://ollama.com/download')}
          >
            <ExternalLink className="size-3.5" aria-hidden /> {t('repro.local.ollama')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openExternal('https://github.com/ggml-org/llama.cpp/releases')}
          >
            <ExternalLink className="size-3.5" aria-hidden /> {t('repro.local.llamaReleases')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void discoveries.refetch()}>
            {t('repro.local.redetect')}
          </Button>
        </div>
      )}
      {needsFitConfirmation && (
        <label className="flex items-center gap-2 border-b bg-warning/10 px-3 py-2 text-[12px] text-ink-muted">
          <input
            type="checkbox"
            checked={fitConfirmed}
            onChange={(event) => setFitConfirmed(event.target.checked)}
          />
          {t('repro.local.fitConfirm', { level: selectedFit?.level })}
        </label>
      )}
      {headerIncompatible && (
        <p role="alert" className="border-b bg-error/10 px-3 py-2 text-[12px] text-error">
          {t('repro.local.incompatible')}
        </p>
      )}
      {header.isError && (
        <p role="alert" className="border-b bg-error/10 px-3 py-2 text-[12px] text-error">
          {t('repro.local.metadataError', { error: header.error.message })}
        </p>
      )}
      {runtimeState.error && (
        <p role="alert" className="border-b bg-error/10 px-3 py-2 text-[12px] text-error">
          {runtimeState.error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-ink-muted">
            <Bot className="size-8 text-ink-faint" aria-hidden />
            <p className="text-[12.5px]">{t('repro.local.ephemeralChat')}</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {messages.map((message, index) => (
              <div
                key={index}
                className={
                  message.role === 'user'
                    ? 'ml-12 rounded-lg bg-select/10 p-3'
                    : 'mr-12 rounded-lg border bg-panel p-3'
                }
              >
                <p className="mb-1 text-[10px] font-semibold uppercase text-ink-faint">
                  {message.role}
                </p>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
                  {message.content || (streamId && index === messages.length - 1 ? '…' : '')}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-2 border-t p-3">
        <Input
          value={draft}
          disabled={runtimeState.status !== 'ready'}
          placeholder={
            runtimeState.status === 'ready'
              ? t('repro.local.messagePlaceholder')
              : t('repro.local.startFirst')
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) send()
          }}
        />
        {streamId ? (
          <Button
            variant="secondary"
            size="icon"
            aria-label={t('repro.local.cancelGeneration')}
            onClick={() => invoke('localRuntime:cancel', { id: streamId })}
          >
            <CircleStop className="size-4" aria-hidden />
          </Button>
        ) : (
          <Button
            variant="cta"
            size="icon"
            aria-label={t('repro.local.send')}
            disabled={!draft.trim() || runtimeState.status !== 'ready'}
            onClick={send}
          >
            {start.isPending ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-4" aria-hidden />
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

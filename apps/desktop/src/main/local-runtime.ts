import { spawn, execFile as execFileCallback, type ChildProcess } from 'node:child_process'
import { lstat, mkdtemp, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { cpus, freemem, platform, totalmem, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  assessModelFit,
  normalizeHubEndpoint,
  type GgufMetadataSummary,
  type LocalChatRequest,
  type LocalInferenceStreamEvent,
  type LocalRunRequest,
  type LocalRunPreset,
  type LocalRuntimeKind,
  type LocalRuntimeState,
  type MachineProfile,
  type ModelFitAssessment,
  type RuntimeDiscovery,
  type SecurityAcknowledgement
} from '@oh-my-huggingface/shared'
import type { AppDatabase } from './db'
import type { CacheManager } from './cache'
import type { SecurityGate } from './security-gate'
import type { SettingsStore } from './settings'
import { readGgufRuntimeMetadata, type GgufRuntimeMetadata } from './gguf'

const PROBE_TIMEOUT_MS = 5_000
const START_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 5_000
const MAX_CAPTURE_BYTES = 1024 * 1024
const DEFAULT_CONTEXT = 4096
const DEFAULT_MAX_TOKENS = 512
const DEFAULT_TEMPERATURE = 0.7

interface CommandResult {
  stdout: string
  stderr: string
}

interface RuntimeProbe extends RuntimeDiscovery {
  help?: string
}

interface RunningLlama {
  child: ChildProcess
  endpoint: string
  stderr: string
}

function command(
  file: string,
  args: readonly string[],
  options: {
    timeout?: number
    signal?: AbortSignal
    env?: NodeJS.ProcessEnv
    maxBuffer?: number
  } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      file,
      [...args],
      {
        timeout: options.timeout ?? PROBE_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
        windowsHide: true,
        signal: options.signal,
        env: options.env
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout: String(stdout), stderr: String(stderr) })
          reject(error)
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

function limited(text: string, maximum = MAX_CAPTURE_BYTES): string {
  return text.length <= maximum ? text : text.slice(text.length - maximum)
}

async function canonicalExecutable(path: string): Promise<string> {
  const canonical = await realpath(path)
  const entry = await lstat(canonical)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('runtime.invalidBinary')
  return canonical
}

async function locateExecutable(name: string): Promise<string | undefined> {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  try {
    const result = await command(locator, [name])
    const candidate = result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean)
    return candidate ? await canonicalExecutable(candidate) : undefined
  } catch {
    return undefined
  }
}

function parseBytesFromMiB(value: string): number | undefined {
  const number = Number(value.replace(/[^0-9.]/g, ''))
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1024 ** 2) : undefined
}

async function probeAccelerators(): Promise<MachineProfile['accelerators']> {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return [
      {
        vendor: 'apple',
        name: 'Apple Silicon unified memory',
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
        unifiedMemory: true
      }
    ]
  }

  if (process.platform === 'linux' || process.platform === 'win32') {
    try {
      const result = await command(
        'nvidia-smi',
        ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
        { timeout: PROBE_TIMEOUT_MS }
      )
      const rows = result.stdout
        .trim()
        .split(/\r?\n/)
        .flatMap((line) => {
          const [name, total, free] = line.split(',').map((part) => part.trim())
          if (!name) return []
          return [
            {
              vendor: 'nvidia' as const,
              name,
              totalMemoryBytes: total ? parseBytesFromMiB(total) : undefined,
              freeMemoryBytes: free ? parseBytesFromMiB(free) : undefined
            }
          ]
        })
      if (rows.length > 0) return rows
    } catch {
      // Continue to platform-specific best-effort probes.
    }
  }

  if (process.platform === 'linux') {
    try {
      const result = await command('rocminfo', [], { timeout: PROBE_TIMEOUT_MS })
      const names = [...result.stdout.matchAll(/^\s*Marketing Name:\s*(.+)$/gim)].map((m) =>
        m[1]!.trim()
      )
      if (names.length > 0) return names.map((name) => ({ vendor: 'amd' as const, name }))
    } catch {
      return [{ vendor: 'unknown', name: 'GPU detection unavailable' }]
    }
  }

  if (process.platform === 'win32') {
    try {
      const result = await command(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'
        ],
        { timeout: PROBE_TIMEOUT_MS }
      )
      const raw = JSON.parse(result.stdout) as
        { Name?: string; AdapterRAM?: number } | Array<{ Name?: string; AdapterRAM?: number }>
      const rows = Array.isArray(raw) ? raw : [raw]
      const mapped = rows.flatMap((gpu) => {
        if (!gpu.Name) return []
        const vendor = /amd|radeon/i.test(gpu.Name)
          ? ('amd' as const)
          : /intel/i.test(gpu.Name)
            ? ('intel' as const)
            : /nvidia/i.test(gpu.Name)
              ? ('nvidia' as const)
              : ('unknown' as const)
        return [{ vendor, name: gpu.Name, totalMemoryBytes: gpu.AdapterRAM }]
      })
      if (mapped.length > 0) return mapped
    } catch {
      return [{ vendor: 'unknown', name: 'GPU detection unavailable' }]
    }
  }

  return []
}

export async function collectMachineProfile(cacheDir: string): Promise<MachineProfile> {
  let cacheFreeBytes: number | undefined
  try {
    const filesystem = await statfs(cacheDir)
    cacheFreeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
  } catch {
    // A missing/unmounted custom cache should not make hardware discovery fail.
  }
  const processors = cpus()
  return {
    platform: platform() as MachineProfile['platform'],
    arch: process.arch,
    cpuModel: processors[0]?.model ?? 'unknown',
    cpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    cacheFreeBytes,
    accelerators: await probeAccelerators(),
    probedAt: new Date().toISOString()
  }
}

function modelNameFor(request: LocalRunRequest, metadata: GgufRuntimeMetadata): string {
  const quant = basename(request.filePath, '.gguf')
  const raw = `${request.repoId}-${request.resolvedCommit.slice(0, 8)}-${quant}-${metadata.quantization ?? 'gguf'}`
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '') || `ohmyhf-${request.resolvedCommit.slice(0, 8)}`
  ).slice(0, 240)
}

function quantizedGpuLayers(metadata: GgufRuntimeMetadata, freeGpuBytes: number): number {
  if (!metadata.layerCount || freeGpuBytes <= 0) return 0
  // Reserve 20% VRAM plus 512 MiB for runtime/KV overhead. Per-layer size is
  // unknown without walking tensor descriptors, so use a conservative 256 MiB.
  const usable = Math.max(0, Math.floor(freeGpuBytes * 0.8) - 512 * 1024 ** 2)
  return Math.max(0, Math.min(metadata.layerCount, Math.floor(usable / (256 * 1024 ** 2))))
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForHealth(endpoint: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('runtime.exitedBeforeReady')
    try {
      const response = await fetch(`${endpoint}/health`, {
        signal: AbortSignal.timeout(1_500)
      })
      if (response.ok) return
    } catch {
      // Retry until bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('runtime.healthTimeout')
}

async function killOwnedProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (process.platform === 'win32') {
    try {
      await command('taskkill.exe', ['/PID', String(child.pid), '/T'], { timeout: STOP_TIMEOUT_MS })
    } catch {
      child.kill('SIGTERM')
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS))
  ])
  if (graceful) return
  if (process.platform === 'win32') {
    await command('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      timeout: STOP_TIMEOUT_MS
    }).catch(() => undefined)
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

function ollamaEnvironment(port: number): NodeJS.ProcessEnv {
  return { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` }
}

export interface LocalRuntimeManagerDeps {
  db: AppDatabase
  settings: SettingsStore
  cache: CacheManager
  security: SecurityGate
  broadcastState: (state: LocalRuntimeState) => void
  broadcastInference: (event: LocalInferenceStreamEvent) => void
}

export class LocalRuntimeManager {
  private state: LocalRuntimeState = { status: 'idle' }
  private llama: RunningLlama | null = null
  private activeOllamaModel: string | null = null
  private streams = new Map<string, AbortController>()
  private probes = new Map<LocalRuntimeKind, RuntimeProbe>()

  constructor(private readonly deps: LocalRuntimeManagerDeps) {}

  getState(): LocalRuntimeState {
    return { ...this.state }
  }

  private setState(next: LocalRuntimeState): LocalRuntimeState {
    this.state = next
    this.deps.broadcastState(this.getState())
    return this.getState()
  }

  profile(): Promise<MachineProfile> {
    return collectMachineProfile(this.deps.cache.cacheDir())
  }

  savePreset(preset: Omit<LocalRunPreset, 'createdAt'>): LocalRunPreset {
    const value: LocalRunPreset = {
      ...preset,
      endpoint: normalizeHubEndpoint(preset.endpoint),
      createdAt: new Date().toISOString()
    }
    this.deps.db
      .prepare(
        `INSERT INTO local_run_presets
         (endpoint, repo_id, revision, resolved_commit, file_path, runtime,
          context_length, max_tokens, temperature, gpu_layers, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint, repo_id, resolved_commit, file_path, runtime) DO UPDATE SET
           revision = excluded.revision,
           context_length = excluded.context_length,
           max_tokens = excluded.max_tokens,
           temperature = excluded.temperature,
           gpu_layers = excluded.gpu_layers,
           created_at = excluded.created_at`
      )
      .run(
        value.endpoint,
        value.repoId,
        value.revision,
        value.resolvedCommit,
        value.filePath,
        value.runtime,
        value.contextLength,
        value.maxTokens,
        value.temperature,
        value.gpuLayers === undefined ? null : String(value.gpuLayers),
        value.createdAt
      )
    return value
  }

  listPresets(repoId: string, resolvedCommit: string): LocalRunPreset[] {
    const endpoint = normalizeHubEndpoint(this.deps.settings.get().hubEndpoint)
    const rows = this.deps.db
      .prepare(
        `SELECT endpoint, repo_id, revision, resolved_commit, file_path, runtime,
                context_length, max_tokens, temperature, gpu_layers, created_at
           FROM local_run_presets
          WHERE endpoint = ? AND repo_id = ? AND resolved_commit = ?
          ORDER BY created_at DESC`
      )
      .all(endpoint, repoId, resolvedCommit) as Array<{
      endpoint: string
      repo_id: string
      revision: string
      resolved_commit: string
      file_path: string
      runtime: LocalRuntimeKind
      context_length: number
      max_tokens: number
      temperature: number
      gpu_layers: string | null
      created_at: string
    }>
    return rows.map((row) => ({
      endpoint: row.endpoint,
      repoId: row.repo_id,
      revision: row.revision,
      resolvedCommit: row.resolved_commit,
      filePath: row.file_path,
      runtime: row.runtime,
      contextLength: row.context_length,
      maxTokens: row.max_tokens,
      temperature: row.temperature,
      gpuLayers:
        row.gpu_layers === null
          ? undefined
          : row.gpu_layers === 'auto'
            ? 'auto'
            : Number(row.gpu_layers),
      createdAt: row.created_at
    }))
  }

  private async probe(kind: LocalRuntimeKind): Promise<RuntimeProbe> {
    const configured =
      kind === 'ollama'
        ? this.deps.settings.get().ollamaBinaryPath
        : this.deps.settings.get().llamaServerBinaryPath
    const commandName = kind === 'ollama' ? 'ollama' : 'llama-server'
    const binaryPath = configured
      ? await canonicalExecutable(configured).catch(() => undefined)
      : await locateExecutable(commandName)
    if (!binaryPath) {
      return {
        kind,
        available: false,
        capabilities: { chat: false, streaming: false },
        error: 'runtime.binaryMissing'
      }
    }
    try {
      const versionResult = await command(binaryPath, ['--version']).catch((error: unknown) => ({
        stdout: String((error as { stdout?: string }).stdout ?? ''),
        stderr: String((error as { stderr?: string }).stderr ?? '')
      }))
      const helpResult = await command(binaryPath, ['--help'])
      const help = limited(`${helpResult.stdout}\n${helpResult.stderr}`)
      const version = limited(`${versionResult.stdout}\n${versionResult.stderr}`, 4096)
        .trim()
        .split(/\r?\n/)[0]
      const supportsChat =
        kind === 'ollama' || /chat.completions|chat template|--chat-template|\/v1\/chat/i.test(help)
      return {
        kind,
        available: supportsChat,
        binaryPath,
        version: version || undefined,
        endpoint:
          kind === 'ollama' ? `http://127.0.0.1:${this.deps.settings.get().ollamaPort}` : undefined,
        capabilities: {
          chat: supportsChat,
          streaming: supportsChat,
          autoFit: kind === 'llama.cpp' && /(?:^|\s)--fit(?:\s|,|$)/m.test(help),
          gpuOffload: kind === 'ollama' || /--n-gpu-layers|-ngl/m.test(help)
        },
        help,
        error: supportsChat ? undefined : 'runtime.chatUnsupported'
      }
    } catch (error) {
      return {
        kind,
        available: false,
        binaryPath,
        capabilities: { chat: false, streaming: false },
        error: error instanceof Error ? limited(error.message, 300) : 'runtime.probeFailed'
      }
    }
  }

  async discover(): Promise<RuntimeDiscovery[]> {
    const probes = await Promise.all([this.probe('ollama'), this.probe('llama.cpp')])
    this.probes = new Map(probes.map((item) => [item.kind, item]))
    await this.refreshImportedModels(probes.find((item) => item.kind === 'ollama'))
    return probes.map(({ help: _help, ...publicProbe }) => publicProbe)
  }

  async selectBinary(kind: LocalRuntimeKind, selectedPath: string): Promise<RuntimeDiscovery> {
    const canonical = await canonicalExecutable(selectedPath)
    this.deps.settings.set(
      kind === 'ollama' ? { ollamaBinaryPath: canonical } : { llamaServerBinaryPath: canonical }
    )
    const probe = await this.probe(kind)
    this.probes.set(kind, probe)
    const { help: _help, ...publicProbe } = probe
    return publicProbe
  }

  async assess(input: {
    runtime: LocalRuntimeKind
    fileSize: number
    contextLength: number
    layerCount?: number
    embeddingLength?: number
    kvHeadCount?: number
    cached?: boolean
    importedAlready?: boolean
  }): Promise<ModelFitAssessment> {
    const profile = await this.profile()
    return assessModelFit(profile, { ...input, cacheFreeBytes: profile.cacheFreeBytes })
  }

  async inspectCachedGguf(
    repoId: string,
    resolvedCommit: string,
    filePath: string
  ): Promise<GgufMetadataSummary | null> {
    const cached = await this.deps.cache.resolveFilePath('model', repoId, resolvedCommit, filePath)
    if (!cached) return null
    const metadata = await readGgufRuntimeMetadata(cached.absolutePath)
    return {
      ...metadata,
      hasChatTemplate: Boolean(metadata.chatTemplate)
    }
  }

  private async ensureProbe(kind: LocalRuntimeKind): Promise<RuntimeProbe> {
    const existing = this.probes.get(kind)
    if (existing?.available) return existing
    const discovered = await this.probe(kind)
    this.probes.set(kind, discovered)
    if (!discovered.available || !discovered.binaryPath) throw new Error('runtime.unavailable')
    return discovered
  }

  private async startLlama(
    probe: RuntimeProbe,
    absolutePath: string,
    contextLength: number,
    metadata: GgufRuntimeMetadata,
    profile: MachineProfile,
    requestedGpuLayers: 'auto' | number = 'auto'
  ): Promise<RunningLlama> {
    const binary = probe.binaryPath!
    const port = await freeLoopbackPort()
    const endpoint = `http://127.0.0.1:${port}`
    const freeGpu = profile.accelerators.reduce(
      (sum, accelerator) => sum + (accelerator.freeMemoryBytes ?? 0),
      0
    )
    const gpuLayers = quantizedGpuLayers(metadata, freeGpu)
    const baseArgs = [
      '--model',
      absolutePath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--ctx-size',
      String(contextLength)
    ]
    if (probe.help?.includes('--no-webui')) baseArgs.push('--no-webui')
    if (probe.help?.includes('--no-mmap')) {
      // Deliberately leave mmap enabled; the capability check only documents
      // that no unrecognized flag is added.
    }
    const explicitGpuLayers =
      typeof requestedGpuLayers === 'number'
        ? Math.max(0, Math.min(metadata.layerCount ?? requestedGpuLayers, requestedGpuLayers))
        : undefined
    const firstArgs =
      explicitGpuLayers !== undefined && probe.capabilities.gpuOffload
        ? [...baseArgs, '--n-gpu-layers', String(explicitGpuLayers)]
        : requestedGpuLayers === 'auto' && probe.capabilities.autoFit
          ? [...baseArgs, '--fit', 'on']
          : probe.capabilities.gpuOffload
            ? [...baseArgs, '--n-gpu-layers', String(gpuLayers)]
            : baseArgs

    const launch = async (args: string[]): Promise<RunningLlama> => {
      const child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, LLAMA_ARG_HOST: '127.0.0.1' }
      })
      const running: RunningLlama = { child, endpoint, stderr: '' }
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        running.stderr = limited(`${running.stderr}${chunk}`, 64 * 1024)
      })
      child.on('error', () => undefined)
      try {
        await waitForHealth(endpoint, child)
        return running
      } catch (error) {
        await killOwnedProcess(child)
        const message = `${running.stderr}\n${error instanceof Error ? error.message : String(error)}`
        const failure = error instanceof Error ? error : new Error(String(error))
        Object.assign(failure, { runtimeOutput: message })
        throw failure
      }
    }

    try {
      return await launch(firstArgs)
    } catch (error) {
      const output = String((error as { runtimeOutput?: string }).runtimeOutput ?? '')
      if (!/out of memory|cuda.*alloc|hip.*alloc|failed to allocate/i.test(output)) throw error
      // Exactly one bounded OOM retry, with GPU offload disabled.
      const retryArgs = probe.capabilities.gpuOffload
        ? [...baseArgs, '--n-gpu-layers', '0']
        : baseArgs
      try {
        return await launch(retryArgs)
      } catch (retryError) {
        const retryOutput = String((retryError as { runtimeOutput?: string }).runtimeOutput ?? '')
        if (/out of memory|cuda.*alloc|hip.*alloc|failed to allocate/i.test(retryOutput)) {
          throw new Error('runtime.oomAfterRetry', { cause: retryError })
        }
        throw retryError
      }
    }
  }

  private async importOllama(
    probe: RuntimeProbe,
    request: LocalRunRequest,
    absolutePath: string,
    metadata: GgufRuntimeMetadata
  ): Promise<string> {
    const modelName = modelNameFor(request, metadata)
    const existing = this.deps.db
      .prepare('SELECT model_name FROM local_models WHERE runtime = ? AND model_name = ?')
      .get('ollama', modelName) as { model_name: string } | undefined
    if (!existing) {
      const folder = await mkdtemp(join(tmpdir(), 'ohmyhf-ollama-'))
      const modelfile = join(folder, 'Modelfile')
      try {
        await writeFile(modelfile, `FROM ${JSON.stringify(absolutePath)}\n`, 'utf8')
        await command(probe.binaryPath!, ['create', modelName, '-f', modelfile], {
          timeout: 15 * 60_000,
          maxBuffer: 16 * 1024 * 1024,
          env: ollamaEnvironment(this.deps.settings.get().ollamaPort)
        })
        this.deps.db
          .prepare(
            `INSERT INTO local_models
             (runtime, model_name, repo_id, revision, resolved_commit, file_path, created_at, missing)
             VALUES ('ollama', ?, ?, ?, ?, ?, ?, 0)
             ON CONFLICT(runtime, model_name) DO UPDATE SET
               repo_id = excluded.repo_id,
               revision = excluded.revision,
               resolved_commit = excluded.resolved_commit,
               file_path = excluded.file_path,
               missing = 0`
          )
          .run(
            modelName,
            request.repoId,
            request.revision,
            request.resolvedCommit,
            request.filePath,
            new Date().toISOString()
          )
      } finally {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return modelName
  }

  async start(
    request: LocalRunRequest,
    acknowledgement?: SecurityAcknowledgement
  ): Promise<LocalRuntimeState> {
    await this.stop()
    this.setState({
      status: 'preparing',
      runtime: request.runtime,
      repoId: request.repoId,
      revision: request.revision,
      resolvedCommit: request.resolvedCommit,
      filePath: request.filePath
    })
    try {
      const securityRequest = {
        action: 'local-run' as const,
        kind: 'model' as const,
        repoId: request.repoId,
        revision: request.revision,
        resolvedCommit: request.resolvedCommit,
        files: [request.filePath]
      }
      const report = acknowledgement
        ? await this.deps.security.authorizeAcknowledged(securityRequest, acknowledgement)
        : await this.deps.security.authorize(securityRequest, request.securityGrantId)
      // Keep the variable intentionally used: the refreshed report is the
      // authorization evidence for this exact side effect, never renderer data.
      if (report.resolvedCommit !== request.resolvedCommit.toLowerCase()) {
        throw new Error('security.reportCommitMismatch')
      }
      const cached = await this.deps.cache.resolveFilePath(
        'model',
        request.repoId,
        request.resolvedCommit,
        request.filePath
      )
      if (!cached) throw new Error('runtime.fileNotCached')
      if (!request.filePath.toLowerCase().endsWith('.gguf')) throw new Error('runtime.ggufOnly')
      const metadata = await readGgufRuntimeMetadata(cached.absolutePath)
      if (!metadata.architecture) throw new Error('runtime.architectureUnknown')
      const modelDescriptor = `${metadata.architecture} ${metadata.modelType ?? ''}`
      if (
        (metadata.modelType && !/model/i.test(metadata.modelType)) ||
        /(?:^|[._ -])(?:clip|vision|projector|mmproj|embedding|embedder|reranker|rerank|bert)(?:$|[._ -])/i.test(
          modelDescriptor
        )
      ) {
        throw new Error('runtime.unsupportedModelType')
      }
      const probe = await this.ensureProbe(request.runtime)
      // Runtime API support alone does not prove that this particular GGUF is
      // an instruction/chat model. Until a runtime exposes a model-specific
      // compatibility probe, require the immutable file's own chat template.
      if (!metadata.chatTemplate) {
        throw new Error('runtime.chatTemplateMissing')
      }
      const contextLength = Math.min(
        request.contextLength ?? DEFAULT_CONTEXT,
        metadata.contextLength ?? request.contextLength ?? DEFAULT_CONTEXT
      )
      const profile = await this.profile()
      const fit = assessModelFit(profile, {
        runtime: request.runtime,
        fileSize: cached.info.size,
        contextLength,
        layerCount: metadata.layerCount,
        embeddingLength: metadata.embeddingLength,
        kvHeadCount: metadata.kvHeadCount,
        cacheFreeBytes: profile.cacheFreeBytes,
        cached: true,
        importedAlready:
          request.runtime === 'ollama' &&
          Boolean(
            this.deps.db
              .prepare(
                'SELECT 1 FROM local_models WHERE runtime = ? AND repo_id = ? AND resolved_commit = ? AND file_path = ? AND missing = 0'
              )
              .get('ollama', request.repoId, request.resolvedCommit, request.filePath)
          )
      })
      if ((fit.level === 'unlikely' || fit.level === 'unknown') && !request.allowTightFit) {
        throw new Error(`runtime.fitConfirmationRequired:${fit.level}`)
      }

      this.setState({ ...this.state, status: 'starting', contextLength })
      if (request.runtime === 'llama.cpp') {
        this.llama = await this.startLlama(
          probe,
          cached.absolutePath,
          contextLength,
          metadata,
          profile,
          request.gpuLayers
        )
        const ownedLlama = this.llama
        ownedLlama.child.once('exit', (_code, signal) => {
          if (this.llama !== ownedLlama) return
          this.llama = null
          if (this.state.status === 'stopping' || this.state.status === 'idle') return
          this.setState({
            ...this.state,
            status: 'error',
            error: signal ? `runtime.exited:${signal}` : 'runtime.exited'
          })
        })
        return this.setState({
          ...this.state,
          status: 'ready',
          endpoint: this.llama.endpoint,
          contextLength
        })
      }

      const modelName = await this.importOllama(probe, request, cached.absolutePath, metadata)
      const endpoint = `http://127.0.0.1:${this.deps.settings.get().ollamaPort}`
      // A zero-token chat loads the model without persisting any prompt.
      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelName, messages: [], stream: false, keep_alive: -1 }),
        signal: AbortSignal.timeout(START_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`runtime.ollamaLoadFailed:${response.status}`)
      this.activeOllamaModel = modelName
      const usage = await this.ollamaUsage(endpoint, modelName)
      return this.setState({
        ...this.state,
        status: 'ready',
        endpoint,
        modelName,
        contextLength,
        ...usage
      })
    } catch (error) {
      return this.setState({
        ...this.state,
        status: 'error',
        error: error instanceof Error ? limited(error.message, 500) : String(error)
      })
    }
  }

  startFromPostAction(request: {
    runtime: LocalRuntimeKind
    repoId: string
    revision: string
    resolvedCommit: string
    filePath: string
    contextLength: number
    maxTokens: number
    temperature: number
    gpuLayers?: 'auto' | number
    allowTightFit?: boolean
    securityAcknowledgement?: SecurityAcknowledgement
  }): Promise<LocalRuntimeState> {
    return this.start(
      {
        runtime: request.runtime,
        repoId: request.repoId,
        revision: request.revision,
        resolvedCommit: request.resolvedCommit,
        filePath: request.filePath,
        contextLength: request.contextLength,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        gpuLayers: request.gpuLayers,
        allowTightFit: request.allowTightFit
      },
      request.securityAcknowledgement
    )
  }

  private async ollamaUsage(
    endpoint: string,
    modelName: string
  ): Promise<Pick<LocalRuntimeState, 'loadedBytes' | 'loadedVramBytes'>> {
    try {
      const response = await fetch(`${endpoint}/api/ps`, { signal: AbortSignal.timeout(3_000) })
      if (!response.ok) return {}
      const payload = (await response.json()) as {
        models?: Array<{ name?: string; size?: number; size_vram?: number }>
      }
      const model = payload.models?.find((item) => item.name === modelName)
      return { loadedBytes: model?.size, loadedVramBytes: model?.size_vram }
    } catch {
      return {}
    }
  }

  chatStream(id: string, request: LocalChatRequest): void {
    if (this.state.status !== 'ready' || !this.state.endpoint || !this.state.runtime) {
      throw new Error('runtime.notReady')
    }
    if (this.streams.has(id)) throw new Error('runtime.duplicateStream')
    const controller = new AbortController()
    this.streams.set(id, controller)
    void this.streamChat(id, request, controller).finally(() => this.streams.delete(id))
  }

  private async streamChat(
    id: string,
    request: LocalChatRequest,
    controller: AbortController
  ): Promise<void> {
    try {
      const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS
      const temperature = request.temperature ?? DEFAULT_TEMPERATURE
      const isOllama = this.state.runtime === 'ollama'
      const response = await fetch(
        `${this.state.endpoint}${isOllama ? '/api/chat' : '/v1/chat/completions'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            isOllama
              ? {
                  model: this.activeOllamaModel,
                  messages: request.messages,
                  stream: true,
                  keep_alive: -1,
                  options: { temperature, num_predict: maxTokens }
                }
              : {
                  messages: request.messages,
                  stream: true,
                  temperature,
                  max_tokens: maxTokens
                }
          ),
          signal: controller.signal
        }
      )
      if (!response.ok || !response.body) throw new Error(`runtime.chatFailed:${response.status}`)
      const decoder = new TextDecoder()
      let buffered = ''
      let promptTokens: number | undefined
      let completionTokens: number | undefined
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true })
        const lines = buffered.split(/\r?\n/)
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const json = isOllama ? trimmed : trimmed.replace(/^data:\s*/, '')
          if (json === '[DONE]') continue
          let item: Record<string, unknown>
          try {
            item = JSON.parse(json) as Record<string, unknown>
          } catch {
            continue
          }
          const delta = isOllama
            ? (item.message as { content?: string } | undefined)?.content
            : (item.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta
                ?.content
          if (delta) this.deps.broadcastInference({ id, delta })
          const usage = item.usage as
            { prompt_tokens?: number; completion_tokens?: number } | undefined
          if (typeof usage?.prompt_tokens === 'number') promptTokens = usage.prompt_tokens
          if (typeof usage?.completion_tokens === 'number')
            completionTokens = usage.completion_tokens
          if (isOllama) {
            if (typeof item.prompt_eval_count === 'number') promptTokens = item.prompt_eval_count
            if (typeof item.eval_count === 'number') completionTokens = item.eval_count
          }
        }
      }
      this.deps.broadcastInference({ id, done: true, promptTokens, completionTokens })
    } catch (error) {
      if (controller.signal.aborted) {
        this.deps.broadcastInference({ id, done: true })
      } else {
        this.deps.broadcastInference({
          id,
          done: true,
          error: error instanceof Error ? limited(error.message, 500) : String(error)
        })
      }
    }
  }

  cancel(id: string): void {
    this.streams.get(id)?.abort()
  }

  async stop(): Promise<LocalRuntimeState> {
    if (this.state.status === 'idle' || this.state.status === 'unavailable') return this.getState()
    this.setState({ ...this.state, status: 'stopping', error: undefined })
    for (const controller of this.streams.values()) controller.abort()
    this.streams.clear()
    const llama = this.llama
    this.llama = null
    if (llama) await killOwnedProcess(llama.child)
    const ollamaModel = this.activeOllamaModel
    this.activeOllamaModel = null
    if (ollamaModel) {
      const endpoint = `http://127.0.0.1:${this.deps.settings.get().ollamaPort}`
      await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, messages: [], stream: false, keep_alive: 0 }),
        signal: AbortSignal.timeout(STOP_TIMEOUT_MS)
      }).catch(() => undefined)
    }
    return this.setState({ status: 'idle' })
  }

  async removeImportedModel(modelName: string): Promise<{ removed: boolean }> {
    const row = this.deps.db
      .prepare('SELECT model_name FROM local_models WHERE runtime = ? AND model_name = ?')
      .get('ollama', modelName) as { model_name: string } | undefined
    if (!row) return { removed: false }
    if (this.activeOllamaModel === modelName) await this.stop()
    const probe = await this.ensureProbe('ollama')
    await command(probe.binaryPath!, ['rm', modelName], {
      timeout: 60_000,
      env: ollamaEnvironment(this.deps.settings.get().ollamaPort)
    })
    this.deps.db
      .prepare('DELETE FROM local_models WHERE runtime = ? AND model_name = ?')
      .run('ollama', modelName)
    return { removed: true }
  }

  private async refreshImportedModels(probe: RuntimeProbe | undefined): Promise<void> {
    if (!probe?.available || !probe.binaryPath) return
    try {
      const result = await command(probe.binaryPath, ['list'], {
        env: ollamaEnvironment(this.deps.settings.get().ollamaPort)
      })
      const present = new Set(
        result.stdout
          .split(/\r?\n/)
          .slice(1)
          .map((line) => line.trim().split(/\s+/)[0])
          .filter((value): value is string => Boolean(value))
      )
      const rows = this.deps.db
        .prepare("SELECT model_name FROM local_models WHERE runtime = 'ollama'")
        .all() as Array<{ model_name: string }>
      const update = this.deps.db.prepare(
        "UPDATE local_models SET missing = ? WHERE runtime = 'ollama' AND model_name = ?"
      )
      this.deps.db.transaction(() => {
        for (const row of rows) update.run(present.has(row.model_name) ? 0 : 1, row.model_name)
      })()
    } catch {
      // Service may not be running; binary discovery remains useful.
    }
  }

  async shutdown(): Promise<void> {
    await this.stop()
  }
}

export const localRuntimeDefaults = {
  contextLength: DEFAULT_CONTEXT,
  maxTokens: DEFAULT_MAX_TOKENS,
  temperature: DEFAULT_TEMPERATURE
} as const

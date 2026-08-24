import { createServer, type Server } from 'node:http'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  LocalInferenceStreamEvent,
  LocalRuntimeState,
  MachineProfile,
  SecurityReport
} from '@oh-my-huggingface/shared'
import { LocalRuntimeManager } from './local-runtime'

const COMMIT = 'a'.repeat(40)
const roots: string[] = []
const managers: LocalRuntimeManager[] = []
// These tests intentionally launch fixture executables and bind loopback
// sockets. Sandboxed unit-test runners deny both; release CI and packaged smoke
// opt in so the same test file exercises real process/HTTP boundaries there.
const describeRuntimeIntegration =
  process.env.OHMYHF_RUNTIME_INTEGRATION === '1' ? describe : describe.skip

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

function u64(value: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value)
  return Buffer.concat([u64(bytes.length), bytes])
}

function metadata(key: string, value: string | number): Buffer {
  return typeof value === 'string'
    ? Buffer.concat([ggufString(key), u32(8), ggufString(value)])
    : Buffer.concat([ggufString(key), u32(4), u32(value)])
}

function chatGguf(): Buffer {
  const entries: Array<[string, string | number]> = [
    ['general.architecture', 'llama'],
    ['general.type', 'model'],
    ['general.file_type', 15],
    ['tokenizer.chat_template', '{{ messages }}'],
    ['llama.context_length', 8192],
    ['llama.block_count', 32],
    ['llama.embedding_length', 4096],
    ['llama.attention.head_count_kv', 8]
  ]
  return Buffer.concat([
    u32(0x46554747),
    u32(3),
    u64(0),
    u64(entries.length),
    ...entries.map(([key, value]) => metadata(key, value))
  ])
}

class RuntimeDatabase {
  readonly models = new Map<
    string,
    { repoId: string; revision: string; commit: string; filePath: string; missing: number }
  >()

  prepare(sql: string): {
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
    run: (...args: unknown[]) => unknown
  } {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    return {
      get: (...args) => {
        if (normalized.startsWith('SELECT model_name FROM local_models')) {
          const modelName = String(args[1])
          return this.models.has(modelName) ? { model_name: modelName } : undefined
        }
        if (normalized.startsWith('SELECT 1 FROM local_models')) {
          const [, repoId, commit, filePath] = args.map(String)
          return [...this.models.values()].some(
            (model) =>
              model.repoId === repoId &&
              model.commit === commit &&
              model.filePath === filePath &&
              model.missing === 0
          )
            ? { 1: 1 }
            : undefined
        }
        return undefined
      },
      all: () => {
        if (normalized.includes("SELECT model_name FROM local_models WHERE runtime = 'ollama'")) {
          return [...this.models.keys()].map((model_name) => ({ model_name }))
        }
        return []
      },
      run: (...args) => {
        if (normalized.startsWith('INSERT INTO local_models')) {
          const [modelName, repoId, revision, commit, filePath] = args.map(String)
          this.models.set(modelName!, {
            repoId: repoId!,
            revision: revision!,
            commit: commit!,
            filePath: filePath!,
            missing: 0
          })
        } else if (normalized.startsWith('DELETE FROM local_models')) {
          this.models.delete(String(args[1]))
        } else if (normalized.startsWith('UPDATE local_models SET missing')) {
          const missing = Number(args[0])
          const model = this.models.get(String(args[1]))
          if (model) model.missing = missing
        }
        return { changes: 1 }
      }
    }
  }

  transaction<T>(fn: () => T): () => T {
    return () => fn()
  }
}

function machineProfile(cacheFreeBytes = 100 * 1024 ** 3): MachineProfile {
  return {
    platform: process.platform as MachineProfile['platform'],
    arch: process.arch,
    cpuModel: 'fixture cpu',
    cpuCount: 8,
    totalMemoryBytes: 32 * 1024 ** 3,
    freeMemoryBytes: 24 * 1024 ** 3,
    cacheFreeBytes,
    accelerators: [
      {
        vendor: 'nvidia',
        name: 'fixture gpu',
        totalMemoryBytes: 8 * 1024 ** 3,
        freeMemoryBytes: 6 * 1024 ** 3
      }
    ],
    probedAt: '2026-08-24T00:00:00.000Z'
  }
}

function safeReport(): SecurityReport {
  return {
    kind: 'model',
    repoId: 'org/repo',
    revision: 'v1',
    resolvedCommit: COMMIT,
    overall: 'safe',
    evidence: [{ source: 'fixture', status: 'safe', filePath: 'model.gguf' }],
    reasons: [],
    fingerprint: `sha256:${'f'.repeat(64)}`,
    checkedAt: '2026-08-24T00:00:00.000Z'
  }
}

async function fixtureFiles(): Promise<{
  root: string
  modelPath: string
  llamaPath: string
  commandLog: string
  launchCount: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'ohmyhf-runtime-'))
  roots.push(root)
  const modelPath = join(root, 'model.gguf')
  const llamaPath = join(root, 'llama-server')
  const commandLog = join(root, 'llama-args.jsonl')
  const launchCount = join(root, 'launch-count')
  await writeFile(modelPath, chatGguf())
  await writeFile(
    llamaPath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('llama-server fixture 1.0'); process.exit(0) }
if (args[0] === '--help') {
  console.log('--model --host --port --ctx-size --fit --n-gpu-layers --no-webui /v1/chat/completions chat template')
  process.exit(0)
}
fs.appendFileSync(process.env.FAKE_LLAMA_LOG, JSON.stringify(args) + '\\n')
const countPath = process.env.FAKE_LLAMA_COUNT
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0
fs.writeFileSync(countPath, String(count + 1))
if (process.env.FAKE_LLAMA_OOM_ALWAYS === '1' || (process.env.FAKE_LLAMA_OOM_ONCE === '1' && count === 0)) {
  console.error('CUDA failed to allocate: out of memory')
  process.exit(1)
}
const port = Number(args[args.indexOf('--port') + 1])
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\\n\\n')
    res.write('data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\\n\\n')
    res.end('data: [DONE]\\n\\n')
    return
  }
  res.writeHead(404); res.end()
})
server.listen(port, '127.0.0.1')
const close = () => server.close(() => process.exit(0))
process.on('SIGTERM', close)
process.on('SIGINT', close)
`,
    { mode: 0o755 }
  )
  await chmod(llamaPath, 0o755)
  return { root, modelPath, llamaPath, commandLog, launchCount }
}

function managerFor(input: {
  modelPath: string
  cacheRoot: string
  llamaPath?: string
  ollamaPath?: string
  ollamaPort?: number
  db?: RuntimeDatabase
  inference?: LocalInferenceStreamEvent[]
  states?: LocalRuntimeState[]
}): LocalRuntimeManager {
  const db = input.db ?? new RuntimeDatabase()
  const settingsValue = {
    hubEndpoint: 'https://huggingface.co',
    ollamaBinaryPath: input.ollamaPath ?? null,
    llamaServerBinaryPath: input.llamaPath ?? null,
    ollamaPort: input.ollamaPort ?? 11434
  }
  const manager = new LocalRuntimeManager({
    db: db as never,
    settings: {
      get: () => settingsValue,
      set: (patch: Partial<typeof settingsValue>) => Object.assign(settingsValue, patch)
    } as never,
    cache: {
      cacheDir: () => input.cacheRoot,
      resolveFilePath: vi.fn().mockResolvedValue({
        absolutePath: input.modelPath,
        info: {
          kind: 'model',
          repoId: 'org/repo',
          commit: COMMIT,
          path: 'model.gguf',
          size: chatGguf().byteLength
        }
      })
    } as never,
    security: {
      authorize: vi.fn().mockResolvedValue(safeReport()),
      authorizeAcknowledged: vi.fn().mockResolvedValue(safeReport())
    } as never,
    broadcastState: (state) => input.states?.push(state),
    broadcastInference: (event) => input.inference?.push(event)
  })
  ;(manager as unknown as { profile: () => Promise<MachineProfile> }).profile = vi
    .fn()
    .mockResolvedValue(machineProfile())
  managers.push(manager)
  return manager
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown().catch(() => undefined)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  delete process.env.FAKE_LLAMA_LOG
  delete process.env.FAKE_LLAMA_COUNT
  delete process.env.FAKE_LLAMA_OOM_ONCE
  delete process.env.FAKE_LLAMA_OOM_ALWAYS
})

describeRuntimeIntegration('LocalRuntimeManager llama.cpp integration', () => {
  it('probes a real fixture executable, binds loopback, streams SSE and stops its process', async () => {
    const fixture = await fixtureFiles()
    process.env.FAKE_LLAMA_LOG = fixture.commandLog
    process.env.FAKE_LLAMA_COUNT = fixture.launchCount
    const inference: LocalInferenceStreamEvent[] = []
    const manager = managerFor({
      modelPath: fixture.modelPath,
      cacheRoot: fixture.root,
      llamaPath: fixture.llamaPath,
      inference
    })

    const discoveries = await manager.discover()
    expect(discoveries.find((item) => item.kind === 'llama.cpp')).toMatchObject({
      available: true,
      binaryPath: fixture.llamaPath,
      capabilities: { chat: true, streaming: true, autoFit: true, gpuOffload: true }
    })
    const state = await manager.start({
      runtime: 'llama.cpp',
      repoId: 'org/repo',
      revision: 'v1',
      resolvedCommit: COMMIT,
      filePath: 'model.gguf',
      contextLength: 4096,
      maxTokens: 32,
      temperature: 0.2,
      gpuLayers: 'auto',
      allowTightFit: true
    })
    expect(state).toMatchObject({
      status: 'ready',
      runtime: 'llama.cpp',
      repoId: 'org/repo',
      resolvedCommit: COMMIT,
      contextLength: 4096
    })
    expect(state.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const launchArgs = JSON.parse((await readFile(fixture.commandLog, 'utf8')).trim()) as string[]
    expect(launchArgs).toEqual(
      expect.arrayContaining([
        '--model',
        fixture.modelPath,
        '--host',
        '127.0.0.1',
        '--ctx-size',
        '4096',
        '--fit',
        'on',
        '--no-webui'
      ])
    )

    manager.chatStream('stream-1', {
      messages: [{ role: 'user', content: 'local-only prompt' }],
      maxTokens: 8,
      temperature: 0
    })
    await vi.waitFor(() => expect(inference.some((event) => event.done)).toBe(true))
    expect(
      inference
        .filter((event) => event.delta)
        .map((event) => event.delta)
        .join('')
    ).toBe('hello world')
    expect(inference.at(-1)).toMatchObject({
      id: 'stream-1',
      done: true,
      promptTokens: 3,
      completionTokens: 2
    })
    await expect(manager.stop()).resolves.toEqual({ status: 'idle' })
  })

  it('retries exactly once with zero GPU layers after an OOM startup', async () => {
    const fixture = await fixtureFiles()
    process.env.FAKE_LLAMA_LOG = fixture.commandLog
    process.env.FAKE_LLAMA_COUNT = fixture.launchCount
    process.env.FAKE_LLAMA_OOM_ONCE = '1'
    const manager = managerFor({
      modelPath: fixture.modelPath,
      cacheRoot: fixture.root,
      llamaPath: fixture.llamaPath
    })

    const state = await manager.start({
      runtime: 'llama.cpp',
      repoId: 'org/repo',
      revision: 'v1',
      resolvedCommit: COMMIT,
      filePath: 'model.gguf',
      contextLength: 2048,
      gpuLayers: 'auto',
      allowTightFit: true
    })
    expect(state.status).toBe('ready')
    const launches = (await readFile(fixture.commandLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    expect(launches).toHaveLength(2)
    expect(launches[0]).toEqual(expect.arrayContaining(['--fit', 'on']))
    expect(launches[1]).toEqual(expect.arrayContaining(['--n-gpu-layers', '0']))
    expect(await readFile(fixture.launchCount, 'utf8')).toBe('2')
  })

  it('stops after the bounded OOM retry and returns actionable error state', async () => {
    const fixture = await fixtureFiles()
    process.env.FAKE_LLAMA_LOG = fixture.commandLog
    process.env.FAKE_LLAMA_COUNT = fixture.launchCount
    process.env.FAKE_LLAMA_OOM_ALWAYS = '1'
    const manager = managerFor({
      modelPath: fixture.modelPath,
      cacheRoot: fixture.root,
      llamaPath: fixture.llamaPath
    })

    const state = await manager.start({
      runtime: 'llama.cpp',
      repoId: 'org/repo',
      revision: 'v1',
      resolvedCommit: COMMIT,
      filePath: 'model.gguf',
      contextLength: 2048,
      gpuLayers: 'auto',
      allowTightFit: true
    })
    expect(state).toMatchObject({ status: 'error', error: 'runtime.oomAfterRetry' })
    expect(await readFile(fixture.launchCount, 'utf8')).toBe('2')
  })
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server has no port')
  return address.port
}

describeRuntimeIntegration('LocalRuntimeManager Ollama integration', () => {
  it('imports only its exact GGUF, streams NDJSON, reports usage, unloads and deletes its copy', async () => {
    const fixture = await fixtureFiles()
    const ollamaPath = join(fixture.root, 'ollama')
    const commandLog = join(fixture.root, 'ollama-commands.jsonl')
    await writeFile(
      ollamaPath,
      `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('ollama fixture 1.0'); process.exit(0) }
if (args[0] === '--help') { console.log('ollama create list rm chat streaming'); process.exit(0) }
if (args[0] === 'list') { console.log('NAME ID SIZE MODIFIED'); process.exit(0) }
fs.appendFileSync(process.env.FAKE_OLLAMA_LOG, JSON.stringify(args) + '\\n')
process.exit(0)
`,
      { mode: 0o755 }
    )
    await chmod(ollamaPath, 0o755)
    process.env.FAKE_OLLAMA_LOG = commandLog

    const requests: Array<Record<string, unknown>> = []
    let loadedModel = ''
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        if (request.url === '/api/ps') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({ models: [{ name: loadedModel, size: 1234, size_vram: 567 }] })
          )
          return
        }
        if (request.url !== '/api/chat') {
          response.writeHead(404).end()
          return
        }
        const payload = JSON.parse(body) as Record<string, unknown>
        requests.push(payload)
        loadedModel = String(payload.model ?? loadedModel)
        if (payload.stream === true) {
          response.writeHead(200, { 'content-type': 'application/x-ndjson' })
          response.write('{"message":{"content":"ollama "}}\n')
          response.end(
            '{"message":{"content":"ok"},"prompt_eval_count":4,"eval_count":2,"done":true}\n'
          )
        } else {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"done":true}')
        }
      })
    })
    const port = await listen(server)
    const db = new RuntimeDatabase()
    const inference: LocalInferenceStreamEvent[] = []
    const manager = managerFor({
      modelPath: fixture.modelPath,
      cacheRoot: fixture.root,
      ollamaPath,
      ollamaPort: port,
      db,
      inference
    })
    try {
      const state = await manager.start({
        runtime: 'ollama',
        repoId: 'org/repo',
        revision: 'v1',
        resolvedCommit: COMMIT,
        filePath: 'model.gguf',
        contextLength: 2048,
        allowTightFit: true
      })
      expect(state).toMatchObject({
        status: 'ready',
        runtime: 'ollama',
        loadedBytes: 1234,
        loadedVramBytes: 567
      })
      expect(state.modelName).toContain(`org-repo-${COMMIT.slice(0, 8)}`)
      expect(db.models.has(state.modelName!)).toBe(true)
      const createArgs = JSON.parse((await readFile(commandLog, 'utf8')).trim()) as string[]
      expect(createArgs).toEqual(expect.arrayContaining(['create', state.modelName!, '-f']))

      manager.chatStream('ollama-stream', {
        messages: [{ role: 'user', content: 'not persisted' }]
      })
      await vi.waitFor(() => expect(inference.some((event) => event.done)).toBe(true))
      expect(
        inference
          .filter((event) => event.delta)
          .map((event) => event.delta)
          .join('')
      ).toBe('ollama ok')
      await manager.stop()
      expect(requests.at(-1)).toMatchObject({
        model: state.modelName,
        keep_alive: 0,
        messages: []
      })

      await expect(manager.removeImportedModel(state.modelName!)).resolves.toEqual({
        removed: true
      })
      expect(db.models.has(state.modelName!)).toBe(false)
      const commands = (await readFile(commandLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
      expect(commands.at(-1)).toEqual(['rm', state.modelName])
    } finally {
      await manager.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      delete process.env.FAKE_OLLAMA_LOG
    }
  })
})

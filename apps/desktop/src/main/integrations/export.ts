/** Export cached files to Ollama, LM Studio, or ComfyUI with cancellation. */
import { createReadStream, createWriteStream, existsSync, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { repoCachePaths } from '@oh-my-huggingface/hub-api'
import type { ExportResult, ExportTarget, ExportTool, RepoKind } from '@oh-my-huggingface/shared'
import type { ExportDeps } from './types'

const OLLAMA_TIMEOUT_MS = 15 * 60 * 1000

export interface ExportPipelineResult extends ExportResult {
  outputPath?: string
  outputLabel?: string
}

function comfyuiCandidates(home = homedir(), configured?: string[]): string[] {
  if (configured) return configured
  return [process.env.COMFYUI_PATH ?? '', join(home, 'ComfyUI'), join(home, 'comfyui')].filter(
    Boolean
  )
}

export function detectExportTargets(
  environment: Pick<ExportDeps, 'homeDir' | 'comfyuiPaths'> = {}
): ExportTarget[] {
  const home = environment.homeDir ?? homedir()
  const candidates: Record<ExportTool, string[]> = {
    ollama: [join(home, '.ollama')],
    lmstudio: [join(home, '.lmstudio'), join(home, '.cache', 'lm-studio')],
    comfyui: comfyuiCandidates(home, environment.comfyuiPaths)
  }
  return (Object.keys(candidates) as ExportTool[]).map((tool) => {
    const path = candidates[tool].find((candidate) => existsSync(candidate))
    return { tool, detected: Boolean(path), path }
  })
}

function fail(messageKey: string, params?: Record<string, string>): ExportPipelineResult {
  return { ok: false, messageKey, params }
}

async function findSnapshotFile(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  commit: string,
  filePath: string,
  signal: AbortSignal
): Promise<string | null> {
  signal.throwIfAborted()
  const { repoDir, snapshotsDir } = repoCachePaths(cacheDir, kind, repoId)
  if (!/^[0-9a-f]{40}$/.test(commit) || !existsSync(join(snapshotsDir, commit))) return null

  const snapshotDir = resolve(snapshotsDir, commit)
  const file = resolve(snapshotDir, filePath)
  if (!file.startsWith(snapshotDir + sep)) return null
  if (!existsSync(file)) return null
  try {
    // Snapshot files are normally symlinks into this repository's blobs/. Keep
    // those valid while rejecting a poisoned cache symlink to an arbitrary file.
    const repositoryRoot = await fs.realpath(repoDir)
    const source = await fs.realpath(file)
    const sourceStats = await fs.stat(source)
    const rel = relative(repositoryRoot, source)
    if (!sourceStats.isFile() || rel === '' || rel === '..' || rel.startsWith(`..${sep}`))
      return null
    return source
  } catch {
    return null
  }
}

async function findOllamaBinary(signal: AbortSignal, home: string): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await run(locator, ['ollama'], { signal })
    const found = stdout.trim().split(/\r?\n/)[0]?.trim()
    if (found && existsSync(found)) return found
  } catch (err) {
    if (signal.aborted) throw err
  }
  const candidates =
    process.platform === 'win32'
      ? [join(home, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe')]
      : ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

async function linkOrCopy(source: string, destination: string, deps: ExportDeps): Promise<void> {
  deps.signal.throwIfAborted()
  const realSource = await fs.realpath(source)
  await fs.mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.omhf-${randomUUID()}.partial`
  try {
    await (deps.linkFile ?? fs.link)(realSource, partial)
    deps.signal.throwIfAborted()
    await fs.rm(destination, { force: true })
    await fs.rename(partial, destination)
    deps.onProgress({ phase: 'copying', progress: 1 })
    return
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => {})
    if (deps.signal.aborted) {
      throw err
    }
  }

  const total = Math.max(1, (await fs.stat(realSource)).size)
  let copied = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.byteLength
      deps.onProgress({ phase: 'copying', progress: Math.min(1, copied / total) })
      callback(null, chunk)
    }
  })
  try {
    await pipeline(
      createReadStream(realSource),
      meter,
      createWriteStream(partial, { flags: 'wx' }),
      {
        signal: deps.signal
      }
    )
    deps.signal.throwIfAborted()
    await fs.rm(destination, { force: true })
    await fs.rename(partial, destination)
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => {})
    throw err
  }
}

async function exportToOllama(
  repoId: string,
  filePath: string,
  snapshotFile: string,
  deps: ExportDeps
): Promise<ExportPipelineResult> {
  const binary =
    deps.ollamaBinary ?? (await findOllamaBinary(deps.signal, deps.homeDir ?? homedir()))
  if (!binary) return fail('export.ollamaMissing')

  const [org = '', name = ''] = repoId.split('/')
  const fileBase = basename(filePath).replace(/\.gguf$/i, '')
  const modelName =
    `${org}-${name}-${fileBase}`
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '') || 'model'
  let run = deps.runOllama
  if (!run) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    run = promisify(execFile)
  }
  const tempDir = await fs.mkdtemp(join(deps.tempDir ?? tmpdir(), 'omhf-ollama-'))
  const modelfile = join(tempDir, 'Modelfile')
  try {
    await fs.writeFile(modelfile, `FROM ${snapshotFile}\n`, 'utf8')
    deps.onProgress({ phase: 'running' })
    await run(binary, ['create', modelName, '-f', modelfile], {
      timeout: OLLAMA_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      signal: deps.signal
    })
    return {
      ok: true,
      messageKey: 'export.ollamaDone',
      params: { name: modelName },
      outputLabel: modelName
    }
  } catch (err) {
    if (deps.signal.aborted) throw err
    const stderr = (err as { stderr?: string }).stderr
    const detail = (stderr?.trim() || (err instanceof Error ? err.message : String(err))).slice(
      0,
      200
    )
    return fail('export.ollamaFailed', { error: detail })
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function exportToLmStudio(
  repoId: string,
  filePath: string,
  snapshotFile: string,
  deps: ExportDeps
): Promise<ExportPipelineResult> {
  const [org = '', name = ''] = repoId.split('/')
  if (!name || /^\.+$/.test(org) || /^\.+$/.test(name)) {
    return fail('export.invalidPath', { file: repoId })
  }
  const destination = join(
    deps.homeDir ?? homedir(),
    '.lmstudio',
    'models',
    org,
    name,
    basename(filePath)
  )
  await linkOrCopy(snapshotFile, destination, deps)
  return {
    ok: true,
    messageKey: 'export.copied',
    params: { path: destination },
    outputPath: destination,
    outputLabel: destination
  }
}

async function exportToComfyui(
  filePath: string,
  snapshotFile: string,
  deps: ExportDeps
): Promise<ExportPipelineResult> {
  const baseDir = comfyuiCandidates(deps.homeDir ?? homedir(), deps.comfyuiPaths).find(
    (candidate) => existsSync(candidate)
  )
  if (!baseDir) return fail('export.comfyuiMissing')
  const lower = basename(filePath).toLowerCase()
  const subfolder = lower.includes('lora')
    ? 'loras'
    : lower.includes('vae')
      ? 'vae'
      : lower.includes('controlnet')
        ? 'controlnet'
        : 'checkpoints'
  const destination = join(baseDir, 'models', subfolder, basename(filePath))
  await linkOrCopy(snapshotFile, destination, deps)
  return {
    ok: true,
    messageKey: 'export.copied',
    params: { path: destination },
    outputPath: destination,
    outputLabel: destination
  }
}

export async function runExport(
  tool: ExportTool,
  kind: RepoKind,
  repoId: string,
  filePath: string,
  deps: ExportDeps
): Promise<ExportPipelineResult> {
  const segments = filePath.split('/')
  if (
    !filePath ||
    filePath.includes('\\') ||
    isAbsolute(filePath) ||
    win32.isAbsolute(filePath) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return fail('export.invalidPath', { file: filePath })
  }
  deps.signal.throwIfAborted()
  deps.onProgress({ phase: 'preparing', progress: 0 })
  if (!deps.resolvedCommit) return fail('export.revisionRequired')
  const snapshotFile = await findSnapshotFile(
    deps.cacheDir,
    kind,
    repoId,
    deps.resolvedCommit,
    filePath,
    deps.signal
  )
  if (!snapshotFile) return fail('export.notInCache', { file: filePath })

  try {
    switch (tool) {
      case 'ollama':
        return await exportToOllama(repoId, filePath, snapshotFile, deps)
      case 'lmstudio':
        return await exportToLmStudio(repoId, filePath, snapshotFile, deps)
      case 'comfyui':
        return await exportToComfyui(filePath, snapshotFile, deps)
    }
  } catch (err) {
    if (deps.signal.aborted) throw err
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 200)
    return fail('export.failed', { error: detail })
  }
}

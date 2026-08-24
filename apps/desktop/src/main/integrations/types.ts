import type { IpcEventChannel, IpcEventPayload } from '@oh-my-huggingface/shared'

export type Broadcast = <C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>) => void

export interface ExportDeps {
  cacheDir: string
  /** Immutable snapshot selected by the user; exports never guess a ref. */
  resolvedCommit?: string
  signal: AbortSignal
  onProgress: (progress: { phase: 'preparing' | 'copying' | 'running'; progress?: number }) => void
  /** Optional runtime seams keep tests inside temporary directories. */
  homeDir?: string
  tempDir?: string
  comfyuiPaths?: string[]
  linkFile?: (source: string, destination: string) => Promise<void>
  ollamaBinary?: string
  runOllama?: (
    binary: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; signal: AbortSignal }
  ) => Promise<unknown>
}

export interface InferenceDeps {
  accessToken: string | undefined
  broadcast: Broadcast
}

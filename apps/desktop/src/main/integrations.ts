/**
 * Phase E: local-toolchain integrations (export to Ollama / LM Studio / ComfyUI),
 * upload workflow, and the inference playground backend.
 *
 * Result/progress messages travel as i18n keys in the renderer's `integrations`
 * namespace so every surface stays localized. Implementations live under
 * `./integrations/`; this facade keeps the wiring surface for ipc.ts stable.
 */
export type { Broadcast, ExportDeps, InferenceDeps } from './integrations/types'
export { detectExportTargets, runExport } from './integrations/export'
export { createRepoAndUpload } from './integrations/upload'
export { commitRepoFiles } from './integrations/commit'
export { cancelInference, runInference, runInferenceStream } from './integrations/inference'

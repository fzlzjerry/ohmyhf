import type { LocalRuntimeKind, MachineProfile, ModelFitAssessment } from './types'

const GIB = 1024 ** 3

export interface ModelFitInput {
  runtime: LocalRuntimeKind
  fileSize: number
  contextLength: number
  layerCount?: number
  embeddingLength?: number
  kvHeadCount?: number
  cacheFreeBytes?: number
  /** True when the exact GGUF already exists in the selected cache root. */
  cached?: boolean
  importedAlready?: boolean
}

export function assessModelFit(profile: MachineProfile, input: ModelFitInput): ModelFitAssessment {
  const estimatedWeightBytes = Math.max(0, input.fileSize)
  const hasKvMetadata = Boolean(
    input.layerCount && input.embeddingLength && input.kvHeadCount && input.contextLength
  )
  const headDimension =
    hasKvMetadata && input.embeddingLength && input.kvHeadCount
      ? input.embeddingLength / Math.max(1, input.kvHeadCount)
      : undefined
  const estimatedKvBytes =
    hasKvMetadata && input.layerCount && input.kvHeadCount && headDimension
      ? Math.ceil(
          2 * input.layerCount * input.contextLength * input.kvHeadCount * headDimension * 2
        )
      : Math.ceil(Math.min(2 * GIB, estimatedWeightBytes * 0.2))
  const estimatedRuntimeBytes = Math.max(512 * 1024 ** 2, Math.ceil(estimatedWeightBytes * 0.12))
  const osReserve = Math.max(2 * GIB, Math.ceil(profile.totalMemoryBytes * 0.1))
  const availableMemoryBytes = Math.max(0, profile.freeMemoryBytes - osReserve)
  const gpuMemory = profile.accelerators.reduce(
    (sum, gpu) => sum + (gpu.freeMemoryBytes ?? gpu.totalMemoryBytes ?? 0),
    0
  )
  const discreteGpuMemory = profile.accelerators
    .filter((gpu) => gpu.unifiedMemory !== true)
    .reduce((sum, gpu) => sum + (gpu.freeMemoryBytes ?? gpu.totalMemoryBytes ?? 0), 0)
  // Reserve 10% of reported free VRAM for driver/runtime allocations. Keep KV
  // cache in the system estimate because placement differs by backend/build.
  const estimatedGpuBytes = Math.min(estimatedWeightBytes, Math.floor(discreteGpuMemory * 0.9))
  const estimatedSystemMemoryBytes =
    estimatedWeightBytes - estimatedGpuBytes + estimatedKvBytes + estimatedRuntimeBytes
  const requiredDiskBytes =
    (input.cached ? 0 : estimatedWeightBytes) +
    (input.runtime === 'ollama' && !input.importedAlready ? estimatedWeightBytes : 0)
  const cacheFree = input.cacheFreeBytes ?? profile.cacheFreeBytes
  const reasons: string[] = []
  if (!hasKvMetadata) reasons.push('fit.metadataIncomplete')
  if (cacheFree !== undefined && cacheFree < requiredDiskBytes) reasons.push('fit.diskInsufficient')

  let level: ModelFitAssessment['level']
  if (estimatedWeightBytes <= 0 || !hasKvMetadata) level = 'unknown'
  else if (cacheFree !== undefined && cacheFree < requiredDiskBytes) level = 'unlikely'
  else if (availableMemoryBytes >= estimatedSystemMemoryBytes * 1.2) level = 'comfortable'
  else if (availableMemoryBytes >= estimatedSystemMemoryBytes) level = 'tight'
  else level = 'unlikely'

  if (level === 'comfortable') reasons.push('fit.memoryComfortable')
  if (level === 'tight') reasons.push('fit.memoryTight')
  if (level === 'unlikely') reasons.push('fit.memoryInsufficient')
  if (estimatedGpuBytes > 0) reasons.push('fit.gpuOffloadEstimated')
  if (profile.accelerators.length === 0) reasons.push('fit.cpuOnly')

  return {
    runtime: input.runtime,
    level,
    estimatedWeightBytes,
    estimatedKvBytes,
    estimatedRuntimeBytes,
    estimatedSystemMemoryBytes,
    estimatedGpuBytes,
    requiredDiskBytes,
    availableMemoryBytes,
    availableGpuMemoryBytes: gpuMemory > 0 ? gpuMemory : undefined,
    reasons: [...new Set(reasons)]
  }
}

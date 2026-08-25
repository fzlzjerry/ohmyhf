import { describe, expect, it } from 'vitest'
import type { MachineProfile } from '@oh-my-huggingface/shared'
import {
  exportToolsForFormat,
  listWeightFiles,
  parseQuantLabel,
  preferredWeightFile,
  recommendWeightFileForProfile
} from '@oh-my-huggingface/shared'

describe('parseQuantLabel', () => {
  it('reads common GGUF quant tokens', () => {
    expect(parseQuantLabel('Llama-3-8B-Instruct-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(parseQuantLabel('model-q5_k_s.gguf')).toBe('Q5_K_S')
    expect(parseQuantLabel('phi-3-mini-f16.gguf')).toBe('F16')
    expect(parseQuantLabel('weights.IQ4_XS.gguf')).toBe('IQ4_XS')
    expect(parseQuantLabel('repo/foo_Q8_0.gguf')).toBe('Q8_0')
    expect(parseQuantLabel('model-fp16.safetensors')).toBe('FP16')
    expect(parseQuantLabel('weights.bf16.gguf')).toBe('BF16')
    expect(parseQuantLabel('chunk.IQ2_XXS.gguf')).toBe('IQ2_XXS')
  })

  it('returns undefined when no quant token is present', () => {
    expect(parseQuantLabel('model.gguf')).toBeUndefined()
    expect(parseQuantLabel('README.md')).toBeUndefined()
    expect(parseQuantLabel('Llama-3-8B-Instruct.gguf')).toBeUndefined()
  })

  it('stays linear on the CodeQL pump strings', () => {
    const f0Pump = `q9${'_f0'.repeat(800)}.gguf`
    const f0UnderscorePump = `q9_${'0_f0_'.repeat(400)}x.gguf`
    const started = performance.now()
    expect(parseQuantLabel(f0Pump)?.startsWith('Q9_F0')).toBe(true)
    expect(parseQuantLabel(f0UnderscorePump)?.startsWith('Q9_0_F0')).toBe(true)
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('listWeightFiles', () => {
  it('keeps GGUF and diffusion weights, skips optimizer shards', () => {
    const files = listWeightFiles([
      { rfilename: 'README.md' },
      { rfilename: 'model-Q4_K_M.gguf', size: 4 },
      { rfilename: 'model-Q8_0.gguf', size: 8 },
      { rfilename: 'sd_xl.safetensors', size: 12 },
      { rfilename: 'optimizer.pt', size: 1 }
    ])
    expect(files.map((file) => file.path)).toEqual([
      'model-Q4_K_M.gguf',
      'model-Q8_0.gguf',
      'sd_xl.safetensors'
    ])
    expect(files[0]?.quant).toBe('Q4_K_M')
    expect(exportToolsForFormat('gguf')).toEqual(['ollama', 'lmstudio', 'comfyui'])
    expect(exportToolsForFormat('safetensors')).toEqual(['comfyui'])
  })
})

describe('preferredWeightFile', () => {
  it('prefers Q4_K_M over larger GGUF files', () => {
    const files = listWeightFiles([
      { path: 'model-Q8_0.gguf', size: 80 },
      { path: 'model-Q4_K_M.gguf', size: 40 }
    ])
    expect(preferredWeightFile(files)?.path).toBe('model-Q4_K_M.gguf')
  })

  it('falls back to the largest non-GGUF weight', () => {
    const files = listWeightFiles([
      { path: 'small.safetensors', size: 2 },
      { path: 'big.safetensors', size: 20 }
    ])
    expect(preferredWeightFile(files)?.path).toBe('big.safetensors')
  })
})

const GIB = 1024 ** 3

function profile(overrides: Partial<MachineProfile> = {}): MachineProfile {
  return {
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'Test CPU',
    cpuCount: 8,
    totalMemoryBytes: 32 * GIB,
    freeMemoryBytes: 24 * GIB,
    cacheFreeBytes: 100 * GIB,
    accelerators: [],
    probedAt: '2026-08-25T00:00:00.000Z',
    ...overrides
  }
}

describe('recommendWeightFileForProfile', () => {
  it('chooses the largest comfortable GGUF before a larger tight fit', () => {
    const files = listWeightFiles([
      { path: 'model-Q4_K_M.gguf', size: 8 * GIB },
      { path: 'model-Q8_0.gguf', size: 16 * GIB },
      { path: 'model-Q5_K_M.gguf', size: 6 * GIB }
    ])
    const result = recommendWeightFileForProfile(files, profile())

    expect(result.recommendedPath).toBe('model-Q4_K_M.gguf')
    expect(result.estimates.find((item) => item.path === 'model-Q4_K_M.gguf')?.level).toBe(
      'comfortable'
    )
    expect(result.estimates.find((item) => item.path === 'model-Q8_0.gguf')?.level).toBe('tight')
  })

  it('falls back to the largest tight fit when none are comfortable', () => {
    const files = listWeightFiles([
      { path: 'model-Q4_K_M.gguf', size: 5 * GIB },
      { path: 'model-Q5_K_M.gguf', size: 6 * GIB }
    ])
    const result = recommendWeightFileForProfile(
      files,
      profile({ totalMemoryBytes: 16 * GIB, freeMemoryBytes: 9 * GIB })
    )

    expect(result.recommendedPath).toBe('model-Q4_K_M.gguf')
    expect(result.estimates.find((item) => item.path === 'model-Q4_K_M.gguf')?.level).toBe('tight')
  })

  it('does not recommend files that cannot fit memory or disk', () => {
    const files = listWeightFiles([
      { path: 'model-Q4_K_M.gguf', size: 5 * GIB },
      { path: 'model-Q5_K_M.gguf', size: 6 * GIB }
    ])
    expect(
      recommendWeightFileForProfile(
        files,
        profile({ totalMemoryBytes: 16 * GIB, freeMemoryBytes: 3 * GIB }),
        4 * GIB
      ).recommendedPath
    ).toBeUndefined()
  })

  it('keeps auxiliary, split, unknown-size, and non-GGUF files selectable but unranked', () => {
    const files = listWeightFiles([
      { path: 'model-mmproj-F16.gguf', size: 2 * GIB },
      { path: 'model-Q4_K_M-00001-of-00002.gguf', size: 3 * GIB },
      { path: 'model-Q5_K_M.gguf' },
      { path: 'model.safetensors', size: 4 * GIB }
    ])
    const result = recommendWeightFileForProfile(files, profile())

    expect(files).toHaveLength(4)
    expect(result).toEqual({ recommendedPath: undefined, estimates: [] })
  })

  it('uses discrete free VRAM but not unified memory as a second memory pool', () => {
    const files = listWeightFiles([{ path: 'model-Q8_0.gguf', size: 12 * GIB }])
    const withoutGpu = recommendWeightFileForProfile(
      files,
      profile({ totalMemoryBytes: 16 * GIB, freeMemoryBytes: 10 * GIB })
    )
    const withDiscreteGpu = recommendWeightFileForProfile(
      files,
      profile({
        totalMemoryBytes: 16 * GIB,
        freeMemoryBytes: 10 * GIB,
        accelerators: [
          {
            vendor: 'nvidia',
            name: 'Test GPU',
            freeMemoryBytes: 10 * GIB,
            unifiedMemory: false
          }
        ]
      })
    )

    expect(withoutGpu.recommendedPath).toBeUndefined()
    expect(withDiscreteGpu.recommendedPath).toBe('model-Q8_0.gguf')
  })
})

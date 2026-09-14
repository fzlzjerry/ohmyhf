import { describe, expect, it } from 'vitest'
import type { MachineProfile } from '@oh-my-huggingface/shared'
import {
  exportToolsForFormat,
  listWeightVariants,
  parseQuantLabel,
  parseWeightShard,
  preferredWeightVariant,
  recommendWeightVariantForProfile
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

describe('listWeightVariants', () => {
  it('keeps GGUF and diffusion weights, skips optimizer shards', () => {
    const files = listWeightVariants([
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

  it('turns the reported GGUF quant sets into three complete, ordered downloads', () => {
    const quants = [
      ['IQ4_XS', 28],
      ['Q4_K_M', 33],
      ['Q5_K_M', 33]
    ] as const
    const siblings = quants.flatMap(([quant, total]) =>
      Array.from({ length: total }, (_, index) => ({
        rfilename: `${quant}/Qwen3.8-Flash-Next-${quant}-${String(index + 1).padStart(5, '0')}-of-${String(total).padStart(5, '0')}.gguf`,
        size: index + 1
      }))
    )
    const variants = listWeightVariants([...siblings].reverse())
    expect(variants.map((variant) => variant.quant)).toEqual(['IQ4_XS', 'Q4_K_M', 'Q5_K_M'])
    for (const [quant, total] of quants) {
      const variant = variants.find((item) => item.quant === quant)!
      expect(variant.files.map((file) => file.path)).toEqual(
        siblings
          .filter((file) => file.rfilename.startsWith(`${quant}/`))
          .map((file) => file.rfilename)
      )
      expect(variant.complete).toBe(true)
      expect(variant.shardCount).toBe(total)
      expect(variant.size).toBe((total * (total + 1)) / 2)
    }
  })

  it('groups base-model tensor shards without including optimizer or other files', () => {
    const shards = Array.from({ length: 131 }, (_, index) => ({
      path: `model-${String(index + 1).padStart(5, '0')}-of-00131.safetensors`,
      size: 10
    }))
    const variants = listWeightVariants([
      ...shards,
      { path: 'model.safetensors.index.json', size: 3 },
      { path: 'optimizer-00001-of-00131.pt', size: 40 },
      { path: 'config.json', size: 2 }
    ])
    expect(variants.map((variant) => variant.files.map((file) => file.path))).toEqual([
      shards.map((file) => file.path)
    ])
    expect(variants[0]).toMatchObject({ complete: true, size: 1310, shardCount: 131 })
  })

  it('keeps same-quant models, directories, formats and split totals separate', () => {
    const stems = ['a/model-Q4_K_M', 'b/model-Q4_K_M', 'a/other-Q4_K_M']
    const paths = stems.flatMap((stem) => [
      `${stem}-00001-of-00002.gguf`,
      `${stem}-00002-of-00002.gguf`
    ])
    const differentSets = [
      'a/model-Q4_K_M-00001-of-00003.gguf',
      'a/model-Q4_K_M-00001-of-00002.safetensors',
      'a/model-Q4_K_M.gguf'
    ]
    const variants = listWeightVariants([...paths, ...differentSets].map((path) => ({ path })))
    expect(variants.map((variant) => variant.files.map((file) => file.path)).sort()).toEqual(
      [
        ...stems.map((stem) => paths.filter((path) => path.startsWith(`${stem}-`))),
        ...differentSets.map((path) => [path])
      ].sort()
    )
    expect(new Set(variants.map((variant) => variant.label)).size).toBe(variants.length)
  })

  it('does not treat duplicate listings or missing sizes as complete known-size weights', () => {
    const first = { path: 'model-Q4_K_M-00001-of-00002.gguf', size: 10 }
    const incomplete = listWeightVariants([first, first])[0]!
    expect(incomplete.files).toEqual([first])
    expect(incomplete.complete).toBe(false)
    expect(incomplete.size).toBeUndefined()

    const unknownSize = listWeightVariants([
      first,
      { path: 'model-Q4_K_M-00002-of-00002.gguf' }
    ])[0]!
    expect(unknownSize.complete).toBe(true)
    expect(unknownSize.size).toBeUndefined()
    expect(
      recommendWeightVariantForProfile([unknownSize], profile()).recommendedPath
    ).toBeUndefined()
  })
})

describe('preferredWeightVariant', () => {
  it('prefers Q4_K_M over larger GGUF files', () => {
    const files = listWeightVariants([
      { path: 'model-Q8_0.gguf', size: 80 },
      { path: 'model-Q4_K_M.gguf', size: 40 }
    ])
    expect(preferredWeightVariant(files)?.path).toBe('model-Q4_K_M.gguf')
  })

  it('falls back to the largest non-GGUF weight', () => {
    const files = listWeightVariants([
      { path: 'small.safetensors', size: 2 },
      { path: 'big.safetensors', size: 20 }
    ])
    expect(preferredWeightVariant(files)?.path).toBe('big.safetensors')
  })

  it('does not default to an incomplete preferred quant over a complete weight', () => {
    const variants = listWeightVariants([
      { path: 'model-Q4_K_M-00001-of-00002.gguf', size: 40 },
      { path: 'model-Q8_0.gguf', size: 80 }
    ])
    expect(preferredWeightVariant(variants)?.path).toBe('model-Q8_0.gguf')
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

describe('recommendWeightVariantForProfile', () => {
  it('chooses the largest comfortable GGUF before a larger tight fit', () => {
    const files = listWeightVariants([
      { path: 'model-Q4_K_M.gguf', size: 8 * GIB },
      { path: 'model-Q8_0.gguf', size: 16 * GIB },
      { path: 'model-Q5_K_M.gguf', size: 6 * GIB }
    ])
    const result = recommendWeightVariantForProfile(files, profile())

    expect(result.recommendedPath).toBe('model-Q4_K_M.gguf')
    expect(result.estimates.find((item) => item.path === 'model-Q4_K_M.gguf')?.level).toBe(
      'comfortable'
    )
    expect(result.estimates.find((item) => item.path === 'model-Q8_0.gguf')?.level).toBe('tight')
  })

  it('falls back to the largest tight fit when none are comfortable', () => {
    const files = listWeightVariants([
      { path: 'model-Q4_K_M.gguf', size: 5 * GIB },
      { path: 'model-Q5_K_M.gguf', size: 6 * GIB }
    ])
    const result = recommendWeightVariantForProfile(
      files,
      profile({ totalMemoryBytes: 16 * GIB, freeMemoryBytes: 9 * GIB })
    )

    expect(result.recommendedPath).toBe('model-Q4_K_M.gguf')
    expect(result.estimates.find((item) => item.path === 'model-Q4_K_M.gguf')?.level).toBe('tight')
  })

  it('does not recommend files that cannot fit memory or disk', () => {
    const files = listWeightVariants([
      { path: 'model-Q4_K_M.gguf', size: 5 * GIB },
      { path: 'model-Q5_K_M.gguf', size: 6 * GIB }
    ])
    expect(
      recommendWeightVariantForProfile(
        files,
        profile({ totalMemoryBytes: 16 * GIB, freeMemoryBytes: 3 * GIB }),
        4 * GIB
      ).recommendedPath
    ).toBeUndefined()
  })

  it('leaves auxiliary, incomplete, unknown-size, and non-GGUF weights unranked', () => {
    const files = listWeightVariants([
      { path: 'model-mmproj-F16.gguf', size: 2 * GIB },
      { path: 'model-Q4_K_M-00001-of-00002.gguf', size: 3 * GIB },
      { path: 'model-Q5_K_M.gguf' },
      { path: 'model.safetensors', size: 4 * GIB }
    ])
    const result = recommendWeightVariantForProfile(files, profile())

    expect(result).toEqual({ recommendedPath: undefined, estimates: [] })
  })

  it('never recommends an importance matrix when the actual quant exceeds available memory', () => {
    const totalSize = 94_525_394_976
    const shardSize = Math.floor(totalSize / 33)
    const shards = Array.from({ length: 33 }, (_, index) => ({
      path: `Qwen3.8-Flash-Next-Q4_K_M-${String(index + 1).padStart(5, '0')}-of-00033.gguf`,
      size: index === 32 ? totalSize - shardSize * 32 : shardSize
    }))
    const variants = listWeightVariants([{ path: 'imatrix.gguf', size: 580_038_688 }, ...shards])
    const result = recommendWeightVariantForProfile(variants, profile())

    expect(variants.find((variant) => variant.path === 'imatrix.gguf')?.files).toEqual([
      { path: 'imatrix.gguf', size: 580_038_688 }
    ])
    expect(result.recommendedPath).toBeUndefined()
    expect(result.estimates.map((estimate) => estimate.path)).toEqual([shards[0]!.path])
    expect(result.recommendedPath ?? preferredWeightVariant(variants)?.path).toBe(shards[0]!.path)
  })

  it('uses the whole split model for memory and disk fit, not its small first shard', () => {
    const variants = listWeightVariants([
      { path: 'large-Q4_K_M-00001-of-00002.gguf', size: GIB },
      { path: 'large-Q4_K_M-00002-of-00002.gguf', size: 31 * GIB },
      { path: 'small-Q5_K_M-00001-of-00002.gguf', size: 2 * GIB },
      { path: 'small-Q5_K_M-00002-of-00002.gguf', size: 3 * GIB }
    ])
    const fit = recommendWeightVariantForProfile(variants, profile())
    expect(fit.recommendedPath).toBe('small-Q5_K_M-00001-of-00002.gguf')
    expect(fit.estimates.find((estimate) => estimate.path.startsWith('large-'))).toMatchObject({
      level: 'unlikely',
      requiredDiskBytes: 32 * GIB
    })
    expect(
      recommendWeightVariantForProfile(variants, profile(), 4 * GIB).recommendedPath
    ).toBeUndefined()
  })

  it('uses discrete free VRAM but not unified memory as a second memory pool', () => {
    const files = listWeightVariants([{ path: 'model-Q8_0.gguf', size: 12 * GIB }])
    const withoutGpu = recommendWeightVariantForProfile(
      files,
      profile({ totalMemoryBytes: 16 * GIB, freeMemoryBytes: 10 * GIB })
    )
    const withDiscreteGpu = recommendWeightVariantForProfile(
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

describe('parseWeightShard', () => {
  it('extracts quant-independent identity for GGUF and base checkpoint file labels', () => {
    expect(parseWeightShard('quant/model-Q4_K_M-00012-of-00033.gguf')).toEqual({
      groupPath: 'quant/model-Q4_K_M.gguf',
      index: 12,
      total: 33
    })
    expect(parseWeightShard('pytorch_model-00131-of-00131.bin')).toEqual({
      groupPath: 'pytorch_model.bin',
      index: 131,
      total: 131
    })
  })

  it('does not interpret invalid indexes, standalone files or index manifests as shards', () => {
    for (const path of [
      'model-00000-of-00002.gguf',
      'model-00003-of-00002.gguf',
      'model-00001-of-00001.gguf',
      'model-00001-of-00002.gguf.index.json',
      'model-Q4_K_M.gguf'
    ]) {
      expect(parseWeightShard(path)).toBeUndefined()
    }
  })
})

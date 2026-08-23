import { describe, expect, it } from 'vitest'
import {
  exportToolsForFormat,
  listWeightFiles,
  parseQuantLabel,
  preferredWeightFile
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

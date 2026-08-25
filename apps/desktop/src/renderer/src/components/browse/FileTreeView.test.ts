import { describe, expect, it, vi } from 'vitest'

// The component import graph touches window.matchMedia at module scope
// (lib/theme.ts); stub just enough of it for this node-environment suite.
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
})
const { clampFileTreeWidth, exportToolsFor, treeFromSnapshot } = await import('./FileTreeView')

describe('clampFileTreeWidth', () => {
  it('keeps the tree between the readable floor and a usable ceiling', () => {
    expect(clampFileTreeWidth(100)).toBe(256)
    expect(clampFileTreeWidth(900)).toBe(560)
    expect(clampFileTreeWidth(336.4)).toBe(336)
  })
})

describe('exportToolsFor', () => {
  it('offers all targets for GGUF files', () => {
    expect(exportToolsFor('model-Q4_K_M.gguf')).toEqual(['ollama', 'lmstudio', 'comfyui'])
    expect(exportToolsFor('MODEL.GGUF')).toEqual(['ollama', 'lmstudio', 'comfyui'])
  })

  it('offers only ComfyUI for diffusion weight formats', () => {
    expect(exportToolsFor('sd_xl_base_1.0.safetensors')).toEqual(['comfyui'])
    expect(exportToolsFor('v1-5-pruned.ckpt')).toEqual(['comfyui'])
    expect(exportToolsFor('control_lora.pt')).toEqual(['comfyui'])
    expect(exportToolsFor('vae.pth')).toEqual(['comfyui'])
    expect(exportToolsFor('pytorch_model.bin')).toEqual(['comfyui'])
  })

  it('offers nothing for non-exportable files', () => {
    expect(exportToolsFor('README.md')).toEqual([])
    expect(exportToolsFor('config.json')).toEqual([])
    expect(exportToolsFor('gguf')).toEqual([])
  })
})

describe('treeFromSnapshot', () => {
  it('collapses nested files into directories at the current path', () => {
    const entries = treeFromSnapshot(
      [
        { path: 'README.md', size: 10 },
        { path: 'weights/model-Q4_K_M.gguf', size: 40 },
        { path: 'weights/model-Q8_0.gguf', size: 80 },
        { path: 'tokenizer.json', size: 2 }
      ],
      ''
    )
    expect(entries.map((entry) => [entry.type, entry.path, entry.size])).toEqual([
      ['directory', 'weights', 0],
      ['file', 'README.md', 10],
      ['file', 'tokenizer.json', 2]
    ])
  })

  it('lists files inside a subdirectory', () => {
    const entries = treeFromSnapshot(
      [
        { path: 'README.md', size: 10 },
        { path: 'weights/model-Q4_K_M.gguf', size: 40 },
        { path: 'weights/nested/extra.bin', size: 1 }
      ],
      'weights'
    )
    expect(entries.map((entry) => [entry.type, entry.path, entry.size])).toEqual([
      ['directory', 'weights/nested', 0],
      ['file', 'weights/model-Q4_K_M.gguf', 40]
    ])
  })
})

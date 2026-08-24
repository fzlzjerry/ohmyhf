import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readGgufRuntimeMetadata } from './gguf'

const roots: string[] = []

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

function string(value: string): Buffer {
  const bytes = Buffer.from(value)
  return Buffer.concat([u64(bytes.length), bytes])
}

function metadata(key: string, value: string | number): Buffer {
  return typeof value === 'string'
    ? Buffer.concat([string(key), u32(8), string(value)])
    : Buffer.concat([string(key), u32(4), u32(value)])
}

function gguf(entries: Array<[string, string | number]>, version = 3): Buffer {
  return Buffer.concat([
    u32(0x46554747),
    u32(version),
    u64(0),
    u64(entries.length),
    ...entries.map(([key, value]) => metadata(key, value))
  ])
}

async function tempFile(content: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ohmyhf-gguf-'))
  roots.push(root)
  const path = join(root, 'model.gguf')
  await writeFile(path, content)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GGUF runtime metadata parser', () => {
  it('reads bounded architecture, chat, context, layer, embedding, KV, and quantization fields', async () => {
    const path = await tempFile(
      gguf([
        ['general.architecture', 'llama'],
        ['general.type', 'model'],
        ['general.file_type', 15],
        ['tokenizer.chat_template', '{{ messages }}'],
        ['llama.context_length', 131072],
        ['llama.block_count', 32],
        ['llama.embedding_length', 4096],
        ['llama.attention.head_count_kv', 8],
        ['ignored.scalar', 123]
      ])
    )

    await expect(readGgufRuntimeMetadata(path)).resolves.toEqual({
      version: 3,
      architecture: 'llama',
      chatTemplate: '{{ messages }}',
      modelType: 'model',
      quantization: 15,
      contextLength: 131072,
      layerCount: 32,
      embeddingLength: 4096,
      kvHeadCount: 8
    })
  })

  it('rejects non-GGUF, unsupported versions, and truncated values', async () => {
    await expect(readGgufRuntimeMetadata(await tempFile(Buffer.from('not gguf')))).rejects.toThrow(
      'gguf.invalidMagic'
    )
    await expect(readGgufRuntimeMetadata(await tempFile(gguf([], 1)))).rejects.toThrow(
      'gguf.unsupportedVersion'
    )
    const truncated = gguf([['general.architecture', 'llama']]).subarray(0, -2)
    await expect(readGgufRuntimeMetadata(await tempFile(truncated))).rejects.toThrow(
      'gguf.truncated'
    )
  })
})

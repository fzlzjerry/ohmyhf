import { open, type FileHandle } from 'node:fs/promises'

const GGUF_MAGIC = 0x46554747
const MAX_STRING_BYTES = 32 * 1024 * 1024
const MAX_METADATA_ITEMS = 2_000_000

export interface GgufRuntimeMetadata {
  version: number
  architecture?: string
  chatTemplate?: string
  modelType?: string
  quantization?: number
  contextLength?: number
  layerCount?: number
  embeddingLength?: number
  kvHeadCount?: number
}

class FileCursor {
  position = 0

  constructor(
    private readonly file: FileHandle,
    private readonly fileSize: number
  ) {}

  private async bytes(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.fileSize) {
      throw new Error('gguf.truncated')
    }
    const buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const result = await this.file.read(buffer, offset, length - offset, this.position + offset)
      if (result.bytesRead === 0) throw new Error('gguf.truncated')
      offset += result.bytesRead
    }
    this.position += length
    return buffer
  }

  skip(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.fileSize) {
      throw new Error('gguf.truncated')
    }
    this.position += length
  }

  async u8(): Promise<number> {
    return (await this.bytes(1)).readUInt8(0)
  }
  async i8(): Promise<number> {
    return (await this.bytes(1)).readInt8(0)
  }
  async u16(): Promise<number> {
    return (await this.bytes(2)).readUInt16LE(0)
  }
  async i16(): Promise<number> {
    return (await this.bytes(2)).readInt16LE(0)
  }
  async u32(): Promise<number> {
    return (await this.bytes(4)).readUInt32LE(0)
  }
  async i32(): Promise<number> {
    return (await this.bytes(4)).readInt32LE(0)
  }
  async f32(): Promise<number> {
    return (await this.bytes(4)).readFloatLE(0)
  }
  async u64(): Promise<bigint> {
    return (await this.bytes(8)).readBigUInt64LE(0)
  }
  async i64(): Promise<bigint> {
    return (await this.bytes(8)).readBigInt64LE(0)
  }
  async f64(): Promise<number> {
    return (await this.bytes(8)).readDoubleLE(0)
  }
  async string(): Promise<string> {
    const length = safeLength(await this.u64(), MAX_STRING_BYTES)
    return (await this.bytes(length)).toString('utf8')
  }
}

function safeLength(value: bigint, maximum: number): number {
  if (value < 0n || value > BigInt(maximum)) throw new Error('gguf.limitExceeded')
  return Number(value)
}

const FIXED_TYPE_BYTES: Partial<Record<number, number>> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8
}

async function readScalar(cursor: FileCursor, type: number): Promise<unknown> {
  switch (type) {
    case 0:
      return cursor.u8()
    case 1:
      return cursor.i8()
    case 2:
      return cursor.u16()
    case 3:
      return cursor.i16()
    case 4:
      return cursor.u32()
    case 5:
      return cursor.i32()
    case 6:
      return cursor.f32()
    case 7:
      return (await cursor.u8()) !== 0
    case 8:
      return cursor.string()
    case 10:
      return cursor.u64()
    case 11:
      return cursor.i64()
    case 12:
      return cursor.f64()
    default:
      throw new Error('gguf.unsupportedMetadataType')
  }
}

async function skipValue(cursor: FileCursor, type: number): Promise<void> {
  if (type === 8) {
    const length = safeLength(await cursor.u64(), MAX_STRING_BYTES)
    cursor.skip(length)
    return
  }
  if (type === 9) {
    const itemType = await cursor.u32()
    const count = safeLength(await cursor.u64(), MAX_METADATA_ITEMS)
    const fixed = FIXED_TYPE_BYTES[itemType]
    if (fixed !== undefined) {
      cursor.skip(count * fixed)
      return
    }
    if (itemType === 9) throw new Error('gguf.nestedArrayUnsupported')
    for (let index = 0; index < count; index++) await skipValue(cursor, itemType)
    return
  }
  const fixed = FIXED_TYPE_BYTES[type]
  if (fixed === undefined) throw new Error('gguf.unsupportedMetadataType')
  cursor.skip(fixed)
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  return undefined
}

/**
 * Read only the bounded GGUF metadata needed for compatibility and fit checks.
 * Tensor payloads are never loaded and metadata arrays are skipped in place.
 */
export async function readGgufRuntimeMetadata(path: string): Promise<GgufRuntimeMetadata> {
  const file = await open(path, 'r')
  try {
    const stats = await file.stat()
    const cursor = new FileCursor(file, stats.size)
    const magic = await cursor.u32()
    if (magic !== GGUF_MAGIC) throw new Error('gguf.invalidMagic')
    const version = await cursor.u32()
    if (version < 2 || version > 3) throw new Error('gguf.unsupportedVersion')
    await cursor.u64() // tensor count; tensor descriptors follow metadata
    const metadataCount = safeLength(await cursor.u64(), MAX_METADATA_ITEMS)
    const values = new Map<string, unknown>()
    for (let index = 0; index < metadataCount; index++) {
      const key = await cursor.string()
      const type = await cursor.u32()
      const wanted =
        key === 'general.architecture' ||
        key === 'general.type' ||
        key === 'general.file_type' ||
        key === 'tokenizer.chat_template' ||
        key.startsWith('tokenizer.chat_template.') ||
        key.endsWith('.context_length') ||
        key.endsWith('.block_count') ||
        key.endsWith('.embedding_length') ||
        key.endsWith('.attention.head_count_kv') ||
        key.endsWith('.attention.head_count')
      if (wanted && type !== 9) values.set(key, await readScalar(cursor, type))
      else await skipValue(cursor, type)
    }

    const architecture = values.get('general.architecture')
    const architecturePrefix = typeof architecture === 'string' ? `${architecture}.` : ''
    const findNumeric = (...suffixes: string[]): number | undefined => {
      for (const suffix of suffixes) {
        const exact = architecturePrefix ? values.get(`${architecturePrefix}${suffix}`) : undefined
        const exactNumber = asNumber(exact)
        if (exactNumber !== undefined) return exactNumber
        for (const [key, value] of values) {
          if (key.endsWith(`.${suffix}`)) {
            const parsed = asNumber(value)
            if (parsed !== undefined) return parsed
          }
        }
      }
      return undefined
    }
    const chatTemplate = [...values.entries()].find(
      ([key, value]) => key.startsWith('tokenizer.chat_template') && typeof value === 'string'
    )?.[1]
    return {
      version,
      architecture: typeof architecture === 'string' ? architecture : undefined,
      chatTemplate: typeof chatTemplate === 'string' ? chatTemplate : undefined,
      modelType:
        typeof values.get('general.type') === 'string'
          ? (values.get('general.type') as string)
          : undefined,
      quantization: asNumber(values.get('general.file_type')),
      contextLength: findNumeric('context_length'),
      layerCount: findNumeric('block_count'),
      embeddingLength: findNumeric('embedding_length'),
      kvHeadCount: findNumeric('attention.head_count_kv', 'attention.head_count')
    }
  } finally {
    await file.close()
  }
}

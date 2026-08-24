import type {
  SecurityAction,
  SecurityDecision,
  SecurityEvidence,
  SecurityReasonCode,
  SecurityReport
} from './types'

const PICKLE_EXTENSIONS = new Set(['.bin', '.ckpt', '.pkl', '.pickle', '.pt', '.pth'])
const EXECUTABLE_EXTENSIONS = new Set([
  '.appimage',
  '.bat',
  '.cmd',
  '.com',
  '.dll',
  '.dylib',
  '.exe',
  '.msi',
  '.ps1',
  '.sh',
  '.so'
])

function extension(path: string): string {
  const basename = path.toLowerCase().split('/').at(-1) ?? path.toLowerCase()
  const dot = basename.lastIndexOf('.')
  return dot >= 0 ? basename.slice(dot) : ''
}

export function localFileRiskReasons(path: string): SecurityReasonCode[] {
  const ext = extension(path)
  if (PICKLE_EXTENSIONS.has(ext)) return ['pickle-format']
  if (EXECUTABLE_EXTENSIONS.has(ext)) return ['executable-file']
  return []
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export function evaluateSecurityPolicy(
  report: Pick<SecurityReport, 'evidence' | 'overall' | 'reasons'>,
  files: string[] | undefined,
  _action: SecurityAction
): { decision: SecurityDecision; reasons: SecurityReasonCode[] } {
  const selected = files ? new Set(files) : null
  const selectedEvidence = report.evidence.filter((item) =>
    selected === null ? true : item.filePath !== undefined && selected.has(item.filePath)
  )
  const selectedMalicious = selectedEvidence.some((item) => item.status === 'malicious')
  const unscopedMalicious = report.evidence.some(
    (item) => item.status === 'malicious' && item.filePath === undefined
  )
  const repositoryHasMalicious = report.evidence.some((item) => item.status === 'malicious')
  const overallMaliciousWithoutFileAttribution =
    report.overall === 'malicious' &&
    !report.evidence.some((item) => item.status === 'malicious' && item.filePath !== undefined)

  if (
    selectedMalicious ||
    unscopedMalicious ||
    overallMaliciousWithoutFileAttribution ||
    (selected === null && repositoryHasMalicious)
  ) {
    return {
      decision: 'block',
      reasons: unique<SecurityReasonCode>([
        selectedMalicious ? 'confirmed-malicious' : 'repository-malicious',
        ...report.reasons
      ])
    }
  }

  const reasons: SecurityReasonCode[] = [...report.reasons]
  if (repositoryHasMalicious) reasons.push('other-file-malicious')
  for (const path of files ?? []) reasons.push(...localFileRiskReasons(path))
  if (selected) {
    for (const path of selected) {
      const fileEvidence = report.evidence.filter((item) => item.filePath === path)
      if (fileEvidence.length === 0 || !fileEvidence.every((item) => item.status === 'safe')) {
        reasons.push('unscanned-file')
      }
    }
  }
  for (const evidence of selectedEvidence) {
    if (evidence.status === 'pending') reasons.push('scan-pending')
    else if (evidence.status === 'error') reasons.push('scan-error')
    else if (evidence.status === 'unknown') reasons.push('scan-unknown')
    else if (evidence.status === 'warning') reasons.push('unscanned-file')
  }
  if ((selected === null && selectedEvidence.length === 0) || report.overall === 'unknown') {
    reasons.push('scan-unknown')
  }

  const normalized = unique(reasons).filter(
    (reason) => reason !== 'confirmed-malicious' && reason !== 'repository-malicious'
  )
  return normalized.length > 0
    ? { decision: 'confirm', reasons: normalized }
    : { decision: 'allow', reasons: [] }
}

function stableEvidence(evidence: SecurityEvidence[]): SecurityEvidence[] {
  return [...evidence]
    .map((item) => ({
      source: item.source,
      status: item.status,
      filePath: item.filePath,
      message: item.message
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

/**
 * Stable non-secret evidence identifier. Grants themselves use random UUIDs;
 * this hash only binds a confirmation to the exact normalized evidence set.
 */
export function securityEvidenceFingerprint(input: {
  repoId: string
  resolvedCommit: string
  evidence: SecurityEvidence[]
}): string {
  const text = JSON.stringify({
    repoId: input.repoId,
    resolvedCommit: input.resolvedCommit.toLowerCase(),
    evidence: stableEvidence(input.evidence)
  })
  // Synchronous SHA-256 keeps this shared module usable in both Electron main
  // and the renderer while avoiding a 32-bit fingerprint in an authorization
  // boundary. It hashes normalized metadata only, never file/model contents.
  const bytes = new TextEncoder().encode(text)
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const high = Math.floor(bitLength / 0x1_0000_0000)
  const low = bitLength >>> 0
  view.setUint32(paddedLength - 8, high)
  view.setUint32(paddedLength - 4, low)

  const words = new Uint32Array(64)
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const constants = SHA256_CONSTANTS
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15]!
      const b = words[index - 2]!
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3)
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10)
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25)
      const choose = (e! & f!) ^ (~e! & g!)
      const t1 = (h! + sigma1 + choose + constants[index]! + words[index]!) >>> 0
      const sigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22)
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (sigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d! + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    state[0] = (state[0]! + a!) >>> 0
    state[1] = (state[1]! + b!) >>> 0
    state[2] = (state[2]! + c!) >>> 0
    state[3] = (state[3]! + d!) >>> 0
    state[4] = (state[4]! + e!) >>> 0
    state[5] = (state[5]! + f!) >>> 0
    state[6] = (state[6]! + g!) >>> 0
    state[7] = (state[7]! + h!) >>> 0
  }
  return `sha256:${[...state].map((word) => word.toString(16).padStart(8, '0')).join('')}`
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift))
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

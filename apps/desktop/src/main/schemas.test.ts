import { describe, expect, it } from 'vitest'
import { ipcRequestSchemas, settingsExportFileSchema } from '@oh-my-huggingface/shared'

/**
 * The IPC request schemas are the input-validation boundary for the main
 * process. These guard the security-relevant refinements: destructive
 * confirmations must match, and slugs/repo ids that are interpolated raw into
 * Hub API paths must not carry traversal segments.
 */
describe('ipcRequestSchemas', () => {
  it('rejects a collection slug with a dot-only owner segment (path traversal)', () => {
    const schema = ipcRequestSchemas['hub:collection']!
    // A well-formed slug parses.
    expect(schema.safeParse({ slug: 'nvidia/cosmos-69ab2f273c55ae147e43c342' }).success).toBe(true)
    // "../victim-<24hex>" would resolve to /api/victim under /api/collections/.
    expect(schema.safeParse({ slug: '../deadbeefdeadbeefdeadbeef' }).success).toBe(false)
    expect(schema.safeParse({ slug: '../secret-69ab2f273c55ae147e43c342' }).success).toBe(false)
  })

  it('requires the delete confirmation to match the target', () => {
    const collection = ipcRequestSchemas['hub:collectionDelete']!
    const slug = 'me/keep-69ab2f273c55ae147e43c342'
    expect(collection.safeParse({ slug, confirmSlug: slug }).success).toBe(true)
    expect(collection.safeParse({ slug, confirmSlug: 'wrong' }).success).toBe(false)

    const repo = ipcRequestSchemas['hub:repoDelete']!
    expect(repo.safeParse({ kind: 'model', repoId: 'me/x', confirmName: 'me/x' }).success).toBe(
      true
    )
    expect(repo.safeParse({ kind: 'model', repoId: 'me/x', confirmName: 'me/y' }).success).toBe(
      false
    )
  })

  it('accepts non-hex notification ids for mark-as-read (post/paper ids are plain strings)', () => {
    const schema = ipcRequestSchemas['hub:notificationsMarkRead']!
    expect(schema.safeParse({ discussionIds: [], read: true }).success).toBe(true)
    expect(
      schema.safeParse({ discussionIds: ['post-abc_123', 'paper.2301'], read: true }).success
    ).toBe(true)
  })

  it('bounds hub:fileRange windows so a renderer cannot request a multi-GB slice', () => {
    const schema = ipcRequestSchemas['hub:fileRange']!
    const base = { kind: 'dataset', repoId: 'me/ds', path: 'data/train.parquet' }
    // A normal footer/row read passes.
    expect(schema.safeParse({ ...base, start: 0, end: 512 * 1024 }).success).toBe(true)
    // A huge window (the OOM vector) is rejected.
    expect(schema.safeParse({ ...base, start: 0, end: 10_000_000_000 }).success).toBe(false)
    // Inverted ranges are rejected.
    expect(schema.safeParse({ ...base, start: 100, end: 50 }).success).toBe(false)
    // Path traversal is rejected by relPath.
    expect(schema.safeParse({ ...base, path: '../secret', start: 0, end: 10 }).success).toBe(false)
  })

  it('accepts privacy:clearLocalData with optional signOut', () => {
    const schema = ipcRequestSchemas['privacy:clearLocalData']!
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ signOut: true }).success).toBe(true)
    expect(schema.safeParse({ signOut: 'yes' }).success).toBe(false)
    expect(schema.safeParse({ favorites: true, history: false, downloads: true }).success).toBe(
      true
    )
  })

  it('accepts personalization settings patches and rejects out-of-range fontScale', () => {
    const schema = ipcRequestSchemas['settings:set']!
    expect(
      schema.safeParse({
        patch: {
          uiDensity: 'compact',
          accent: 'violet',
          fontScale: 110,
          sidebarCollapsed: true,
          browsePageSize: 50,
          repoOpenTarget: 'browser',
          historyLimit: 100,
          telemetryEnabled: true
        }
      }).success
    ).toBe(true)
    expect(schema.safeParse({ patch: { fontScale: 80 } }).success).toBe(false)
    expect(schema.safeParse({ patch: { browsePageSize: 25 } }).success).toBe(false)
    expect(schema.safeParse({ patch: { accent: 'pink' } }).success).toBe(false)
    expect(schema.safeParse({ patch: { telemetryEnabled: 'yes' } }).success).toBe(false)
    expect(schema.safeParse({ patch: { hfCacheDir: '/tmp/renderer-controlled' } }).success).toBe(
      false
    )
  })

  it('accepts only fixed GitHub Star reminder actions', () => {
    const claimId = '12345678-1234-4234-8234-123456789abc'
    const acknowledge = ipcRequestSchemas['starReminder:acknowledgeShown']!
    const schema = ipcRequestSchemas['starReminder:respond']!
    expect(acknowledge.safeParse({ claimId }).success).toBe(true)
    expect(acknowledge.safeParse({ claimId: 'guessable-token' }).success).toBe(false)
    for (const action of ['open', 'later', 'disable']) {
      expect(schema.safeParse({ claimId, action }).success).toBe(true)
    }
    expect(schema.safeParse({ claimId, action: 'starred' }).success).toBe(false)
    expect(schema.safeParse({ claimId, action: 'open', repo: 'attacker/repo' }).success).toBe(false)
    expect(schema.safeParse({ claimId: 'not-a-uuid', action: 'open' }).success).toBe(false)
  })

  it('accepts only UUIDv4 telemetry consent claim tokens', () => {
    const schema = ipcRequestSchemas['telemetry:acknowledgeConsentPrompt']!
    const claimId = '12345678-1234-4234-8234-123456789abc'
    expect(schema.safeParse({ claimId }).success).toBe(true)
    expect(schema.safeParse({ claimId: 'guessable-token' }).success).toBe(false)
    expect(schema.safeParse({ claimId, extra: true }).success).toBe(false)
  })

  it('accepts a version-1 settings export envelope', () => {
    expect(
      settingsExportFileSchema.safeParse({
        version: 1,
        exportedAt: '2026-07-11T00:00:00.000Z',
        settings: { theme: 'dark', fontScale: 110 }
      }).success
    ).toBe(true)
    expect(
      settingsExportFileSchema.safeParse({
        version: 2,
        exportedAt: '2026-07-11T00:00:00.000Z',
        settings: {}
      }).success
    ).toBe(false)
  })

  it('accepts hubEndpoint and proxyUrl http(s) URLs or null', () => {
    const schema = ipcRequestSchemas['settings:set']!
    expect(schema.safeParse({ patch: { hubEndpoint: 'https://hf-mirror.com' } }).success).toBe(true)
    expect(schema.safeParse({ patch: { hubEndpoint: null } }).success).toBe(true)
    expect(schema.safeParse({ patch: { proxyUrl: 'http://127.0.0.1:7890' } }).success).toBe(true)
    expect(schema.safeParse({ patch: { proxyUrl: null } }).success).toBe(true)
    expect(schema.safeParse({ patch: { hubEndpoint: 'ftp://bad.example' } }).success).toBe(false)
    expect(schema.safeParse({ patch: { proxyUrl: 'not-a-url' } }).success).toBe(false)
  })

  it('accepts downloads:start with optional autoExport', () => {
    const schema = ipcRequestSchemas['downloads:start']!
    expect(
      schema.safeParse({
        request: {
          repoId: 'org/model',
          kind: 'model',
          files: ['model-Q4_K_M.gguf'],
          autoExport: { tool: 'ollama', filePath: 'model-Q4_K_M.gguf' }
        }
      }).success
    ).toBe(true)
    expect(
      schema.safeParse({
        request: {
          repoId: 'org/model',
          kind: 'model',
          autoExport: { tool: 'llama', filePath: 'x.gguf' }
        }
      }).success
    ).toBe(false)
  })

  it('bounds hub:commitFiles to small text payloads', () => {
    const schema = ipcRequestSchemas['hub:commitFiles']!
    expect(
      schema.safeParse({
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: '# hi' }],
        title: 'Update README',
        createPr: true
      }).success
    ).toBe(true)
    expect(
      schema.safeParse({
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: 'x'.repeat(256 * 1024 + 1) }],
        title: 'too big'
      }).success
    ).toBe(false)
  })

  it('accepts hub quicksearch query channels and rejects empty/oversized', () => {
    for (const channel of [
      'hub:searchOrgs',
      'hub:searchPapers',
      'hub:searchCollections'
    ] as const) {
      const schema = ipcRequestSchemas[channel]!
      expect(schema.safeParse({ query: 'meta' }).success).toBe(true)
      expect(schema.safeParse({ query: '' }).success).toBe(false)
      expect(schema.safeParse({ query: 'x'.repeat(65) }).success).toBe(false)
    }
  })
})

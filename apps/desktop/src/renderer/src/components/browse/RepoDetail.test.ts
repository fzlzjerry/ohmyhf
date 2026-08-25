import { describe, expect, it, vi } from 'vitest'

// The component import graph touches window.matchMedia at module scope
// (lib/theme.ts); stub just enough of it for this node-environment suite.
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
})
const { chatCompletionCapable, exactRevisionSelection } = await import('./RepoDetail')

describe('chatCompletionCapable', () => {
  it('accepts conversational text-generation and image-text-to-text models', () => {
    expect(
      chatCompletionCapable({ pipelineTag: 'text-generation', tags: ['conversational'] })
    ).toBe(true)
    expect(
      chatCompletionCapable({ pipelineTag: 'image-text-to-text', tags: ['conversational'] })
    ).toBe(true)
  })

  it('rejects completion-only language models without the conversational tag', () => {
    expect(chatCompletionCapable({ pipelineTag: 'text-generation', tags: [] })).toBe(false)
  })

  it('rejects non-chat tasks even when tagged conversational', () => {
    expect(chatCompletionCapable({ pipelineTag: 'sentence-similarity', tags: [] })).toBe(false)
    expect(chatCompletionCapable({ pipelineTag: 'text-to-image', tags: [] })).toBe(false)
    expect(chatCompletionCapable({ pipelineTag: 'fill-mask', tags: ['conversational'] })).toBe(
      false
    )
  })

  it('stays permissive while task metadata is unknown', () => {
    expect(chatCompletionCapable(undefined)).toBe(true)
    expect(chatCompletionCapable({ tags: ['conversational'] })).toBe(true)
  })
})

describe('exactRevisionSelection', () => {
  it('turns a full commit into an immediate read-only selection', () => {
    const commit = '0123456789ABCDEF0123456789ABCDEF01234567'
    expect(exactRevisionSelection(commit)).toEqual({
      requested: commit.toLowerCase(),
      resolvedCommit: commit.toLowerCase(),
      type: 'commit',
      isDefault: false,
      readOnly: true
    })
  })

  it('leaves symbolic and invalid revisions for Hub resolution', () => {
    expect(exactRevisionSelection('main')).toBeUndefined()
    expect(exactRevisionSelection('../main')).toBeUndefined()
    expect(exactRevisionSelection(null)).toBeUndefined()
  })
})

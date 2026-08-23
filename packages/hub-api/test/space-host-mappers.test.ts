import { describe, expect, it } from 'vitest'
import { mapRepoDetail } from '../src'

describe('mapRepoDetail spaceDomain', () => {
  it('prefers host over a stale domains[0] alias', () => {
    const detail = mapRepoDetail(
      {
        id: 'MiniMaxAI/MiniMax-Music3',
        host: 'https://minimaxai-minimax-music3.hf.space',
        subdomain: 'minimaxai-minimax-music3',
        runtime: {
          stage: 'RUNNING',
          domains: [
            { domain: 'diffusers-internal-dev-minimax-music3.hf.space', stage: 'READY' },
            { domain: 'minimaxai-minimax-music3.hf.space', stage: 'READY' }
          ]
        }
      },
      'space'
    )
    expect(detail.spaceDomain).toBe('minimaxai-minimax-music3.hf.space')
  })

  it('uses *.static.hf.space host when domains is empty', () => {
    const detail = mapRepoDetail(
      {
        id: 'lynote/free-ai-humanizer',
        host: 'https://lynote-free-ai-humanizer.static.hf.space',
        subdomain: 'lynote-free-ai-humanizer',
        runtime: { stage: 'RUNNING', domains: [] }
      },
      'space'
    )
    expect(detail.spaceDomain).toBe('lynote-free-ai-humanizer.static.hf.space')
  })

  it('falls back to the domain matching subdomain when host is missing', () => {
    const detail = mapRepoDetail(
      {
        id: 'Saravutw/Omni-videos-custom',
        subdomain: 'saravutw-omni-videos-custom',
        runtime: {
          stage: 'RUNNING',
          domains: [
            { domain: 'saravutw-wan2-2-i2v-v3-lora.hf.space', stage: 'READY' },
            { domain: 'saravutw-omni-videos-custom.hf.space', stage: 'READY' }
          ]
        }
      },
      'space'
    )
    expect(detail.spaceDomain).toBe('saravutw-omni-videos-custom.hf.space')
  })

  it('falls back to subdomain.hf.space when no host or domains exist', () => {
    const detail = mapRepoDetail({ id: 'owner/app', subdomain: 'owner-app' }, 'space')
    expect(detail.spaceDomain).toBe('owner-app.hf.space')
  })

  it('does not map spaceDomain for models', () => {
    const detail = mapRepoDetail(
      {
        id: 'a/b',
        host: 'https://should-not-use.hf.space',
        runtime: { domains: [{ domain: 'also-not.hf.space' }] }
      },
      'model'
    )
    expect(detail.spaceDomain).toBeUndefined()
  })
})

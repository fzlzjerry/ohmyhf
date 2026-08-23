import { describe, expect, it } from 'vitest'
import { hubDeepLink, parseHubResource, routeFromLaunchArgs } from '@oh-my-huggingface/shared'

describe('parseHubResource', () => {
  it('maps official Hub repo URLs', () => {
    expect(parseHubResource('https://huggingface.co/google/gemma-2-9b')).toBe(
      '/models/google/gemma-2-9b'
    )
    expect(parseHubResource('https://huggingface.co/datasets/squad/plain_text')).toBe(
      '/datasets/squad/plain_text'
    )
    expect(parseHubResource('https://huggingface.co/spaces/stabilityai/stable-diffusion')).toBe(
      '/spaces/stabilityai/stable-diffusion'
    )
    expect(parseHubResource('https://hf-mirror.com/google/gemma-2-9b')).toBe(
      '/models/google/gemma-2-9b'
    )
  })

  it('maps papers, collections, posts, and users', () => {
    expect(parseHubResource('https://huggingface.co/papers/2401.12345')).toBe('/papers/2401.12345')
    expect(
      parseHubResource('https://huggingface.co/collections/hf/cool-aaaaaaaaaaaaaaaaaaaaaaaa')
    ).toBe('/collections/hf/cool-aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(parseHubResource('https://huggingface.co/posts/julien/hello')).toBe(
      '/posts/julien/hello'
    )
    expect(parseHubResource('https://huggingface.co/clem')).toBe('/users/clem')
  })

  it('strips blob/tree/discussions suffixes from model URLs', () => {
    expect(parseHubResource('https://huggingface.co/google/gemma-2-9b/blob/main/README.md')).toBe(
      '/models/google/gemma-2-9b'
    )
    expect(parseHubResource('https://huggingface.co/google/gemma-2-9b/discussions/12')).toBe(
      '/models/google/gemma-2-9b'
    )
  })

  it('parses ohmyhf protocol links and launch args', () => {
    expect(parseHubResource('ohmyhf://models/google/gemma-2-9b')).toBe('/models/google/gemma-2-9b')
    expect(
      parseHubResource('ohmyhf://open?url=https://huggingface.co/datasets/squad/plain_text')
    ).toBe('/datasets/squad/plain_text')
    expect(hubDeepLink('/models/a/b')).toBe('ohmyhf://models/a/b')
    expect(routeFromLaunchArgs(['electron', 'ohmyhf://papers/2401.12345', '--some-flag'])).toBe(
      '/papers/2401.12345'
    )
    expect(routeFromLaunchArgs(['electron'])).toBeNull()
    expect(routeFromLaunchArgs(['/usr/bin/oh-my-huggingface'])).toBeNull()
    expect(routeFromLaunchArgs(['electron', 'google/gemma-2-9b'])).toBe('/models/google/gemma-2-9b')
  })

  it('accepts a bare owner/name as a model', () => {
    expect(parseHubResource('google/gemma-2-9b')).toBe('/models/google/gemma-2-9b')
  })

  it('rejects reserved Hub chrome and unknown hosts', () => {
    expect(parseHubResource('https://huggingface.co/login')).toBeNull()
    expect(parseHubResource('https://example.com/google/gemma-2-9b')).toBeNull()
  })
})

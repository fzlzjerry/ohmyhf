import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HUB_ENDPOINT,
  hubBlobUrl,
  hubCollectionUrl,
  hubPaperUrl,
  hubRelativeUrl,
  hubRepoUrl,
  hubResolveUrl,
  hubSettingsUrl,
  hubUserUrl,
  isAllowedExternalUrl,
  normalizeHubEndpoint
} from '@oh-my-huggingface/shared'

describe('Hub URL helpers', () => {
  it('normalizes the default and configured endpoints', () => {
    expect(normalizeHubEndpoint(null)).toBe(DEFAULT_HUB_ENDPOINT)
    expect(normalizeHubEndpoint(' https://hub.example.test/prefix///?ignored=1#hash ')).toBe(
      'https://hub.example.test/prefix'
    )
    expect(normalizeHubEndpoint('http://localhost:8080/')).toBe('http://localhost:8080')
    expect(() => normalizeHubEndpoint('ftp://hub.example.test')).toThrow(/HTTP/)
  })

  it('builds repo, file and account URLs against a path-prefixed endpoint', () => {
    const endpoint = 'https://hub.example.test/hf/'
    expect(hubRepoUrl('model', 'acme/my model', endpoint)).toBe(
      'https://hub.example.test/hf/acme/my%20model'
    )
    expect(hubRepoUrl('dataset', 'acme/data', endpoint)).toBe(
      'https://hub.example.test/hf/datasets/acme/data'
    )
    expect(hubRepoUrl('space', 'acme/demo', endpoint)).toBe(
      'https://hub.example.test/hf/spaces/acme/demo'
    )
    expect(hubBlobUrl('model', 'acme/repo', 'refs/pr/1', 'src/a b.py', endpoint)).toBe(
      'https://hub.example.test/hf/acme/repo/blob/refs%2Fpr%2F1/src/a%20b.py'
    )
    expect(hubResolveUrl('dataset', 'acme/data', 'main', 'a/b.json', endpoint)).toBe(
      'https://hub.example.test/hf/datasets/acme/data/resolve/main/a/b.json'
    )
    expect(hubUserUrl('a b', endpoint)).toBe('https://hub.example.test/hf/a%20b')
    expect(hubPaperUrl('2401.12345', endpoint)).toBe(
      'https://hub.example.test/hf/papers/2401.12345'
    )
    expect(hubCollectionUrl('acme/featured models', endpoint)).toBe(
      'https://hub.example.test/hf/collections/acme/featured%20models'
    )
    expect(hubSettingsUrl('profile', endpoint)).toBe('https://hub.example.test/hf/settings/profile')
  })

  it('resolves Hub-relative values but preserves genuine external URLs', () => {
    const endpoint = 'https://hub.example.test/hf'
    expect(hubRelativeUrl('/avatars/me.png', endpoint)).toBe(
      'https://hub.example.test/hf/avatars/me.png'
    )
    expect(hubRelativeUrl('https://cdn.example.test/image.png', endpoint)).toBe(
      'https://cdn.example.test/image.png'
    )
    expect(hubRelativeUrl('//cdn.example.test/image.png', endpoint)).toBe(
      'https://cdn.example.test/image.png'
    )
  })

  it('allows HTTPS globally but scopes HTTP to the configured Hub path', () => {
    const endpoint = 'http://hub.internal.test/hf'
    expect(isAllowedExternalUrl('https://github.com/fzlzjerry/ohmyhf', endpoint)).toBe(true)
    expect(isAllowedExternalUrl('http://hub.internal.test/hf/models/acme/repo', endpoint)).toBe(
      true
    )
    expect(isAllowedExternalUrl('http://hub.internal.test/other', endpoint)).toBe(false)
    expect(isAllowedExternalUrl('http://attacker.test/hf', endpoint)).toBe(false)
    expect(isAllowedExternalUrl('file:///tmp/secret', endpoint)).toBe(false)
    expect(isAllowedExternalUrl('not a URL', endpoint)).toBe(false)
  })
})

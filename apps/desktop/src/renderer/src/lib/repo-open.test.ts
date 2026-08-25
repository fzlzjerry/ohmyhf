import { describe, expect, it } from 'vitest'
import { repoAppPath } from './repo-open'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

describe('repoAppPath', () => {
  it.each([
    ['model', '/models/org/repo'],
    ['dataset', '/datasets/org/repo'],
    ['space', '/spaces/org/repo']
  ] as const)('opens an exact %s revision in-app', (kind, base) => {
    expect(repoAppPath(kind, 'org/repo', COMMIT)).toBe(`${base}?revision=${COMMIT}`)
  })
})

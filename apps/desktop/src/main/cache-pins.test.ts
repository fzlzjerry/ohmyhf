import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CachePinStore } from './cache-pins'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE cache_pins (
      cache_dir TEXT NOT NULL,
      kind TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (cache_dir, kind, repo_id, commit_hash)
    )
  `)
  return db
}

describe('CachePinStore', () => {
  it('scopes pins to the active cache root while retaining records for other roots', () => {
    const db = database()
    let root = '/cache/a'
    const store = new CachePinStore(db as never, { cacheDir: () => root })

    store.pin('model', 'org/model', COMMIT_A, 'release')
    root = '/cache/b'
    expect(store.list()).toEqual([])
    store.pin('model', 'org/model', COMMIT_B)
    expect(store.commits('model', 'org/model')).toEqual(new Set([COMMIT_B]))
    root = '/cache/a'
    expect(store.list()).toEqual([
      expect.objectContaining({
        cacheDir: '/cache/a',
        kind: 'model',
        repoId: 'org/model',
        commit: COMMIT_A,
        label: 'release'
      })
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM cache_pins').get()).toEqual({ count: 2 })
    db.close()
  })

  it('upserts labels, normalizes commits, filters and unpins exact identities', () => {
    const db = database()
    const store = new CachePinStore(db as never, { cacheDir: () => '/cache' })
    store.pin('model', 'org/model', COMMIT_A.toUpperCase(), 'first')
    store.pin('model', 'org/model', COMMIT_A, 'second')
    store.pin('dataset', 'org/data', COMMIT_B)

    expect(store.list({ kind: 'model', repoId: 'org/model' })).toEqual([
      expect.objectContaining({ commit: COMMIT_A, label: 'second' })
    ])
    expect(store.unpin('model', 'org/model', COMMIT_A)).toEqual([])
    expect(store.list()).toEqual([
      expect.objectContaining({ kind: 'dataset', repoId: 'org/data', commit: COMMIT_B })
    ])
    db.close()
  })

  it('rejects malformed repository ids and mutable revisions before database writes', () => {
    const db = database()
    const store = new CachePinStore(db as never, { cacheDir: () => '/cache' })
    expect(() => store.pin('model', '../outside', COMMIT_A)).toThrow('Invalid repository id')
    expect(() => store.pin('model', 'org/model', 'main')).toThrow('Invalid commit hash')
    expect(db.prepare('SELECT COUNT(*) AS count FROM cache_pins').get()).toEqual({ count: 0 })
    db.close()
  })
})

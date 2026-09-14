import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))

import { DATABASE_MIGRATIONS } from './db'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Schema shipped by v0.0.12 after its two original migrations. */
function createV0012Fixture(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE favorites (
      repo_id TEXT NOT NULL, kind TEXT NOT NULL, added_at TEXT NOT NULL,
      summary_json TEXT NOT NULL, PRIMARY KEY (repo_id, kind)
    );
    CREATE TABLE history (
      repo_id TEXT NOT NULL, kind TEXT NOT NULL, viewed_at TEXT NOT NULL,
      summary_json TEXT NOT NULL, PRIMARY KEY (repo_id, kind)
    );
    CREATE TABLE downloads (
      id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, kind TEXT NOT NULL,
      revision TEXT NOT NULL, status TEXT NOT NULL,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      received_bytes INTEGER NOT NULL DEFAULT 0, files_json TEXT NOT NULL,
      error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
      resolved_commit TEXT, endpoint TEXT, proxy_url TEXT, cache_dir TEXT,
      environment_version INTEGER, error_code TEXT
    );
    CREATE TABLE follows (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, target TEXT NOT NULL,
      created_at TEXT NOT NULL, last_checked_at TEXT, state_json TEXT,
      UNIQUE (type, target)
    );
    CREATE TABLE inbox (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, route TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE TABLE auth (
      id INTEGER PRIMARY KEY CHECK (id = 1), token_cipher BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_inbox_created ON inbox (created_at DESC);
    PRAGMA user_version = 2;
  `)
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('settings', '{"theme":"dark"}')
  db.prepare(
    'INSERT INTO favorites (repo_id, kind, added_at, summary_json) VALUES (?, ?, ?, ?)'
  ).run('org/model', 'model', '2026-01-01', '{"id":"org/model"}')
  db.prepare(
    'INSERT INTO history (repo_id, kind, viewed_at, summary_json) VALUES (?, ?, ?, ?)'
  ).run('org/model', 'model', '2026-01-02', '{"id":"org/model"}')
  db.prepare(
    `INSERT INTO downloads
      (id, repo_id, kind, revision, status, files_json, created_at, resolved_commit,
       endpoint, cache_dir, environment_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'download-1',
    'org/model',
    'model',
    'v1',
    'completed',
    '[]',
    '2026-01-03',
    'a'.repeat(40),
    'https://huggingface.co',
    '/cache',
    1
  )
  db.prepare(
    'INSERT INTO follows (id, type, target, created_at, state_json) VALUES (?, ?, ?, ?, ?)'
  ).run('follow-1', 'author', 'alice', '2026-01-04', '{}')
  db.prepare(
    'INSERT INTO inbox (id, kind, title, body, route, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('notice-1', 'update', 'Title', 'Body', '/', '2026-01-05')
  db.close()
}

describe('v0.0.12 database migration', () => {
  it('adds exact-revision, pin, local model and preset state without rewriting user data', () => {
    const root = mkdtempSync(join(tmpdir(), 'ohmyhf-db-migration-'))
    roots.push(root)
    const path = join(root, 'fixture.db')
    createV0012Fixture(path)

    const db = new DatabaseSync(path)
    for (let version = 2; version < DATABASE_MIGRATIONS.length; version += 1) {
      db.exec('BEGIN')
      try {
        db.exec(DATABASE_MIGRATIONS[version]!)
        db.exec(`PRAGMA user_version = ${version + 1}`)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }

    expect(db.prepare('PRAGMA user_version').get()).toEqual({
      user_version: DATABASE_MIGRATIONS.length
    })
    expect(db.prepare('SELECT key, value FROM kv').all()).toEqual([
      { key: 'settings', value: '{"theme":"dark"}' }
    ])
    expect(db.prepare('SELECT repo_id, kind, summary_json FROM favorites').get()).toEqual({
      repo_id: 'org/model',
      kind: 'model',
      summary_json: '{"id":"org/model"}'
    })
    expect(db.prepare('SELECT repo_id, revision, resolved_commit FROM history').get()).toEqual({
      repo_id: 'org/model',
      revision: null,
      resolved_commit: null
    })
    expect(
      db
        .prepare(
          'SELECT id, status, resolved_commit, post_action_json, security_ack_json, security_authorization_json FROM downloads'
        )
        .get()
    ).toEqual({
      id: 'download-1',
      status: 'completed',
      resolved_commit: 'a'.repeat(40),
      post_action_json: null,
      security_ack_json: null,
      security_authorization_json: null
    })
    expect(db.prepare('SELECT id, target FROM follows').get()).toEqual({
      id: 'follow-1',
      target: 'alice'
    })
    expect(db.prepare('SELECT id, title FROM inbox').get()).toEqual({
      id: 'notice-1',
      title: 'Title'
    })

    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((row) => row.name)
    )
    for (const table of ['cache_pins', 'local_models', 'local_run_presets']) {
      expect(tables.has(table)).toBe(true)
    }

    db.close()
  })
})

it('preserves old imports and round-trips exact download approvals through the new migration', () => {
  const db = new DatabaseSync(':memory:')
  try {
    for (const migration of DATABASE_MIGRATIONS.slice(0, -1)) db.exec(migration)
    const insertModel = db.prepare(
      'INSERT INTO local_models (runtime, model_name, repo_id, revision, resolved_commit, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    insertModel.run(
      'ollama',
      'legacy-name',
      'org/model',
      'v1',
      'a'.repeat(40),
      'model.gguf',
      '2026-08-24'
    )
    db.exec(DATABASE_MIGRATIONS.at(-1)!)
    insertModel.run(
      'ollama',
      'full-identity-name',
      'org/model',
      'v1',
      'a'.repeat(40),
      'model.gguf',
      '2026-08-25'
    )
    expect(db.prepare('SELECT model_name FROM local_models ORDER BY created_at').all()).toEqual([
      { model_name: 'legacy-name' },
      { model_name: 'full-identity-name' }
    ])
    const approval = {
      request: {
        action: 'lock-restore',
        kind: 'model',
        repoId: 'org/model',
        revision: 'v1',
        resolvedCommit: 'a'.repeat(40),
        files: ['model.gguf', 'config.json']
      },
      acknowledgement: {
        fingerprint: `sha256:${'b'.repeat(64)}`,
        binding: `sha256:${'c'.repeat(64)}`,
        acceptedAt: '2026-08-24T00:00:00.000Z'
      }
    }
    db.prepare(
      'INSERT INTO downloads (id, repo_id, kind, revision, status, files_json, created_at, endpoint, resolved_commit, security_authorization_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'download',
      'org/model',
      'model',
      'v1',
      'paused',
      '[]',
      '2026-08-24',
      'https://frozen.example',
      'a'.repeat(40),
      JSON.stringify(approval)
    )
    const row = db
      .prepare('SELECT endpoint, resolved_commit, security_authorization_json FROM downloads')
      .get()!
    expect(row.endpoint).toBe('https://frozen.example')
    expect(row.resolved_commit).toBe('a'.repeat(40))
    expect(JSON.parse(row.security_authorization_json as string)).toEqual(approval)
  } finally {
    db.close()
  }
})

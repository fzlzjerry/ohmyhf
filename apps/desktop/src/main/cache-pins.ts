import { resolve } from 'node:path'
import type { CachePin, RepoKind } from '@oh-my-huggingface/shared'
import { FULL_COMMIT_RE, isValidRepoId } from '@oh-my-huggingface/shared'
import type { AppDatabase } from './db'
import type { CacheManager } from './cache'

interface CachePinRow {
  cache_dir: string
  kind: string
  repo_id: string
  commit_hash: string
  label: string | null
  created_at: string
}

export class CachePinStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly cache: Pick<CacheManager, 'cacheDir'>
  ) {}

  private currentRoot(): string {
    return resolve(this.cache.cacheDir())
  }

  list(filter: { kind?: RepoKind; repoId?: string } = {}): CachePin[] {
    const clauses = ['cache_dir = ?']
    const params: unknown[] = [this.currentRoot()]
    if (filter.kind) {
      clauses.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter.repoId) {
      clauses.push('repo_id = ?')
      params.push(filter.repoId)
    }
    const rows = this.db
      .prepare(
        `SELECT cache_dir, kind, repo_id, commit_hash, label, created_at
           FROM cache_pins
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at DESC`
      )
      .all(...params) as CachePinRow[]
    return rows.map((row) => ({
      cacheDir: row.cache_dir,
      kind: row.kind as RepoKind,
      repoId: row.repo_id,
      commit: row.commit_hash,
      label: row.label ?? undefined,
      createdAt: row.created_at
    }))
  }

  pin(kind: RepoKind, repoId: string, commit: string, label?: string): CachePin[] {
    this.validate(repoId, commit)
    this.db
      .prepare(
        `INSERT INTO cache_pins
           (cache_dir, kind, repo_id, commit_hash, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_dir, kind, repo_id, commit_hash) DO UPDATE SET
           label = excluded.label`
      )
      .run(
        this.currentRoot(),
        kind,
        repoId,
        commit.toLowerCase(),
        label?.trim() || null,
        new Date().toISOString()
      )
    return this.list({ kind, repoId })
  }

  unpin(kind: RepoKind, repoId: string, commit: string): CachePin[] {
    this.validate(repoId, commit)
    this.db
      .prepare(
        `DELETE FROM cache_pins
          WHERE cache_dir = ? AND kind = ? AND repo_id = ? AND commit_hash = ?`
      )
      .run(this.currentRoot(), kind, repoId, commit.toLowerCase())
    return this.list({ kind, repoId })
  }

  commits(kind: RepoKind, repoId: string): ReadonlySet<string> {
    return new Set(this.list({ kind, repoId }).map((pin) => pin.commit))
  }

  private validate(repoId: string, commit: string): void {
    if (!isValidRepoId(repoId)) throw new Error('Invalid repository id')
    if (!FULL_COMMIT_RE.test(commit)) throw new Error('Invalid commit hash')
  }
}

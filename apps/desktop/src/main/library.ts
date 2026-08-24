/** Local library: favorites, browse history, and the follow/inbox tables. */
import { randomUUID } from 'node:crypto'
import type {
  FavoriteItem,
  Follow,
  FollowTargetType,
  HistoryItem,
  HistoryLimit,
  InboxItem,
  RepoKind,
  RepoSummary
} from '@oh-my-huggingface/shared'
import type { AppDatabase } from './db'

const DEFAULT_HISTORY_LIMIT: HistoryLimit = 200

export class Library {
  constructor(
    private readonly db: AppDatabase,
    private readonly getHistoryLimit: () => number = () => DEFAULT_HISTORY_LIMIT
  ) {}

  listFavorites(): FavoriteItem[] {
    const rows = this.db.prepare('SELECT * FROM favorites ORDER BY added_at DESC').all() as Array<{
      repo_id: string
      kind: string
      added_at: string
      summary_json: string
    }>
    return rows.map((r) => ({
      repoId: r.repo_id,
      kind: r.kind as RepoKind,
      addedAt: r.added_at,
      summary: JSON.parse(r.summary_json) as RepoSummary
    }))
  }

  addFavorite(summary: RepoSummary): FavoriteItem[] {
    this.db
      .prepare(
        `INSERT INTO favorites (repo_id, kind, added_at, summary_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id, kind) DO UPDATE SET summary_json = excluded.summary_json`
      )
      .run(summary.id, summary.kind, new Date().toISOString(), JSON.stringify(summary))
    return this.listFavorites()
  }

  removeFavorite(kind: RepoKind, repoId: string): FavoriteItem[] {
    this.db.prepare('DELETE FROM favorites WHERE repo_id = ? AND kind = ?').run(repoId, kind)
    return this.listFavorites()
  }

  listHistory(): HistoryItem[] {
    const limit = this.getHistoryLimit()
    const rows = this.db
      .prepare('SELECT * FROM history ORDER BY viewed_at DESC LIMIT ?')
      .all(limit) as Array<{
      repo_id: string
      kind: string
      viewed_at: string
      summary_json: string
      revision: string | null
      resolved_commit: string | null
    }>
    return rows.map((r) => ({
      repoId: r.repo_id,
      kind: r.kind as RepoKind,
      viewedAt: r.viewed_at,
      summary: JSON.parse(r.summary_json) as RepoSummary,
      revision: r.revision ?? undefined,
      resolvedCommit: r.resolved_commit ?? undefined
    }))
  }

  recordHistory(summary: RepoSummary, revision?: string, resolvedCommit?: string): void {
    this.db
      .prepare(
        `INSERT INTO history
           (repo_id, kind, viewed_at, summary_json, revision, resolved_commit)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, kind) DO UPDATE SET
           viewed_at = excluded.viewed_at,
           summary_json = excluded.summary_json,
           revision = excluded.revision,
           resolved_commit = excluded.resolved_commit`
      )
      .run(
        summary.id,
        summary.kind,
        new Date().toISOString(),
        JSON.stringify(summary),
        revision ?? null,
        resolvedCommit ?? null
      )
    this.pruneHistory(this.getHistoryLimit())
  }

  private pruneHistory(limit: number): void {
    this.db
      .prepare(
        `DELETE FROM history WHERE rowid NOT IN (
           SELECT rowid FROM history ORDER BY viewed_at DESC LIMIT ?
         )`
      )
      .run(limit)
  }

  clearHistory(): void {
    this.db.prepare('DELETE FROM history').run()
  }

  listFollows(): Follow[] {
    const rows = this.db.prepare('SELECT * FROM follows ORDER BY created_at').all() as Array<{
      id: string
      type: string
      target: string
      created_at: string
      last_checked_at: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      type: r.type as FollowTargetType,
      target: r.target,
      createdAt: r.created_at,
      lastCheckedAt: r.last_checked_at ?? undefined
    }))
  }

  addFollow(type: FollowTargetType, target: string): Follow[] {
    this.db
      .prepare(
        `INSERT INTO follows (id, type, target, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(type, target) DO NOTHING`
      )
      .run(randomUUID(), type, target, new Date().toISOString())
    return this.listFollows()
  }

  removeFollow(id: string): Follow[] {
    this.db.prepare('DELETE FROM follows WHERE id = ?').run(id)
    return this.listFollows()
  }

  getFollowState(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT state_json FROM follows WHERE id = ?').get(id) as
      { state_json: string | null } | undefined
    if (!row?.state_json) return {}
    try {
      return JSON.parse(row.state_json) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  setFollowState(id: string, state: Record<string, unknown>, checkedAt: string): void {
    this.db
      .prepare('UPDATE follows SET state_json = ?, last_checked_at = ? WHERE id = ?')
      .run(JSON.stringify(state), checkedAt, id)
  }

  listInbox(): InboxItem[] {
    const rows = this.db
      .prepare('SELECT * FROM inbox ORDER BY created_at DESC LIMIT 500')
      .all() as Array<{
      id: string
      kind: string
      title: string
      body: string
      route: string
      created_at: string
      read_at: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as InboxItem['kind'],
      title: r.title,
      body: r.body,
      route: r.route,
      createdAt: r.created_at,
      readAt: r.read_at ?? undefined
    }))
  }

  addInboxItem(item: Omit<InboxItem, 'id' | 'createdAt'> & { dedupeKey: string }): boolean {
    const id = `inbox:${item.dedupeKey}`
    const result = this.db
      .prepare(
        `INSERT INTO inbox (id, kind, title, body, route, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(id, item.kind, item.title, item.body, item.route, new Date().toISOString())
    return result.changes > 0
  }

  markInboxRead(ids: string[]): InboxItem[] {
    const stmt = this.db.prepare('UPDATE inbox SET read_at = ? WHERE id = ?')
    const now = new Date().toISOString()
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) stmt.run(now, id)
    })
    tx(ids)
    return this.listInbox()
  }

  clearInbox(): InboxItem[] {
    this.db.prepare('DELETE FROM inbox').run()
    return this.listInbox()
  }
}

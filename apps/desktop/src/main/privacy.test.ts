import { describe, expect, it } from 'vitest'
import type { AppDatabase } from './db'
import { clearLocalAppData } from './privacy'

/**
 * better-sqlite3 is built for Electron's Node ABI; vitest runs on system Node.
 * This stub records DELETE statements so we can assert clear semantics without
 * loading the native module.
 */
function createRecordingDb(): {
  db: AppDatabase
  statements: string[]
  authDeleted: () => boolean
} {
  const statements: string[] = []
  let authDeleted = false
  const db = {
    prepare(sql: string) {
      return {
        run: () => {
          statements.push(sql)
          if (sql.includes('DELETE FROM auth')) authDeleted = true
        },
        get: () => undefined
      }
    },
    transaction(fn: () => void) {
      return () => fn()
    }
  } as unknown as AppDatabase
  return { db, statements, authDeleted: () => authDeleted }
}

describe('clearLocalAppData', () => {
  it('clears library tables and non-settings kv but keeps auth when signOut is false', () => {
    const { db, statements, authDeleted } = createRecordingDb()
    const result = clearLocalAppData(db, { signOut: false })
    expect(result).toEqual({ signedOut: false })
    expect(statements).toEqual([
      'DELETE FROM favorites',
      'DELETE FROM history',
      'DELETE FROM downloads',
      'DELETE FROM follows',
      'DELETE FROM inbox',
      `DELETE FROM kv WHERE key != 'settings'`,
      'DELETE FROM cache_pins',
      'DELETE FROM local_models',
      'DELETE FROM local_run_presets'
    ])
    expect(authDeleted()).toBe(false)
  })

  it('also deletes auth when signOut is true', () => {
    const { db, statements, authDeleted } = createRecordingDb()
    const result = clearLocalAppData(db, { signOut: true })
    expect(result).toEqual({ signedOut: true })
    expect(statements).toContain('DELETE FROM auth WHERE id = 1')
    expect(authDeleted()).toBe(true)
  })

  it('clears only selected categories when flags are provided', () => {
    const { db, statements, authDeleted } = createRecordingDb()
    const result = clearLocalAppData(db, {
      favorites: true,
      history: false,
      downloads: false,
      follows: false,
      inbox: false,
      otherKv: false,
      signOut: false
    })
    expect(result).toEqual({ signedOut: false })
    expect(statements).toEqual(['DELETE FROM favorites'])
    expect(authDeleted()).toBe(false)
  })
})

/**
 * Clears selected app-local SQLite data. Does not touch the HF cache directory on disk.
 * When no category flags are provided, clears all library tables (legacy behavior).
 * When any category flag is set, only categories with `true` are cleared.
 */
import type { AppDatabase } from './db'

export interface ClearLocalDataOptions {
  favorites?: boolean
  history?: boolean
  downloads?: boolean
  follows?: boolean
  inbox?: boolean
  otherKv?: boolean
  signOut?: boolean
}

const CATEGORIES = ['favorites', 'history', 'downloads', 'follows', 'inbox', 'otherKv'] as const

export function clearLocalAppData(
  db: AppDatabase,
  options: ClearLocalDataOptions
): { signedOut: boolean } {
  const signOut = options.signOut === true
  const selective = CATEGORIES.some((key) => options[key] !== undefined)
  const should = (key: (typeof CATEGORIES)[number]): boolean =>
    selective ? options[key] === true : true

  const tx = db.transaction(() => {
    if (should('favorites')) db.prepare('DELETE FROM favorites').run()
    if (should('history')) db.prepare('DELETE FROM history').run()
    if (should('downloads')) db.prepare('DELETE FROM downloads').run()
    if (should('follows')) db.prepare('DELETE FROM follows').run()
    if (should('inbox')) db.prepare('DELETE FROM inbox').run()
    if (should('otherKv')) {
      db.prepare(`DELETE FROM kv WHERE key != 'settings'`).run()
      db.prepare('DELETE FROM cache_pins').run()
      db.prepare('DELETE FROM local_models').run()
      db.prepare('DELETE FROM local_run_presets').run()
    }
    if (signOut) {
      db.prepare('DELETE FROM auth WHERE id = 1').run()
    }
  })
  tx()
  return { signedOut: signOut }
}

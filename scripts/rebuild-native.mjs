#!/usr/bin/env node
/**
 * Ensure Electron's downloaded runtime exists, then rebuild native modules
 * (better-sqlite3) against that version. Runs during postinstall and before
 * desktop development so a pruned/incomplete Electron package self-repairs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const has = (p) => existsSync(join(root, 'node_modules', p))
const electronRoot = join(root, 'node_modules', 'electron')

if (!has('electron/package.json')) {
  console.log('[rebuild-native] electron not installed yet; skipping')
  process.exit(0)
}

function hasElectronRuntime() {
  try {
    const runtimePath = readFileSync(join(electronRoot, 'path.txt'), 'utf8').trim()
    return runtimePath.length > 0 && existsSync(join(electronRoot, 'dist', runtimePath))
  } catch {
    return false
  }
}

if (!hasElectronRuntime()) {
  console.log('[rebuild-native] Electron runtime missing; restoring it')
  const install = spawnSync(process.execPath, [join(electronRoot, 'install.js')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (install.status !== 0 || !hasElectronRuntime()) {
    console.error('[rebuild-native] Electron runtime installation failed')
    process.exit(install.status ?? 1)
  }
}

if (process.argv.includes('--electron-only')) {
  process.exit(0)
}

if (!has('better-sqlite3/package.json')) {
  console.log('[rebuild-native] better-sqlite3 not installed yet; skipping native rebuild')
  process.exit(0)
}

// Run through a shell: Node 22+ refuses to spawn a `.cmd`/`.bat` directly on
// Windows (CVE-2024-27980), so invoking `npx.cmd` without a shell fails
// instantly with no output. `shell: true` + bare `npx` works on every OS; the
// fixed args have no whitespace/metacharacters, so shell quoting is safe.
const result = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3'], {
  cwd: root,
  stdio: 'inherit',
  shell: true
})
process.exit(result.status ?? 1)

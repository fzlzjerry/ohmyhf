#!/usr/bin/env node
/**
 * Ensure Electron's downloaded runtime exists, then rebuild native modules
 * (better-sqlite3) against that version. Runs during postinstall and before
 * desktop development so a pruned/incomplete Electron package self-repairs.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const has = (p) => existsSync(join(root, 'node_modules', p))

function uniquePackageDirs(paths) {
  const seen = new Set()
  const dirs = []
  for (const p of paths) {
    if (!p || !existsSync(join(p, 'package.json'))) continue
    let key = p
    try {
      key = realpathSync(p)
    } catch {
      // keep the unresolved path if realpath fails
    }
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(key)
  }
  return dirs
}

function resolveElectronRoots() {
  const candidates = [join(root, 'node_modules', 'electron')]
  try {
    const requireFromCwd = createRequire(join(process.cwd(), 'package.json'))
    candidates.push(dirname(requireFromCwd.resolve('electron')))
  } catch {
    // electron is not resolvable from cwd (e.g. postinstall at the repo root
    // before the desktop workspace is linked)
  }
  return uniquePackageDirs(candidates)
}

function hasElectronRuntime(electronRoot) {
  try {
    const runtimePath = readFileSync(join(electronRoot, 'path.txt'), 'utf8').trim()
    return runtimePath.length > 0 && existsSync(join(electronRoot, 'dist', runtimePath))
  } catch {
    return false
  }
}

function restoreElectronRuntime(electronRoot) {
  console.log(`[rebuild-native] Electron runtime missing; restoring it (${electronRoot})`)
  const install = spawnSync(process.execPath, [join(electronRoot, 'install.js')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (install.status !== 0 || !hasElectronRuntime(electronRoot)) {
    console.error('[rebuild-native] Electron runtime installation failed')
    process.exit(install.status ?? 1)
  }
}

const electronRoots = resolveElectronRoots()
if (electronRoots.length === 0) {
  console.log('[rebuild-native] electron not installed yet; skipping')
  process.exit(0)
}

for (const electronRoot of electronRoots) {
  if (!hasElectronRuntime(electronRoot)) restoreElectronRuntime(electronRoot)
}

if (process.argv.includes('--electron-only')) {
  process.exit(0)
}

if (!has('better-sqlite3/package.json')) {
  console.log('[rebuild-native] better-sqlite3 not installed yet; skipping native rebuild')
  process.exit(0)
}

const rebuildCli = join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js')
if (!existsSync(rebuildCli)) {
  console.error('[rebuild-native] @electron/rebuild CLI not found')
  process.exit(1)
}

// Invoke the CLI with Node instead of the `.bin` shim. pnpm links
// `electron-rebuild` at the published `lib/cli.js`, which is not executable, so
// `npx electron-rebuild` fails with EACCES/126. Spawning `process.execPath`
// also avoids Node 22+ refusing `.cmd` on Windows (CVE-2024-27980) without a shell.
const result = spawnSync(process.execPath, [rebuildCli, '-f', '-w', 'better-sqlite3'], {
  cwd: root,
  stdio: 'inherit'
})
process.exit(result.status ?? 1)

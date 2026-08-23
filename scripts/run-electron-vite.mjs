#!/usr/bin/env node
/**
 * Launch electron-vite with ELECTRON_RUN_AS_NODE cleared. Cursor and VS Code
 * set that flag so editor child processes do not become extra Electron
 * windows; if it leaks into this spawn, Electron runs as Node and
 * `import { app } from 'electron'` fails.
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const requireFrom = (dir) => createRequire(join(dir, 'package.json'))

function resolveElectronViteCli() {
  for (const dir of [process.cwd(), root]) {
    try {
      return join(
        dirname(requireFrom(dir).resolve('electron-vite/package.json')),
        'bin',
        'electron-vite.js'
      )
    } catch {
      // try the next directory
    }
  }
  return join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
}

const cli = resolveElectronViteCli()
if (!existsSync(cli)) {
  console.error('[run-electron-vite] electron-vite CLI not found')
  process.exit(1)
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})
child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})

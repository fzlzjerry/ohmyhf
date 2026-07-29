import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const RELEASE_DIR = resolve(__dirname, '../release')

function walk(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function packagedExecutable(): string {
  const override = process.env.OMH_PACKAGED_EXECUTABLE
  if (override) return override

  const files = walk(RELEASE_DIR)
  const match = files.find((path) => {
    const name = basename(path)
    if (process.platform === 'darwin') {
      return path.includes('.app/Contents/MacOS/') && name === 'Oh My HuggingFace'
    }
    if (process.platform === 'win32') {
      return path.includes('win-unpacked') && name === 'Oh My HuggingFace.exe'
    }
    return path.includes('linux-unpacked') && name === 'oh-my-huggingface'
  })

  if (!match) throw new Error(`No packaged executable found under ${RELEASE_DIR}`)
  return match
}

test('packaged application boots with an isolated profile', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'omh-packaged-smoke-'))
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    // Ad-hoc local builds do not share the release certificate's Keychain ACL.
    // Keep the isolated smoke profile from blocking on a Safe Storage password dialog.
    args: process.platform === 'darwin' ? ['--use-mock-keychain'] : [],
    env: {
      ...process.env,
      OMH_USER_DATA_DIR: userDataDir,
      OMH_CREDENTIALS_DIR: userDataDir
    }
  })

  try {
    const window = await app.firstWindow()
    await expect(window).toHaveTitle('Oh My HuggingFace')
    await expect(window.locator('aside nav')).toBeVisible({ timeout: 30_000 })
    await expect(window.locator('main')).toBeVisible()
  } finally {
    await app.close()
  }
})

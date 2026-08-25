import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, test } from '@playwright/test'

const RELEASE_DIR = resolve(__dirname, '../release')
const EXPECT_PUBLISHABLE = process.env.OMH_EXPECT_PUBLISHABLE === 'true'
const CONSENT_CLAIM_ID = '12345678-1234-4234-8234-123456789abc'
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

function databasePath(userDataDir: string): string {
  return join(userDataDir, 'oh-my-huggingface.db')
}

function openFixtureDatabase(userDataDir: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(databasePath(userDataDir), { readOnly })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

function writeKv(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value))
}

function readKv(db: DatabaseSync, key: string): unknown {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    { value: string } | undefined
  return row ? JSON.parse(row.value) : undefined
}

function resolvedDeclineState(): Record<string, unknown> {
  return {
    version: 2,
    claimId: CONSENT_CLAIM_ID,
    status: 'resolved',
    resolution: 'declined'
  }
}

function starState(sessionCount: number): Record<string, unknown> {
  return {
    version: 1,
    sessionCount,
    promptCount: 0,
    snoozedUntil: null,
    terminal: null,
    lastReservedSession: null,
    lastPromptedAt: null,
    activeClaimId: null,
    activeClaimReservedAt: null,
    activePromptNumber: null
  }
}

async function launchPackaged(userDataDir: string) {
  return electron.launch({
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
}

async function waitForMainWindow(app: Awaited<ReturnType<typeof launchPackaged>>) {
  const window = await app.firstWindow()
  await expect(window).toHaveTitle('Oh My HuggingFace')
  await expect(window.locator('aside nav')).toBeVisible({ timeout: 30_000 })
  await expect(window.locator('main')).toBeVisible()
  await window.bringToFront()
  await window.evaluate(() => window.focus())
  await expect
    .poll(
      () =>
        window.evaluate(() => ({
          visibility: document.visibilityState,
          focused: document.hasFocus()
        })),
      { timeout: 10_000 }
    )
    .toEqual({ visibility: 'visible', focused: true })
  return window
}

async function initializeProfile(userDataDir: string): Promise<void> {
  const app = await launchPackaged(userDataDir)
  try {
    await waitForMainWindow(app)
  } finally {
    await app.close()
  }
}

test('packaged application boots with an isolated profile', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'omh-packaged-smoke-'))
  const app = await launchPackaged(userDataDir)

  try {
    const window = await waitForMainWindow(app)
    const consent = window.locator('[data-community-prompt="telemetry"]')
    if (!EXPECT_PUBLISHABLE) {
      const claim = await window.evaluate(() =>
        window.omh.invoke('telemetry:claimConsentPrompt', undefined)
      )
      expect(claim).toEqual({ show: false })
      return
    }

    await expect(consent).toBeVisible({ timeout: 45_000 })
    const decline = window.locator('[data-community-action="telemetry-decline"]')
    await expect(decline).toBeEnabled()
    await decline.click()
    await expect(consent).toHaveCount(0)
  } finally {
    await app.close()
  }

  if (EXPECT_PUBLISHABLE) {
    const db = openFixtureDatabase(userDataDir, true)
    try {
      const state = readKv(db, 'telemetry.consent-prompt.v1') as Record<string, unknown>
      expect(state).toMatchObject({
        version: 2,
        status: 'resolved',
        resolution: 'declined'
      })
      expect(state.claimId).toEqual(expect.stringMatching(UUID_V4_RE))
      expect(readKv(db, 'telemetry.installation-id.v1')).toBeUndefined()
      expect(
        (readKv(db, 'settings') as { telemetryEnabled?: boolean } | undefined)?.telemetryEnabled
      ).toBe(false)
    } finally {
      db.close()
    }
  }
})

test('publishable package migrates an unresolved v0.0.11 consent display', async () => {
  test.skip(!EXPECT_PUBLISHABLE, 'requires the telemetry-configured release build')
  const userDataDir = mkdtempSync(join(tmpdir(), 'omh-packaged-consent-upgrade-'))
  await initializeProfile(userDataDir)

  const db = openFixtureDatabase(userDataDir)
  writeKv(db, 'settings', { telemetryEnabled: false })
  writeKv(db, 'telemetry.consent-prompt.v1', {
    version: 1,
    claimId: CONSENT_CLAIM_ID,
    shown: true
  })
  db.close()

  const upgraded = await launchPackaged(userDataDir)
  try {
    const window = await waitForMainWindow(upgraded)
    const consent = window.locator('[data-community-prompt="telemetry"]')
    await expect(consent).toBeVisible({ timeout: 45_000 })
    const decline = window.locator('[data-community-action="telemetry-decline"]')
    await expect(decline).toBeEnabled()

    const displayedDb = openFixtureDatabase(userDataDir, true)
    try {
      expect(readKv(displayedDb, 'telemetry.consent-prompt.v1')).toEqual({
        version: 2,
        claimId: CONSENT_CLAIM_ID,
        status: 'displayed',
        resolution: null
      })
    } finally {
      displayedDb.close()
    }

    await decline.click()
    await expect(consent).toHaveCount(0)
  } finally {
    await upgraded.close()
  }

  const restarted = await launchPackaged(userDataDir)
  try {
    const window = await waitForMainWindow(restarted)
    const claim = await window.evaluate(() =>
      window.omh.invoke('telemetry:claimConsentPrompt', undefined)
    )
    expect(claim).toEqual({ show: false })
  } finally {
    await restarted.close()
  }

  const resolvedDb = openFixtureDatabase(userDataDir, true)
  try {
    expect(readKv(resolvedDb, 'telemetry.consent-prompt.v1')).toEqual(resolvedDeclineState())
    expect(readKv(resolvedDb, 'telemetry.installation-id.v1')).toBeUndefined()
  } finally {
    resolvedDb.close()
  }
})

test('publishable package retries Star eligibility after same-session activity', async () => {
  test.skip(!EXPECT_PUBLISHABLE, 'requires the telemetry-configured release build')
  const userDataDir = mkdtempSync(join(tmpdir(), 'omh-packaged-star-retry-'))
  await initializeProfile(userDataDir)

  const db = openFixtureDatabase(userDataDir)
  writeKv(db, 'telemetry.consent-prompt.v1', resolvedDeclineState())
  writeKv(db, 'star-reminder:v1', starState(2))
  db.close()

  const app = await launchPackaged(userDataDir)
  try {
    const window = await waitForMainWindow(app)
    await window.waitForTimeout(12_000)
    await expect(window.locator('[data-community-prompt="star"]')).toHaveCount(0)

    await window.evaluate(() =>
      window.omh.invoke('favorites:add', {
        summary: {
          id: 'fixture/community-prompt',
          kind: 'model',
          author: 'fixture',
          name: 'community-prompt',
          likes: 0,
          downloads: 0,
          private: false,
          gated: false,
          tags: []
        }
      })
    )

    const star = window.locator('[data-community-prompt="star"]')
    await expect(star).toBeVisible({ timeout: 35_000 })
    await expect(window.locator('[data-community-action="star-open"]')).toBeEnabled()

    const stateDb = openFixtureDatabase(userDataDir, true)
    try {
      const state = readKv(stateDb, 'star-reminder:v1') as { promptCount?: number }
      expect(state.promptCount).toBe(1)
    } finally {
      stateDb.close()
    }
  } finally {
    await app.close()
  }
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@oh-my-huggingface/shared'
import { portableSettingsForExport, settingsFromImport } from './settings-transfer'

describe('settings transfer privacy boundaries', () => {
  it('omits machine paths and telemetry consent from exports', () => {
    const exported = portableSettingsForExport({
      ...DEFAULT_SETTINGS,
      hfCacheDir: '/private/cache',
      ollamaBinaryPath: '/private/bin/ollama',
      llamaServerBinaryPath: '/private/bin/llama-server',
      telemetryEnabled: true,
      theme: 'dark'
    })

    expect(exported).not.toHaveProperty('hfCacheDir')
    expect(exported).not.toHaveProperty('ollamaBinaryPath')
    expect(exported).not.toHaveProperty('llamaServerBinaryPath')
    expect(exported).not.toHaveProperty('telemetryEnabled')
    expect(exported.theme).toBe('dark')
  })

  it.each([true, false])(
    'never changes local telemetry consent when an older import contains %s',
    (importedConsent) => {
      const current = {
        ...DEFAULT_SETTINGS,
        hfCacheDir: '/local/cache',
        ollamaBinaryPath: '/local/bin/ollama',
        llamaServerBinaryPath: '/local/bin/llama-server',
        telemetryEnabled: !importedConsent
      }

      const result = settingsFromImport(current, {
        theme: 'dark',
        hfCacheDir: '/other-machine/cache',
        ollamaBinaryPath: '/other-machine/bin/ollama',
        llamaServerBinaryPath: '/other-machine/bin/llama-server',
        telemetryEnabled: importedConsent
      })

      expect(result.hfCacheDir).toBe('/local/cache')
      expect(result.ollamaBinaryPath).toBe('/local/bin/ollama')
      expect(result.llamaServerBinaryPath).toBe('/local/bin/llama-server')
      expect(result.telemetryEnabled).toBe(!importedConsent)
      expect(result.theme).toBe('dark')
    }
  )

  it('retains existing reset-to-default behavior for omitted portable settings', () => {
    const result = settingsFromImport(
      { ...DEFAULT_SETTINGS, theme: 'dark', downloadConcurrency: 8 },
      { locale: 'de' }
    )

    expect(result.locale).toBe('de')
    expect(result.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(result.downloadConcurrency).toBe(DEFAULT_SETTINGS.downloadConcurrency)
  })
})

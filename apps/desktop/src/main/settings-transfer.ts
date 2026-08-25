import type { AppSettings } from '@oh-my-huggingface/shared'
import { DEFAULT_SETTINGS } from '@oh-my-huggingface/shared'

/** Settings that are portable between installations. Telemetry preference is local. */
export type PortableAppSettings = Omit<
  AppSettings,
  'hfCacheDir' | 'telemetryEnabled' | 'ollamaBinaryPath' | 'llamaServerBinaryPath'
>

/**
 * Machine paths and the local telemetry preference are never exported. In
 * particular, a settings file must not be able to enable or disable telemetry
 * on another installation when it is later imported.
 */
export function portableSettingsForExport(settings: AppSettings): PortableAppSettings {
  const {
    hfCacheDir: _machineCacheDir,
    telemetryEnabled: _localTelemetryConsent,
    ollamaBinaryPath: _ollamaBinaryPath,
    llamaServerBinaryPath: _llamaServerBinaryPath,
    ...portableSettings
  } = settings
  return portableSettings
}

/**
 * Apply imported preferences while preserving installation-local state. Older
 * exports may contain telemetryEnabled, but it is intentionally ignored — the
 * result omits it so applying the patch cannot resolve consent.
 */
export function settingsFromImport(
  current: AppSettings,
  imported: Partial<AppSettings>
): Omit<AppSettings, 'telemetryEnabled'> {
  const {
    hfCacheDir: _importedCacheDir,
    telemetryEnabled: _importedTelemetryConsent,
    ollamaBinaryPath: _importedOllamaBinaryPath,
    llamaServerBinaryPath: _importedLlamaBinaryPath,
    ...portableSettings
  } = imported
  const { telemetryEnabled: _defaultTelemetryConsent, ...defaultsWithoutConsent } = DEFAULT_SETTINGS
  return {
    ...defaultsWithoutConsent,
    ...portableSettings,
    hfCacheDir: current.hfCacheDir,
    ollamaBinaryPath: current.ollamaBinaryPath,
    llamaServerBinaryPath: current.llamaServerBinaryPath
  }
}

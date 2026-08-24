import type { AppSettings } from '@oh-my-huggingface/shared'
import { DEFAULT_SETTINGS } from '@oh-my-huggingface/shared'

/** Settings that are portable between installations. Consent is deliberately local. */
export type PortableAppSettings = Omit<AppSettings, 'hfCacheDir' | 'telemetryEnabled'>

/**
 * Machine paths and telemetry consent are never exported. In particular, a
 * settings file must not be able to confer telemetry consent on another
 * installation when it is later imported.
 */
export function portableSettingsForExport(settings: AppSettings): PortableAppSettings {
  const {
    hfCacheDir: _machineCacheDir,
    telemetryEnabled: _localTelemetryConsent,
    ...portableSettings
  } = settings
  return portableSettings
}

/**
 * Apply imported preferences while preserving installation-local state. Older
 * exports may contain telemetryEnabled, but it is intentionally ignored.
 */
export function settingsFromImport(
  current: AppSettings,
  imported: Partial<AppSettings>
): AppSettings {
  const {
    hfCacheDir: _importedCacheDir,
    telemetryEnabled: _importedTelemetryConsent,
    ...portableSettings
  } = imported
  return {
    ...DEFAULT_SETTINGS,
    ...portableSettings,
    hfCacheDir: current.hfCacheDir,
    telemetryEnabled: current.telemetryEnabled
  }
}

import { NAVIGATION_SHORTCUTS } from '@oh-my-huggingface/shared'

export type ShortcutGroup = 'global' | 'navigation' | 'list' | 'palette'

export interface ShortcutDef {
  group: ShortcutGroup
  /** Key of the row label in the `shortcuts` namespace. */
  labelKey: string
  /** Key chips, rendered as <Kbd> in order. */
  keys: string[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['global', 'navigation', 'list', 'palette']

/**
 * Single source for shortcut hints: the help overlay and tooltips both render
 * from here so hints never drift from the handlers in AppShell.
 */
export function shortcutList(isMac: boolean): ShortcutDef[] {
  const mod = isMac ? '⌘' : 'Ctrl'
  return [
    { group: 'global', labelKey: 'palette', keys: [mod, 'K'] },
    { group: 'global', labelKey: 'settings', keys: [mod, ','] },
    { group: 'global', labelKey: 'toggleSidebar', keys: [mod, 'B'] },
    { group: 'global', labelKey: 'help', keys: ['?'] },
    { group: 'navigation', labelKey: 'back', keys: isMac ? [mod, '['] : ['Alt', '←'] },
    { group: 'navigation', labelKey: 'forward', keys: isMac ? [mod, ']'] : ['Alt', '→'] },
    ...NAVIGATION_SHORTCUTS.filter((item) => item.key !== undefined).map((item) => ({
      group: 'navigation' as const,
      labelKey: item.labelKey,
      keys: [mod, item.key!]
    })),
    { group: 'list', labelKey: 'listNav', keys: ['↑', '↓', 'J', 'K'] },
    { group: 'list', labelKey: 'focusSearch', keys: ['/'] },
    { group: 'palette', labelKey: 'paletteNavigate', keys: ['↑', '↓'] },
    { group: 'palette', labelKey: 'paletteSelect', keys: ['↵'] },
    { group: 'palette', labelKey: 'paletteClose', keys: ['Esc'] }
  ]
}

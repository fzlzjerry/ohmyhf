import { Menu, app, dialog, shell, type MenuItemConstructorOptions } from 'electron'
import { NAVIGATION_SHORTCUTS } from '@oh-my-huggingface/shared'
import type { MainI18n } from './i18n'

const REPO_URL = 'https://github.com/oh-my-hf/ohmyhf'

/** Fully localized native application menu. Rebuilt whenever the locale changes. */
export function buildMenu(i18n: MainI18n, navigate: (route: string) => void): void {
  const t = (key: string): string => i18n.t(key)
  const isMac = process.platform === 'darwin'
  const goItems = NAVIGATION_SHORTCUTS.flatMap<MenuItemConstructorOptions>((item, index, all) => {
    const prev = all[index - 1]
    const split = Boolean(prev?.key) !== Boolean(item.key)
    return [
      ...(index > 0 && split ? [{ type: 'separator' as const }] : []),
      {
        label: t(item.menuKey),
        ...(item.key ? { accelerator: `CmdOrCtrl+${item.key}` } : {}),
        click: () => navigate(item.route)
      }
    ]
  })

  const showAbout = (): void => {
    void dialog.showMessageBox({
      type: 'info',
      title: t('app.name'),
      message: t('app.name'),
      detail: i18n.t('dialogs.aboutDetail', { version: app.getVersion() }),
      buttons: [t('dialogs.ok')]
    })
  }

  const macAppMenu: MenuItemConstructorOptions = {
    label: t('app.name'),
    submenu: [
      { label: t('menu.about'), click: showAbout },
      { type: 'separator' },
      {
        label: t('menu.settings'),
        accelerator: 'CmdOrCtrl+,',
        click: () => navigate('/settings')
      },
      { type: 'separator' },
      { role: 'hide', label: t('menu.hide') },
      { role: 'hideOthers', label: t('menu.hideOthers') },
      { role: 'unhide', label: t('menu.showAll') },
      { type: 'separator' },
      { role: 'quit', label: t('menu.quit') }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    ...(!isMac
      ? [
          {
            label: t('menu.file'),
            submenu: [
              {
                label: t('menu.settings'),
                accelerator: 'CmdOrCtrl+,',
                click: (): void => navigate('/settings')
              },
              { type: 'separator' },
              { role: 'quit', label: t('menu.quit') }
            ] as MenuItemConstructorOptions[]
          }
        ]
      : []),
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') }
      ]
    },
    {
      label: t('menu.go'),
      submenu: goItems
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'forceReload', label: t('menu.forceReload') },
        { role: 'toggleDevTools', label: t('menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.toggleFullscreen') }
      ]
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'close', label: t('menu.close') }
      ]
    },
    {
      label: t('menu.help'),
      role: 'help',
      submenu: [
        { label: t('menu.github'), click: () => void shell.openExternal(REPO_URL) },
        {
          label: t('menu.reportIssue'),
          click: () => void shell.openExternal(`${REPO_URL}/issues/new`)
        },
        { type: 'separator' },
        { label: t('menu.disclaimer'), click: showAbout }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

import { useEffect, useState } from 'react'

const BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[aria-modal="true"]:not([data-state="closed"])',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[data-community-blocking-overlay]'
].join(',')

/**
 * Covers Radix Dialog/AlertDialog/Lightbox portals and transient menus/selects,
 * including page-local overlays that are not represented in the app store.
 */
export function hasBlockingOverlay(): boolean {
  return document.querySelector(BLOCKING_OVERLAY_SELECTOR) !== null
}

/** Observe portal insertion/removal and Radix data-state transitions. */
export function useBlockingOverlay(): boolean {
  const [open, setOpen] = useState(hasBlockingOverlay)

  useEffect(() => {
    const update = (): void => setOpen(hasBlockingOverlay())
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'data-state', 'role', 'data-community-blocking-overlay']
    })
    return () => observer.disconnect()
  }, [])

  return open
}

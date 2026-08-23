import { useAppStore } from '@/stores/app'

/**
 * Whether a supplemental Hub web session (cookie) is connected. Gates the
 * social writes the Hub blocks for Bearer tokens (repo likes, post
 * reactions/comments, watch, discussion reactions) and the personalized
 * following feed. `evt:auth` flows through AppShell into the store, so this
 * flips reactively on connect/disconnect — including the automatic disconnect
 * when a cookie call comes back 401.
 */
export function useHubSession(): boolean {
  return useAppStore((s) => s.auth.status === 'signedIn' && s.auth.hubSession === true)
}

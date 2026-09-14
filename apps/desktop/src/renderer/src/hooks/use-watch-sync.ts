import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { invoke, openExternal } from '@/lib/ipc'
import { useToasts } from '@/components/ui/toaster'
import { useHubSession } from '@/hooks/use-hub-session'
import { useAppStore } from '@/stores/app'
import { hubUserUrl, normalizeHubEndpoint } from '@oh-my-huggingface/shared'

export interface WatchSyncTarget {
  username: string
  isOrg?: boolean
}

/**
 * Follow write-through to the Hub's watch list, shared by the Inbox
 * manage-follows dialog. The local follow is the primary feature and always wins.
 *
 * Live-verified 2026-07-11 against PATCH /api/settings/watch: token-based
 * ADD and DELETE of real user/org targets are SILENTLY IGNORED — HTTP 200,
 * but the list never changes (write-role and fine-grained tokens alike).
 * Only the browser cookie session can mutate watches. So with a connected
 * Hub web session the change goes through hub:watchSet (which verifies the
 * Hub actually applied it); token-only sessions skip the known no-op and
 * point at the working Watch button on the website instead.
 */
export function useWatchSync(): (action: 'add' | 'delete', targets: WatchSyncTarget[]) => void {
  const { t } = useTranslation(['profile'])
  const push = useToasts((s) => s.push)
  const queryClient = useQueryClient()
  const auth = useAppStore((s) => s.auth)
  const openSettings = useAppStore((s) => s.openSettings)
  const signedIn = auth.status === 'signedIn'
  const hubSession = useHubSession()
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const endpointKey = normalizeHubEndpoint(endpoint)

  return (action, targets) => {
    const current = useAppStore.getState()
    if (
      !signedIn ||
      targets.length === 0 ||
      current.auth !== auth ||
      normalizeHubEndpoint(current.settings.hubEndpoint) !== endpointKey
    )
      return
    if (!hubSession) {
      push(t('profile:watchSyncNotApplied'), 'info', {
        action: {
          label: t('profile:watchOnHub'),
          onClick: () => openExternal(hubUserUrl(targets[0]!.username, endpoint))
        }
      })
      return
    }
    const watching = action === 'add'
    void Promise.all(
      targets.map((target) =>
        // Watches are keyed by account handle, not the internal id.
        invoke('hub:watchSet', {
          id: target.username,
          type: target.isOrg === true ? 'org' : 'user',
          watching
        })
      )
    )
      .then((results) => {
        const current = useAppStore.getState()
        if (
          current.auth !== auth ||
          normalizeHubEndpoint(current.settings.hubEndpoint) !== endpointKey
        )
          return
        const last = results[results.length - 1]
        if (last !== undefined) queryClient.setQueryData(['hub-watched', endpointKey], last.watched)
        if (results.every((r) => r.applied)) {
          push(t(watching ? 'profile:watchSuccess' : 'profile:unwatchSuccess'), 'success')
          return
        }
        // A connected web session that still didn't apply the change means the
        // cookie went stale — point at Settings to reconnect.
        push(t('profile:watchSessionExpired'), 'error', {
          action: {
            label: t('profile:watchReconnect'),
            onClick: () => openSettings('account')
          }
        })
      })
      .catch((err: Error) => push(t('profile:watchError', { error: err.message }), 'error'))
  }
}

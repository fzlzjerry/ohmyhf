import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, ShieldAlert, Tag, UserPlus, Users } from 'lucide-react'
import type { AccessRequest, RepoKind } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { isRepoQuery, repoQueryKey } from '@/lib/query'
import { formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToasts } from '@/components/ui/toaster'
import {
  DeleteRepoDialog,
  DuplicateRepoDialog,
  RenameRepoDialog
} from '@/components/admin/RepoActionDialogs'
import { MANAGE_REPOS_SCOPE, scopeMissing } from '@/lib/scopes'
import { resolveLocale, useAppStore } from '@/stores/app'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'

const KIND_PATH: Record<RepoKind, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces'
}

type GatedMode = 'off' | 'auto' | 'manual'

type AccessStatus = 'pending' | 'accepted' | 'rejected'

const ACCESS_TABS: readonly AccessStatus[] = ['pending', 'accepted', 'rejected']

function SectionHeading({
  icon: Icon,
  children
}: {
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <h3 className="flex items-center gap-2 text-[12px] font-semibold text-ink-faint">
      <Icon className="size-3.5 text-ink-faint" aria-hidden />
      {children}
    </h3>
  )
}

/**
 * Owner administration panel for a single repo: visibility + gated mode,
 * rename/duplicate/delete, branch & tag management, gated access requests.
 * Self-contained; mount it anywhere the owner views their repo.
 */
export function RepoManagePanel({
  kind,
  repoId
}: {
  kind: RepoKind
  repoId: string
}): React.JSX.Element {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const auth = useAppStore((s) => s.auth)
  const endpointKey = useHubEndpointKey()

  const [dialog, setDialog] = useState<'rename' | 'duplicate' | 'delete' | null>(null)
  const [branch, setBranch] = useState('')
  const [startingPoint, setStartingPoint] = useState('')
  const [tag, setTag] = useState('')
  const [tagMessage, setTagMessage] = useState('')

  const canManage = !scopeMissing(auth, MANAGE_REPOS_SCOPE)

  // Mutable repository settings share the detail family's endpoint/repository prefix.
  const detail = useQuery({
    queryKey: repoQueryKey('repo', endpointKey, kind, repoId),
    queryFn: () => invoke('hub:repoDetail', { kind, repoId }),
    enabled: canManage
  })

  const invalidateDetail = (): void => {
    void queryClient.invalidateQueries({
      queryKey: repoQueryKey('repo', endpointKey, kind, repoId)
    })
    void queryClient.invalidateQueries({ queryKey: ['my-repos'] })
  }

  // After rename/duplicate/delete: drop the stale detail caches for this id and
  // refresh the listing before navigating away.
  const dropRepoCaches = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['my-repos'] })
    queryClient.removeQueries({
      predicate: (query) => isRepoQuery(query.queryKey, endpointKey, kind, repoId)
    })
  }

  const updateSettings = useMutation({
    mutationFn: (patch: { private?: boolean; gated?: false | 'auto' | 'manual' }) =>
      invoke('hub:repoSettingsUpdate', { kind, repoId, patch }),
    onSuccess: () => {
      push(t('admin:settings.updated'), 'success')
      invalidateDetail()
    },
    onError: (err) => push(err.message, 'error')
  })

  const createBranch = useMutation({
    mutationFn: () =>
      invoke('hub:branchCreate', {
        kind,
        repoId,
        branch: branch.trim(),
        startingPoint: startingPoint.trim() || undefined
      }),
    onSuccess: () => {
      push(t('admin:refs.branchCreated'), 'success')
      setBranch('')
      setStartingPoint('')
    },
    onError: (err) => push(err.message, 'error')
  })

  const deleteBranch = useMutation({
    mutationFn: () => invoke('hub:branchDelete', { kind, repoId, branch: branch.trim() }),
    onSuccess: () => {
      push(t('admin:refs.branchDeleted'), 'success')
      setBranch('')
    },
    onError: (err) => push(err.message, 'error')
  })

  const createTag = useMutation({
    mutationFn: () =>
      invoke('hub:tagCreate', {
        kind,
        repoId,
        tag: tag.trim(),
        message: tagMessage.trim() || undefined
      }),
    onSuccess: () => {
      push(t('admin:refs.tagCreated'), 'success')
      setTag('')
      setTagMessage('')
    },
    onError: (err) => push(err.message, 'error')
  })

  const deleteTag = useMutation({
    mutationFn: () => invoke('hub:tagDelete', { kind, repoId, tag: tag.trim() }),
    onSuccess: () => {
      push(t('admin:refs.tagDeleted'), 'success')
      setTag('')
    },
    onError: (err) => push(err.message, 'error')
  })

  if (!canManage) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title={t('admin:gatedHint.title')}
        body={t('admin:gatedHint.body')}
      />
    )
  }

  const gatedMode: GatedMode =
    detail.data?.gated === 'auto' ? 'auto' : detail.data?.gated ? 'manual' : 'off'
  const gatedEnabled = Boolean(detail.data?.gated)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
      {/* Visibility & gated mode */}
      <section className="flex flex-col gap-3">
        <SectionHeading icon={ShieldAlert}>{t('admin:settings.title')}</SectionHeading>
        {detail.isPending && <Skeleton className="h-16" />}
        {detail.isError && (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
            <span className="min-w-0 flex-1">{detail.error.message}</span>
            <Button size="sm" onClick={() => void detail.refetch()}>
              {t('common:retry')}
            </Button>
          </div>
        )}
        {detail.data && (
          <div className="flex flex-col gap-2.5 rounded-md border p-3">
            <label className="flex items-center justify-between gap-2 text-[13px]">
              <span>
                {t('admin:settings.private')}
                <span className="mt-0.5 block text-[11.5px] text-ink-faint">
                  {t('admin:settings.privateHint')}
                </span>
              </span>
              <Switch
                checked={detail.data.private}
                disabled={updateSettings.isPending}
                onCheckedChange={(checked) => updateSettings.mutate({ private: checked })}
              />
            </label>
            {kind !== 'space' && (
              <label className="flex items-center justify-between gap-2 text-[13px]">
                <span>
                  {t('admin:settings.gated')}
                  <span className="mt-0.5 block text-[11.5px] text-ink-faint">
                    {t('admin:settings.gatedHint')}
                  </span>
                </span>
                <Select
                  value={gatedMode}
                  disabled={updateSettings.isPending}
                  onValueChange={(mode) =>
                    updateSettings.mutate({
                      gated: mode === 'off' ? false : (mode as 'auto' | 'manual')
                    })
                  }
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">{t('admin:settings.gatedOff')}</SelectItem>
                    <SelectItem value="auto">{t('admin:settings.gatedAuto')}</SelectItem>
                    <SelectItem value="manual">{t('admin:settings.gatedManual')}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => setDialog('rename')}>
            {t('admin:actions.rename')}
          </Button>
          {/* The Hub only supports duplicating Spaces. */}
          {kind === 'space' && (
            <Button variant="secondary" size="sm" onClick={() => setDialog('duplicate')}>
              {t('admin:actions.duplicate')}
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            className="ml-auto"
            onClick={() => setDialog('delete')}
          >
            {t('common:delete')}
          </Button>
        </div>
      </section>

      {/* Branch & tag management (create/delete; the Hub API exposes no cheap ref listing here) */}
      <section className="flex flex-col gap-3">
        <SectionHeading icon={GitBranch}>{t('admin:refs.title')}</SectionHeading>
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="text-[12px] text-ink-faint">{t('admin:refs.branchesHint')}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder={t('admin:refs.branchPlaceholder')}
              className="w-44 flex-none font-mono"
              spellCheck={false}
            />
            <Input
              value={startingPoint}
              onChange={(e) => setStartingPoint(e.target.value)}
              placeholder={t('admin:refs.startingPointPlaceholder')}
              className="w-44 flex-none font-mono"
              spellCheck={false}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={branch.trim() === ''}
              loading={createBranch.isPending}
              onClick={() => createBranch.mutate()}
            >
              {t('admin:refs.createBranch')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={branch.trim() === ''}
              loading={deleteBranch.isPending}
              onClick={() => deleteBranch.mutate()}
            >
              {t('admin:refs.deleteBranch')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="flex items-center gap-1.5 text-[12px] text-ink-faint">
            <Tag className="size-3.5" aria-hidden />
            {t('admin:refs.tagsHint')}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder={t('admin:refs.tagPlaceholder')}
              className="w-44 flex-none font-mono"
              spellCheck={false}
            />
            <Input
              value={tagMessage}
              onChange={(e) => setTagMessage(e.target.value)}
              placeholder={t('admin:refs.tagMessagePlaceholder')}
              className="w-44 flex-none"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={tag.trim() === ''}
              loading={createTag.isPending}
              onClick={() => createTag.mutate()}
            >
              {t('admin:refs.createTag')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={tag.trim() === ''}
              loading={deleteTag.isPending}
              onClick={() => deleteTag.mutate()}
            >
              {t('admin:refs.deleteTag')}
            </Button>
          </div>
        </div>
      </section>

      {/* Gated access requests (models and datasets only) */}
      {kind !== 'space' && (
        <AccessRequestsSection kind={kind} repoId={repoId} gatedEnabled={gatedEnabled} />
      )}

      <RenameRepoDialog
        kind={kind}
        repoId={repoId}
        open={dialog === 'rename'}
        onOpenChange={(open) => !open && setDialog(null)}
        onDone={(toRepo) => {
          dropRepoCaches()
          navigate(`/${KIND_PATH[kind]}/${toRepo}`)
        }}
      />
      {kind === 'space' && (
        <DuplicateRepoDialog
          repoId={repoId}
          open={dialog === 'duplicate'}
          onOpenChange={(open) => !open && setDialog(null)}
          onDone={(toRepo) => {
            dropRepoCaches()
            navigate(`/spaces/${toRepo}`)
          }}
        />
      )}
      <DeleteRepoDialog
        kind={kind}
        repoId={repoId}
        open={dialog === 'delete'}
        onOpenChange={(open) => !open && setDialog(null)}
        onDone={() => {
          dropRepoCaches()
          navigate(`/${KIND_PATH[kind]}`)
        }}
      />
    </div>
  )
}

function AccessRequestRow({
  request,
  status,
  locale,
  onHandle,
  handling
}: {
  request: AccessRequest
  status: AccessStatus
  locale: string
  onHandle: (user: string, status: 'accepted' | 'rejected', rejectionReason?: string) => void
  handling: boolean
}): React.JSX.Element {
  const { t } = useTranslation(['admin', 'common'])
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  const fieldsText = request.fields
    ? Object.entries(request.fields)
        .map(([key, value]) => `${key}: ${value}`)
        .join(' · ')
    : undefined

  return (
    <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {request.user.name}
          {request.user.fullname && (
            <span className="ml-1.5 text-[12px] font-normal text-ink-faint">
              {request.user.fullname}
            </span>
          )}
        </span>
        {request.timestamp && (
          <span className="nums shrink-0 text-[11px] text-ink-faint">
            {formatRelativeTime(request.timestamp, locale)}
          </span>
        )}
        {!rejecting && (
          <span className="flex shrink-0 items-center gap-1">
            {status !== 'accepted' && (
              <Button
                variant="secondary"
                size="sm"
                disabled={handling}
                onClick={() => onHandle(request.user.name, 'accepted')}
              >
                {t('admin:access.accept')}
              </Button>
            )}
            {status !== 'rejected' && (
              <Button
                variant="ghost"
                size="sm"
                className="text-error"
                disabled={handling}
                onClick={() => setRejecting(true)}
              >
                {t('admin:access.reject')}
              </Button>
            )}
          </span>
        )}
      </div>
      {fieldsText && <p className="truncate text-[11.5px] text-ink-faint">{fieldsText}</p>}
      {rejecting && (
        <div className="flex items-center gap-1.5">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('admin:access.reasonPlaceholder')}
            maxLength={200}
          />
          <Button
            variant="danger"
            size="sm"
            disabled={handling}
            onClick={() => onHandle(request.user.name, 'rejected', reason.trim() || undefined)}
          >
            {t('admin:access.reject')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
            {t('common:cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}

function AccessRequestsSection({
  kind,
  repoId,
  gatedEnabled
}: {
  kind: 'model' | 'dataset'
  repoId: string
  gatedEnabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation(['admin', 'common'])
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = useHubEndpointKey()

  const [status, setStatus] = useState<AccessStatus>('pending')
  const [grantUser, setGrantUser] = useState('')

  const requests = useQuery({
    queryKey: ['access-requests', kind, repoId, status, endpointKey],
    queryFn: () => invoke('hub:accessRequests', { kind, repoId, status }),
    enabled: gatedEnabled
  })

  const invalidateAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['access-requests', kind, repoId] })
  }

  const handle = useMutation({
    mutationFn: (args: {
      user: string
      status: 'accepted' | 'rejected'
      rejectionReason?: string
    }) => invoke('hub:accessRequestHandle', { kind, repoId, ...args }),
    onSuccess: () => {
      push(t('admin:access.handled'), 'success')
      invalidateAll()
    },
    onError: (err) => push(err.message, 'error')
  })

  const grant = useMutation({
    mutationFn: () => invoke('hub:accessRequestGrant', { kind, repoId, user: grantUser.trim() }),
    onSuccess: () => {
      push(t('admin:access.granted'), 'success')
      setGrantUser('')
      invalidateAll()
    },
    onError: (err) => push(err.message, 'error')
  })

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading icon={Users}>{t('admin:access.title')}</SectionHeading>
      {!gatedEnabled && (
        <p className="text-[12.5px] text-ink-muted">{t('admin:access.notGated')}</p>
      )}
      {gatedEnabled && (
        <>
          <div className="flex items-center gap-1.5">
            <UserPlus className="size-4 shrink-0 text-ink-faint" aria-hidden />
            <Input
              value={grantUser}
              onChange={(e) => setGrantUser(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && grantUser.trim() !== '' && grant.mutate()}
              placeholder={t('admin:access.grantPlaceholder')}
              className="w-56"
              spellCheck={false}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={grantUser.trim() === ''}
              loading={grant.isPending}
              onClick={() => grant.mutate()}
            >
              {t('admin:access.grant')}
            </Button>
          </div>
          <Tabs value={status} onValueChange={(v) => setStatus(v as AccessStatus)}>
            <TabsList>
              {ACCESS_TABS.map((tab) => (
                <TabsTrigger key={tab} value={tab}>
                  {t(`admin:access.tab.${tab}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            {ACCESS_TABS.map((tab) => (
              <TabsContent key={tab} value={tab} className="pt-2">
                {tab === status && (
                  <>
                    {requests.isPending && <Skeleton className="h-10" />}
                    {requests.isError && (
                      <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
                        <span className="min-w-0 flex-1">{requests.error.message}</span>
                        <Button size="sm" onClick={() => void requests.refetch()}>
                          {t('common:retry')}
                        </Button>
                      </div>
                    )}
                    {requests.data?.length === 0 && (
                      <p className="text-[12.5px] text-ink-faint">{t('admin:access.empty')}</p>
                    )}
                    <div className="flex flex-col gap-1.5">
                      {requests.data?.map((request) => (
                        <AccessRequestRow
                          key={request.user.name}
                          request={request}
                          status={tab}
                          locale={locale}
                          handling={handle.isPending}
                          onHandle={(user, nextStatus, rejectionReason) =>
                            handle.mutate({ user, status: nextStatus, rejectionReason })
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </>
      )}
    </section>
  )
}

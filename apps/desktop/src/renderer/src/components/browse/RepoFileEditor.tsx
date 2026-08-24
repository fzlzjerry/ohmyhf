import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Save, X } from 'lucide-react'
import type { RepoKind, RepoRevisionSelection } from '@oh-my-huggingface/shared'
import { describeError } from '@/lib/errors'
import { invoke, openExternal } from '@/lib/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToasts } from '@/components/ui/toaster'
import { MarkdownEditor } from '@/components/browse/MarkdownEditor'
import { useAppStore } from '@/stores/app'

export function isEditableRepoFile(path: string): boolean {
  const name = (path.split('/').at(-1) ?? path).toLowerCase()
  return (
    name === 'readme.md' ||
    name.endsWith('.md') ||
    name.endsWith('.json') ||
    name.endsWith('.yml') ||
    name.endsWith('.yaml') ||
    name.endsWith('.txt') ||
    name === '.gitattributes'
  )
}

export function RepoFileEditor({
  kind,
  repoId,
  path,
  initial,
  revision,
  onClose,
  onSaved
}: {
  kind: RepoKind
  repoId: string
  path: string
  initial: string
  revision: RepoRevisionSelection
  onClose: () => void
  onSaved: (content: string) => void
}): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common', 'errors'])
  const auth = useAppStore((s) => s.auth)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const [content, setContent] = useState(initial)
  const [title, setTitle] = useState(t('detail:edit.defaultTitle', { file: path }))
  const [createPr, setCreatePr] = useState(false)
  const canWrite = auth.status === 'signedIn'

  const commit = useMutation({
    mutationFn: () =>
      invoke('hub:commitFiles', {
        kind,
        repoId,
        files: [{ path, content }],
        title: title.trim() || t('detail:edit.defaultTitle', { file: path }),
        branch: revision.type === 'branch' ? revision.requested : undefined,
        startingPoint: revision.resolvedCommit,
        createPr
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        push(
          result.messageKey === 'edit.needWrite'
            ? t('detail:edit.needWrite')
            : t('detail:edit.commitFailed', { error: result.error }),
          'error'
        )
        return
      }
      onSaved(content)
      void queryClient.invalidateQueries({ queryKey: ['readme', kind, repoId] })
      void queryClient.invalidateQueries({ queryKey: ['repo', kind, repoId] })
      push(t('detail:edit.committed', { branch: result.branch }), 'success', {
        action: result.compareUrl
          ? {
              label: t('detail:edit.openPr'),
              onClick: () => openExternal(result.compareUrl!)
            }
          : undefined
      })
      onClose()
    },
    onError: (err) => push(describeError(t, err), 'error')
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink-strong">
          {t('detail:edit.title', { file: path })}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="size-3.5" aria-hidden />
          {t('common:cancel')}
        </Button>
      </div>
      {!canWrite && <p className="text-[12px] text-ink-faint">{t('detail:edit.needSignIn')}</p>}
      <MarkdownEditor
        value={content}
        onChange={setContent}
        kind={kind}
        repoId={repoId}
        enableUpload={false}
        placeholder={t('detail:edit.placeholder')}
      />
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-ink-strong">{t('detail:edit.message')}</span>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
      </label>
      <label className="flex items-center gap-2 text-[12.5px] text-ink">
        <input
          type="checkbox"
          className="size-3.5 accent-select"
          checked={createPr}
          onChange={(event) => setCreatePr(event.target.checked)}
        />
        {t('detail:edit.createPr')}
      </label>
      <div>
        <Button
          variant="cta"
          size="sm"
          loading={commit.isPending}
          disabled={!canWrite || content === initial || revision.readOnly}
          onClick={() => commit.mutate()}
        >
          <Save className="size-3.5" aria-hidden />
          {t('detail:edit.commit')}
        </Button>
      </div>
    </div>
  )
}

export function EditFileButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const { t } = useTranslation('detail')
  return (
    <Button variant="secondary" size="sm" onClick={onClick}>
      <Pencil className="size-3.5" aria-hidden />
      {t('detail:edit.action')}
    </Button>
  )
}

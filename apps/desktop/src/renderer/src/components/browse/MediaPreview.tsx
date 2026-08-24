import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, FileQuestion } from 'lucide-react'
import type { RepoKind } from '@oh-my-huggingface/shared'
import { repoFileUrl } from '@/components/browse/MarkdownView'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/stores/app'
import { useResolvedRepoCommit } from '@/components/browse/revision-context'

interface MediaPreviewProps {
  kind: RepoKind
  repoId: string
  path: string
  mode: 'audio' | 'video'
  onDownload: () => void
  downloading: boolean
}

export function MediaPreview({
  kind,
  repoId,
  path,
  mode,
  onDownload,
  downloading
}: MediaPreviewProps): React.JSX.Element {
  const { t } = useTranslation('detail')
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const revision = useResolvedRepoCommit()
  const src = repoFileUrl(kind, repoId, path, revision, endpoint)
  const [failedSrc, setFailedSrc] = useState<string>()
  const failed = failedSrc === src

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={FileQuestion}
          title={t('preview.mediaErrorTitle')}
          body={t('preview.mediaErrorBody')}
          action={
            <Button variant="secondary" size="sm" loading={downloading} onClick={onDownload}>
              <ArrowDownToLine className="size-3.5" aria-hidden />
              {t('files.download')}
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      {mode === 'audio' ? (
        <audio controls src={src} className="w-full max-w-xl" onError={() => setFailedSrc(src)}>
          <track kind="captions" />
        </audio>
      ) : (
        <video
          controls
          src={src}
          className="max-h-full max-w-full rounded-md border border-border-card bg-black"
          onError={() => setFailedSrc(src)}
        >
          <track kind="captions" />
        </video>
      )}
    </div>
  )
}

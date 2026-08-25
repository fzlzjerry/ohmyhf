import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, FileQuestion } from 'lucide-react'
import type { RepoKind } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { PdfBytesViewer } from '@/components/browse/PdfBytesViewer'
import { useResolvedRepoCommit } from '@/components/browse/revision-context'

/** Keep under hub:fileRange's 64 MiB inclusive-window cap. */
const MAX_PDF_BYTES = 32 * 1024 * 1024

interface PdfPreviewProps {
  kind: RepoKind
  repoId: string
  path: string
  size: number
  onDownload: () => void
  downloading: boolean
}

export function PdfPreview({
  kind,
  repoId,
  path,
  size,
  onDownload,
  downloading
}: PdfPreviewProps): React.JSX.Element {
  const { t } = useTranslation(['detail', 'common'])
  const revision = useResolvedRepoCommit()
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [error, setError] = useState<'tooLarge' | 'unreadable' | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setBytes(null)
    setError(null)
    setLoading(true)

    void (async () => {
      try {
        if (size <= 0 || size > MAX_PDF_BYTES) {
          if (!cancelled) {
            setError('tooLarge')
            setLoading(false)
          }
          return
        }

        // Fetch through main-process IPC: pdf.js can't reliably XHR/fetch the
        // omhf-file:// custom scheme under the renderer CSP (connect-src 'self').
        const data = await invoke('hub:fileRange', {
          kind,
          repoId,
          path,
          revision,
          start: 0,
          end: size - 1
        })
        if (cancelled) return
        setBytes(data)
        setLoading(false)
      } catch {
        if (!cancelled) {
          setError('unreadable')
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [kind, repoId, path, revision, size])

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (error || !bytes) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={FileQuestion}
          title={t('detail:preview.pdfErrorTitle')}
          body={
            error === 'tooLarge'
              ? t('detail:preview.pdfTooLargeBody', { size: formatBytes(MAX_PDF_BYTES) })
              : t('detail:preview.pdfErrorBody')
          }
          action={
            <Button variant="secondary" size="sm" loading={downloading} onClick={onDownload}>
              <ArrowDownToLine className="size-3.5" aria-hidden />
              {t('detail:files.download')}
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <PdfBytesViewer
      bytes={bytes}
      errorTitle={t('detail:preview.pdfErrorTitle')}
      errorBody={t('detail:preview.pdfErrorBody')}
      pageLabel={(page, total) => t('detail:preview.pdfPage', { page, total })}
      prevLabel={t('detail:datasetPreview.prev')}
      nextLabel={t('detail:datasetPreview.next')}
    />
  )
}

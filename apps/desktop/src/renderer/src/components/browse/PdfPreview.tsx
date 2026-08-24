import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileQuestion } from 'lucide-react'
import type { RepoKind } from '@oh-my-huggingface/shared'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { invoke } from '@/lib/ipc'
import { formatBytes } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [error, setError] = useState<'tooLarge' | 'unreadable' | null>(null)
  const [loading, setLoading] = useState(true)
  // Keep the pdf.js document across page flips without re-fetching.
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    let cancelled = false
    docRef.current = null

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
        const bytes = await invoke('hub:fileRange', {
          kind,
          repoId,
          path,
          revision,
          start: 0,
          end: size - 1
        })
        if (cancelled) return

        const pdfjs = await import('pdfjs-dist')
        // Vite `?worker` emits a same-origin Worker module (CSP script-src 'self').
        const PdfWorker = (await import('pdfjs-dist/build/pdf.worker.mjs?worker')).default
        workerRef.current?.terminate()
        const worker = new PdfWorker()
        workerRef.current = worker
        pdfjs.GlobalWorkerOptions.workerPort = worker

        const copy = new Uint8Array(bytes.byteLength)
        copy.set(bytes)
        const doc = await pdfjs.getDocument({ data: copy }).promise
        if (cancelled) {
          await doc.cleanup()
          return
        }
        docRef.current = doc
        setPageCount(doc.numPages)
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
      const doc = docRef.current
      docRef.current = null
      if (doc) void doc.cleanup()
      workerRef.current?.terminate()
      workerRef.current = null
      void import('pdfjs-dist').then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerPort = null
      })
    }
  }, [kind, repoId, path, revision, size])

  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || page < 1 || page > pageCount || loading) return
    let cancelled = false

    void (async () => {
      try {
        const pdfPage = await doc.getPage(page)
        if (cancelled) return
        const viewport = pdfPage.getViewport({ scale: 1.25 })
        const context = canvas.getContext('2d')
        if (!context) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        await pdfPage.render({ canvasContext: context, viewport, canvas }).promise
      } catch {
        if (!cancelled) setError('unreadable')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [page, pageCount, loading])

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (error || pageCount === 0) {
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-[12px] text-ink-muted">
          {t('detail:preview.pdfPage', { page, total: pageCount })}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('detail:datasetPreview.prev')}
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('detail:datasetPreview.next')}
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-panel/40 p-4">
        <canvas ref={canvasRef} className="max-w-full shadow-sm" />
      </div>
    </div>
  )
}

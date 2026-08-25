import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileQuestion } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'

export function PdfBytesViewer({
  bytes,
  errorTitle,
  errorBody,
  pageLabel,
  prevLabel,
  nextLabel
}: {
  bytes: Uint8Array
  errorTitle: string
  errorBody: string
  pageLabel: (page: number, total: number) => string
  prevLabel: string
  nextLabel: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        const PdfWorker = (await import('pdfjs-dist/build/pdf.worker.mjs?worker')).default
        if (cancelled) return
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
          setError(true)
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
  }, [bytes])

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
        if (!cancelled) setError(true)
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
        <EmptyState icon={FileQuestion} title={errorTitle} body={errorBody} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-[12px] text-ink-muted">{pageLabel(page, pageCount)}</span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={prevLabel}
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={nextLabel}
            disabled={page >= pageCount}
            onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
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

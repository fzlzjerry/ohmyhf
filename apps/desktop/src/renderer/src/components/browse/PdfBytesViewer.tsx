import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileQuestion, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'

const MIN_ZOOM = 0.6
const MAX_ZOOM = 2.4
const ZOOM_STEP = 0.2

function isPdfRenderCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  const message = 'message' in error ? String(error.message) : ''
  return name === 'RenderingCancelledException' || /cancel/i.test(message)
}

export function PdfBytesViewer({
  bytes,
  errorTitle,
  errorBody,
  pageLabel,
  prevLabel,
  nextLabel,
  zoomInLabel,
  zoomOutLabel,
  fitWidthLabel
}: {
  bytes: Uint8Array
  errorTitle: string
  errorBody: string
  pageLabel: (page: number, total: number) => string
  prevLabel: string
  nextLabel: string
  zoomInLabel: string
  zoomOutLabel: string
  fitWidthLabel: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [loadedBytes, setLoadedBytes] = useState(bytes)
  const [page, setPage] = useState(1)
  const [pageDraft, setPageDraft] = useState('1')
  const [pageCount, setPageCount] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [containerWidth, setContainerWidth] = useState(0)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)

  if (bytes !== loadedBytes) {
    setLoadedBytes(bytes)
    setPage(1)
    setPageDraft('1')
    setPageCount(0)
    setZoom(1)
    setError(false)
    setLoading(true)
  }

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
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
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
    const container = scrollRef.current
    if (!container || loading || error) return
    const measure = (): void => setContainerWidth(container.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [error, loading])

  useEffect(() => {
    const container = scrollRef.current
    if (container) {
      container.scrollTop = 0
      container.scrollLeft = 0
    }
  }, [page])

  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || page < 1 || page > pageCount || loading) return
    let cancelled = false

    void (async () => {
      try {
        const pdfPage = await doc.getPage(page)
        if (cancelled) return
        const baseViewport = pdfPage.getViewport({ scale: 1 })
        const availableWidth = Math.max(280, containerWidth - 32)
        const fitScale = Math.min(2, Math.max(0.4, availableWidth / baseViewport.width))
        const cssScale = fitScale * zoom
        const outputScale = Math.min(window.devicePixelRatio || 1, 2)
        const cssViewport = pdfPage.getViewport({ scale: cssScale })
        const renderViewport = pdfPage.getViewport({ scale: cssScale * outputScale })
        const context = canvas.getContext('2d')
        if (!context) return

        canvas.width = Math.floor(renderViewport.width)
        canvas.height = Math.floor(renderViewport.height)
        canvas.style.width = `${Math.floor(cssViewport.width)}px`
        canvas.style.height = `${Math.floor(cssViewport.height)}px`
        renderTaskRef.current?.cancel()
        const task = pdfPage.render({ canvasContext: context, viewport: renderViewport, canvas })
        renderTaskRef.current = task
        await task.promise
      } catch (cause) {
        if (cancelled || isPdfRenderCancelled(cause)) return
        setError(true)
      }
    })()

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [page, pageCount, loading, bytes, containerWidth, zoom])

  const goToPage = (next: number): void => {
    const clamped = Math.min(pageCount, Math.max(1, next))
    setPage(clamped)
    setPageDraft(String(clamped))
  }

  const commitPageDraft = (): void => {
    const parsed = Number.parseInt(pageDraft, 10)
    if (Number.isNaN(parsed)) {
      setPageDraft(String(page))
      return
    }
    goToPage(parsed)
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="min-h-80 flex-1" />
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
      <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-bg px-2.5 py-1.5">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={prevLabel}
            disabled={page <= 1}
            onClick={() => goToPage(page - 1)}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <div className="nums flex h-7 items-center gap-1 rounded-md border bg-field px-1.5 text-[12px] text-ink-muted shadow-field-inset">
            <input
              value={pageDraft}
              inputMode="numeric"
              aria-label={pageLabel(page, pageCount)}
              className="w-7 bg-transparent text-center text-ink outline-none"
              onChange={(event) => setPageDraft(event.target.value.replace(/\D/g, ''))}
              onBlur={commitPageDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitPageDraft()
                  event.currentTarget.blur()
                }
                if (event.key === 'Escape') {
                  setPageDraft(String(page))
                  event.currentTarget.blur()
                }
              }}
            />
            <span aria-hidden>/</span>
            <span>{pageCount}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={nextLabel}
            disabled={page >= pageCount}
            onClick={() => goToPage(page + 1)}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={zoomOutLabel}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP))}
          >
            <ZoomOut className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="nums h-7 min-w-16 px-1.5 text-[11.5px]"
            aria-label={fitWidthLabel}
            title={fitWidthLabel}
            onClick={() => setZoom(1)}
          >
            <Maximize2 className="size-3.5" aria-hidden />
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={zoomInLabel}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP))}
          >
            <ZoomIn className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        role="region"
        tabIndex={0}
        aria-label={pageLabel(page, pageCount)}
        className="min-h-0 flex-1 overflow-auto bg-panel/60 p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/25"
      >
        <div className="mx-auto w-fit min-w-fit">
          <canvas ref={canvasRef} className="block bg-white shadow-sm ring-1 ring-border-card" />
        </div>
      </div>
    </div>
  )
}

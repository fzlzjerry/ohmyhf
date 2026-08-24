import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ToastVariant = 'info' | 'success' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  /** ms; `null` keeps the toast until dismissed. Defaults: error 5s, others 2.5s. */
  duration?: number | null
  action?: ToastAction
  /** Reuse an id to replace an existing toast (dedupe) and restart its timer. */
  id?: number
}

interface Toast {
  id: number
  message: string
  variant: ToastVariant
  duration: number | null
  action?: ToastAction
  /** Bumped on replace so the card remounts and its timer restarts. */
  nonce: number
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, variant?: ToastVariant, options?: ToastOptions) => number
  dismiss: (id: number) => void
}

const MAX_STACK = 4
let nextId = 1

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (message, variant = 'info', options = {}) => {
    const id = options.id ?? nextId++
    const duration =
      options.duration !== undefined ? options.duration : variant === 'error' ? 5000 : 2500
    const toast: Toast = { id, message, variant, duration, action: options.action, nonce: nextId++ }
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.id !== id), toast].slice(-MAX_STACK) }))
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** Undo toast: 5s window, action reverses the operation just performed. */
export function pushUndo(message: string, action: ToastAction): number {
  return useToasts.getState().push(message, 'info', { duration: 5000, action })
}

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: CircleAlert
} as const

function ToastCard({ toast }: { toast: Toast }): React.JSX.Element {
  const { t } = useTranslation('common')
  const dismiss = useToasts((s) => s.dismiss)
  const Icon = ICONS[toast.variant]
  // Timer pauses while hovered/focused so errors and undo offers can be read.
  const remaining = useRef<number | null>(toast.duration)
  const startedAt = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  const resume = useCallback((): void => {
    if (remaining.current === null || timer.current !== undefined) return
    startedAt.current = Date.now()
    timer.current = window.setTimeout(() => dismiss(toast.id), remaining.current)
  }, [dismiss, toast.id])

  const pause = useCallback((): void => {
    if (remaining.current === null || timer.current === undefined) return
    window.clearTimeout(timer.current)
    timer.current = undefined
    remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt.current))
  }, [])

  useEffect(() => {
    resume()
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [resume])

  return (
    <div
      role={toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocusCapture={pause}
      onBlurCapture={resume}
      // Toasts float above modals. Keep their pointer interactions from bubbling
      // to a Radix DismissableLayer (dialog/dropdown/popover), which would
      // otherwise treat a toast click as an outside click and close the layer.
      onPointerDown={(e) => e.stopPropagation()}
      className="animate-toast-in pointer-events-auto flex items-start gap-2 rounded-lg border bg-elevated p-3 text-[13px] text-ink shadow-overlay"
    >
      <Icon
        className={cn(
          'mt-px size-4 shrink-0',
          toast.variant === 'success' && 'text-success',
          toast.variant === 'error' && 'text-error',
          toast.variant === 'info' && 'text-info'
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 break-words">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick()
            dismiss(toast.id)
          }}
          className="-my-0.5 shrink-0 rounded-md px-2 py-0.5 text-[12px] font-semibold text-link transition-colors duration-150 hover:bg-panel-2"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t('dismiss')}
        onClick={() => dismiss(toast.id)}
        className="-m-1 shrink-0 rounded-md p-1 text-ink-faint transition-colors duration-150 hover:bg-panel-2 hover:text-ink"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

export function Toaster({ children }: { children?: ReactNode }): React.JSX.Element {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
      {children}
      {toasts.map((toast) => (
        <ToastCard key={`${toast.id}:${toast.nonce}`} toast={toast} />
      ))}
    </div>
  )
}

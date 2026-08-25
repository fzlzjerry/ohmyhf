import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-px text-[11.5px] font-medium leading-4 tracking-[-0.01em] whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border bg-linear-to-b from-btn-from to-btn-to text-ink-muted',
        select: 'bg-select/10 text-select border border-select/25',
        brand: 'bg-brand text-brand-ink border border-transparent font-semibold',
        success: 'bg-success/10 text-success-ink border border-success/25',
        warning: 'bg-warning/15 text-ink border border-warning/40',
        error: 'bg-error/10 text-error border border-error/25',
        outline: 'border text-ink-muted'
      }
    },
    defaultVariants: { variant: 'neutral' }
  }
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

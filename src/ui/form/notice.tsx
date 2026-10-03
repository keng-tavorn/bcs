import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'

// An inline message next to the thing it is about (errors are never toast-only, §9.9). Icon + words + a left rule;
// danger is announced immediately (role=alert), the others politely (role=status). warning: the action was saved
// but something after it did not happen (an e-mail that was not sent) and the message says what to do.
const TONES = {
  info: { Icon: Info, rule: 'border-info', icon: 'text-info' },
  success: { Icon: CircleCheck, rule: 'border-primary', icon: 'text-primary' },
  warning: { Icon: TriangleAlert, rule: 'border-warn', icon: 'text-warn' },
  danger: { Icon: CircleAlert, rule: 'border-danger', icon: 'text-danger' },
} as const

export function Notice({ tone = 'info', children, className }: { tone?: keyof typeof TONES; children: ReactNode; className?: string }) {
  const { Icon, rule, icon } = TONES[tone]
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-2 border-l-4 bg-surface px-3 py-2.5 text-ink', rule, className)}>
      <Icon className={cn('mt-1 size-4 shrink-0', icon)} aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

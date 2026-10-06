import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
// Joined without tailwind-merge (§9.4): a request's list of files draws this notice on LIFF pages too, whose first
// JavaScript is at most 200 KB gzip, and none of its classes sets what another sets (tests/unit/liff-classes.test.tsx)
import { cn } from '../liff/cn'

// An inline message next to the thing it is about (errors are never toast-only, §9.9). Icon + words + a left rule;
// danger is announced immediately (role=alert), the others politely (role=status). warning: the action was saved
// but something after it did not happen (an e-mail that was not sent) and the message says what to do. Where a page
// states how something stands in danger's colour — a task that was not approved, drawn as its timeline draws it —
// rather than reporting an error just made, it stays a status (`role`), as LIFF's twin does (src/ui/liff/notice.tsx).
const TONES = {
  info: { Icon: Info, rule: 'border-info', icon: 'text-info' },
  success: { Icon: CircleCheck, rule: 'border-primary', icon: 'text-primary' },
  warning: { Icon: TriangleAlert, rule: 'border-warn', icon: 'text-warn' },
  danger: { Icon: CircleAlert, rule: 'border-danger', icon: 'text-danger' },
} as const

export function Notice({
  tone = 'info',
  role,
  children,
  className,
}: {
  tone?: keyof typeof TONES
  /** By default alert for danger and status for the others; status for a state the page shows, not an error just made */
  role?: 'status' | 'alert'
  children: ReactNode
  className?: string
}) {
  const { Icon, rule, icon } = TONES[tone]
  return (
    <div role={role ?? (tone === 'danger' ? 'alert' : 'status')} className={cn('flex items-start gap-2 border-l-4 bg-surface px-3 py-2.5 text-ink', rule, className)}>
      <Icon className={cn('mt-1 size-4 shrink-0', icon)} aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

import type { ReactNode } from 'react'
import { cn } from './cn'

// The inline message of LIFF pages: the same look, words-first rule and roles as the workspace's src/ui/form/notice.tsx
// (an icon and words, never colour alone, NFR-A11Y-03; a left rule; danger is announced at once with role=alert, the
// others politely with role=status). Where a page states how something stands in danger's colour — a task that was not
// approved, drawn as its timeline draws it — rather than reporting an error just made, it stays a status (`role`).
// Its four icons are drawn inline from Lucide's path data (lucide-react 1.49, ISC
// License, Copyright (c) Lucide Icons and Contributors): lucide-react draws through its Icon client component, which a
// LIFF page would carry in its first JavaScript (§9.4: at most 200 KB gzip). Use it in every LIFF page and component.

const CIRCLE = <circle cx="12" cy="12" r="10" />

const TONES = {
  info: {
    rule: 'border-info',
    color: 'text-info',
    shape: (
      <>
        {CIRCLE}
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </>
    ),
  },
  success: {
    rule: 'border-primary',
    color: 'text-primary',
    shape: (
      <>
        {CIRCLE}
        <path d="m16 9-5.5 5.5L8 12" />
      </>
    ),
  },
  warning: {
    rule: 'border-warn',
    color: 'text-warn',
    shape: (
      <>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>
    ),
  },
  danger: {
    rule: 'border-danger',
    color: 'text-danger',
    shape: (
      <>
        {CIRCLE}
        <line x1="12" x2="12" y1="8" y2="12" />
        <line x1="12" x2="12.01" y1="16" y2="16" />
      </>
    ),
  },
} as const

export type LiffNoticeTone = keyof typeof TONES

/** The icon of a tone, 16 px, decorative (the words beside it say what it means) */
export function NoticeIcon({ tone, className }: { readonly tone: LiffNoticeTone; readonly className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('mt-1 size-4 shrink-0', TONES[tone].color, className)}
      aria-hidden="true"
      focusable="false"
    >
      {TONES[tone].shape}
    </svg>
  )
}

export function LiffNotice({
  tone = 'info',
  role,
  children,
  className,
}: {
  readonly tone?: LiffNoticeTone
  /** By default alert for danger and status for the others; status for a state the page shows, not an error just made */
  readonly role?: 'status' | 'alert'
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <div role={role ?? (tone === 'danger' ? 'alert' : 'status')} className={cn('flex items-start gap-2 border-l-4 bg-surface px-3 py-2.5 text-ink', TONES[tone].rule, className)}>
      <NoticeIcon tone={tone} />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

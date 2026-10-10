import { createElement } from 'react'
import { cn } from '../cn'

// The status of a goods receipt or a variance on the LIFF receiving page (/liff/gr/[poId]): an icon and
// words, never colour alone (NFR-A11Y-03), with the same icons and tones as the workspace's src/ui/receiving/status.tsx.
// The icons are plain SVG from Lucide's path data (lucide-react 1.49, ISC License, Copyright (c) Lucide Icons and
// Contributors): lucide-react draws through its Icon client component, which a LIFF page would carry in its first
// JavaScript (§9.4: 200 KB gzip). Markup only: rendered by a server component it costs the page no JavaScript. The PO's
// own status is the badge of §9.10 (../status-badge.tsx), as on the workspace's page.

type Shape =
  | readonly ['path', { readonly d: string }]
  | readonly ['circle', { readonly cx: string; readonly cy: string; readonly r: string }]
  | readonly ['line', { readonly x1: string; readonly x2: string; readonly y1: string; readonly y2: string }]

const CIRCLE: Shape = ['circle', { cx: '12', cy: '12', r: '10' }]

export const MARK_SHAPES = {
  filePen: [
    ['path', { d: 'M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34' }],
    ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
    ['path', { d: 'M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z' }],
  ],
  clock: [CIRCLE, ['path', { d: 'M12 6v6l4 2' }]],
  circleCheck: [CIRCLE, ['path', { d: 'm16 9-5.5 5.5L8 12' }]],
  circleX: [CIRCLE, ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
  ban: [CIRCLE, ['path', { d: 'M4.929 4.929 19.07 19.071' }]],
  packageOpen: [
    ['path', { d: 'M12 22v-9' }],
    ['path', { d: 'M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.655 1.655 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z' }],
    ['path', { d: 'M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13' }],
    ['path', { d: 'M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.2a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.636 1.636 0 0 0 1.63 0z' }],
  ],
  packageCheck: [
    ['path', { d: 'M12 22V12' }],
    ['path', { d: 'm16 17 2 2 4-4' }],
    ['path', { d: 'M21 11.127V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.32-.753' }],
    ['path', { d: 'M3.29 7 12 12l8.71-5' }],
    ['path', { d: 'm7.5 4.27 8.997 5.148' }],
  ],
  undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }]],
  send: [
    ['path', { d: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z' }],
    ['path', { d: 'm21.854 2.147-10.94 10.939' }],
  ],
} as const satisfies Record<string, readonly Shape[]>

export type MarkShape = keyof typeof MARK_SHAPES

/** One icon of the set, decorative (the words beside it say what it means) */
export function MarkIcon({ shape, className }: { readonly shape: MarkShape; readonly className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4 shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      {(MARK_SHAPES[shape] as readonly Shape[]).map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}
    </svg>
  )
}

type Look = { readonly shape: MarkShape; readonly tone: string }
const FALLBACK: Look = { shape: 'filePen', tone: 'text-ink-muted' }

const LOOKS: Readonly<Record<'receipt' | 'variance', Readonly<Record<string, Look>>>> = {
  receipt: {
    DRAFT: { shape: 'filePen', tone: 'text-ink-muted' },
    POSTED: { shape: 'packageCheck', tone: 'text-primary' },
    REVERSED: { shape: 'undo', tone: 'text-warn' },
  },
  variance: {
    RECORDED: { shape: 'send', tone: 'text-info' },
    PENDING_APPROVAL: { shape: 'clock', tone: 'text-warn' },
    APPROVED: { shape: 'circleCheck', tone: 'text-primary' },
    REJECTED: { shape: 'circleX', tone: 'text-danger' },
  },
}

/** A status: its icon in the status's tone, and the translated label */
export function LiffStatusMark({ of, status, label, className }: { readonly of: 'receipt' | 'variance'; readonly status: string; readonly label: string; readonly className?: string }) {
  const look = LOOKS[of][status] ?? FALLBACK
  return (
    <span className={cn('inline-flex items-start gap-1.5 font-medium', className)}>
      <MarkIcon shape={look.shape} className={cn('mt-[0.35em]', look.tone)} />
      <span>{label}</span>
    </span>
  )
}

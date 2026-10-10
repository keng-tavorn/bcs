import { createElement } from 'react'
import { FALLBACK_BADGE, type BadgeIcon, type BadgeTone } from '../document/badge-looks'
import { cn } from './cn'

// The status badges of §9.10 on LIFF pages (S16-11): the same table as the workspace (../document/badge-looks.ts), the
// same light background with its ink and the same icon next to the word (never colour alone, NFR-A11Y-03) — drawn
// without the workspace's shadcn/ui Badge, tailwind-merge or lucide-react (ADR-052, FR-PLT-013 AC5). lucide-react draws
// through its Icon client component, which would count in the page's first JavaScript (§9.4: 200 KB gzip); these icons
// are plain SVG from Lucide's path data (lucide-react 1.49, ISC License, Copyright (c) Lucide Icons and Contributors), so
// a server component draws the badge with no JavaScript at all. 16 px words, as everywhere on LIFF (§9.4).

type Shape =
  | readonly ['path', { readonly d: string }]
  | readonly ['circle', { readonly cx: string; readonly cy: string; readonly r: string }]
  | readonly ['line', { readonly x1: string; readonly x2: string; readonly y1: string; readonly y2: string }]
  | readonly ['rect', { readonly width: string; readonly height: string; readonly x: string; readonly y: string; readonly rx: string; readonly ry: string }]

const CIRCLE: Shape = ['circle', { cx: '12', cy: '12', r: '10' }]

/** The icons of §9.10's table, and the two of a delegation's state (src/ui/delegation/delegation-state.tsx) */
export type LiffBadgeIcon = BadgeIcon | 'CircleMinus' | 'CircleSlash'

const ICONS = {
  AlarmClock: [
    ['circle', { cx: '12', cy: '13', r: '8' }],
    ['path', { d: 'M12 9v4l2 2' }],
    ['path', { d: 'M5 3 2 6' }],
    ['path', { d: 'm22 6-3-3' }],
    ['path', { d: 'M6.38 18.7 4 21' }],
    ['path', { d: 'M17.64 18.67 20 21' }],
  ],
  Ban: [CIRCLE, ['path', { d: 'M4.929 4.929 19.07 19.071' }]],
  CircleCheck: [CIRCLE, ['path', { d: 'm16 9-5.5 5.5L8 12' }]],
  CircleCheckBig: [['path', { d: 'M21.801 10A10 10 0 1 1 17 3.335' }], ['path', { d: 'm9 11 3 3L22 4' }]],
  CircleDot: [['circle', { cx: '12', cy: '12', r: '1' }], CIRCLE],
  CircleMinus: [CIRCLE, ['path', { d: 'M8 12h8' }]],
  CircleSlash: [CIRCLE, ['line', { x1: '9', x2: '15', y1: '15', y2: '9' }]],
  CircleX: [CIRCLE, ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
  Clock: [CIRCLE, ['path', { d: 'M12 6v6l4 2' }]],
  FilePen: [
    ['path', { d: 'M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34' }],
    ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
    ['path', { d: 'M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z' }],
  ],
  Hourglass: [
    ['path', { d: 'M5 22h14' }],
    ['path', { d: 'M5 2h14' }],
    ['path', { d: 'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22' }],
    ['path', { d: 'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2' }],
  ],
  Lock: [['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]],
  MessageCircleQuestion: [
    ['path', { d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719' }],
    ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  PackageCheck: [
    ['path', { d: 'M12 22V12' }],
    ['path', { d: 'm16 17 2 2 4-4' }],
    ['path', { d: 'M21 11.127V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.32-.753' }],
    ['path', { d: 'M3.29 7 12 12l8.71-5' }],
    ['path', { d: 'm7.5 4.27 8.997 5.148' }],
  ],
  Send: [
    ['path', { d: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z' }],
    ['path', { d: 'm21.854 2.147-10.94 10.939' }],
  ],
  ShoppingCart: [
    ['path', { d: 'm2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18' }],
    ['path', { d: 'M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25' }],
    ['circle', { cx: '18', cy: '20', r: '2' }],
    ['circle', { cx: '8', cy: '20', r: '2' }],
  ],
  Undo2: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }]],
  Wallet: [
    ['path', { d: 'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1' }],
    ['path', { d: 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4' }],
  ],
  Zap: [
    ['path', { d: 'M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z' }],
  ],
} as const satisfies Record<LiffBadgeIcon, readonly Shape[]>

/** The colour pair of each tone (§9.10 token ส่วนขยาย), the same classes as the workspace Badge's variants */
const TONES = {
  ok: 'bg-ok-bg text-ok-ink',
  warn: 'bg-warn-bg text-warn-ink',
  danger: 'bg-danger-bg text-danger-ink',
  info: 'bg-info-bg text-info-ink',
  neutral: 'bg-neutral-bg text-neutral-ink',
} as const satisfies Record<BadgeTone, string>

export interface LiffBadgeLook {
  readonly tone: BadgeTone
  readonly icon: LiffBadgeIcon | null
}

/** A status as a badge of §9.10: the tone's light background and ink, its icon (decorative) and the translated word */
export function LiffStatusBadge({ look, label, className }: { readonly look: LiffBadgeLook | undefined; readonly label: string; readonly className?: string }) {
  const { tone, icon } = look ?? FALLBACK_BADGE
  return (
    <span data-slot="badge" data-tone={tone} className={cn('inline-flex w-fit max-w-full items-center gap-1.5 rounded-4xl px-2.5 py-0.5 text-base font-medium', TONES[tone], className)}>
      {icon ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4 shrink-0"
          aria-hidden="true"
          focusable="false"
          data-icon={icon}
        >
          {(ICONS[icon] as readonly Shape[]).map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}
        </svg>
      ) : null}
      <span className="min-w-0 break-words">{label}</span>
    </span>
  )
}

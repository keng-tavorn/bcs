import { createElement } from 'react'
import { cn } from '../../cn'

// The state of a delegation on /liff/delegation as an icon and words, never colour alone (NFR-A11Y-03), with the icons and
// tones of the workspace's src/ui/delegation/delegation-state.tsx drawn as plain SVG from Lucide's path data (lucide-react
// 1.49, ISC License, Copyright (c) Lucide Icons and Contributors): lucide-react's Icon client component would count in
// the LIFF page's first JavaScript (§9.4: 200 KB gzip). Rendered by the server; the label arrives translated.

type Shape = readonly ['path', { readonly d: string }] | readonly ['circle', { readonly cx: string; readonly cy: string; readonly r: string }] | readonly ['line', { readonly x1: string; readonly x2: string; readonly y1: string; readonly y2: string }]

const CIRCLE: Shape = ['circle', { cx: '12', cy: '12', r: '10' }]

const LOOK = {
  ACTIVE: { shapes: [CIRCLE, ['path', { d: 'm16 9-5.5 5.5L8 12' }]], tone: 'text-primary' },
  SCHEDULED: { shapes: [CIRCLE, ['path', { d: 'M12 6v6l4 2' }]], tone: 'text-warn' },
  ENDED: { shapes: [CIRCLE, ['path', { d: 'M8 12h8' }]], tone: 'text-ink-muted' },
  REVOKED: { shapes: [CIRCLE, ['line', { x1: '9', x2: '15', y1: '15', y2: '9' }]], tone: 'text-ink-muted' },
} as const satisfies Record<string, { readonly shapes: readonly Shape[]; readonly tone: string }>

export type LiffDelegationState = keyof typeof LOOK

export function LiffDelegationStateMark({ state, label, className }: { readonly state: LiffDelegationState; readonly label: string; readonly className?: string }) {
  const { shapes, tone } = LOOK[state]
  return (
    <span className={cn('inline-flex shrink-0 items-start gap-1.5 font-medium', className)}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn('mt-[0.35em] size-4 shrink-0', tone)}
        aria-hidden="true"
        focusable="false"
      >
        {(shapes as readonly Shape[]).map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}
      </svg>
      <span>{label}</span>
    </span>
  )
}

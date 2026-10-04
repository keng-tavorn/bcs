import { createElement } from 'react'
import { cn } from '../cn'

// The icons of LIFF pages as plain SVG, from Lucide's path data (lucide-react 1.49, ISC License, Copyright (c) Lucide
// Icons and Contributors). lucide-react draws every icon through its Icon client component, so a LIFF page that used
// one — even from a server component — would carry lucide's client code in its first JavaScript (§9.4: at most 200 KB
// gzip). These are markup only: rendered by a server component they cost the page no JavaScript at all. Same 24-unit
// grid, stroke and caps as lucide-react's defaults; always decorative (the words next to them say what they mean). The
// icons of a message (info, success, warning, danger) are in ./notice.tsx.

type Shape =
  | readonly ['path', { readonly d: string }]
  | readonly ['circle', { readonly cx: string; readonly cy: string; readonly r: string }]
  | readonly ['rect', { readonly width: string; readonly height: string; readonly x: string; readonly y: string; readonly rx: string; readonly ry: string }]

const ICONS = {
  chevronLeft: [['path', { d: 'm15 18-6-6 6-6' }]],
  shoppingCart: [
    ['path', { d: 'm2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18' }],
    ['path', { d: 'M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25' }],
    ['circle', { cx: '18', cy: '20', r: '2' }],
    ['circle', { cx: '8', cy: '20', r: '2' }],
  ],
  clipboardCheck: [
    ['rect', { width: '8', height: '4', x: '8', y: '2', rx: '1', ry: '1' }],
    ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }],
    ['path', { d: 'm9 14 2 2 4-4' }],
  ],
  packageSearch: [
    ['path', { d: 'M12 22V12' }],
    ['path', { d: 'M20.27 18.27 22 20' }],
    ['path', { d: 'M21 10.498V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.98-.559' }],
    ['path', { d: 'M3.29 7 12 12l8.71-5' }],
    ['path', { d: 'm7.5 4.27 8.997 5.148' }],
    ['circle', { cx: '18.5', cy: '16.5', r: '2.5' }],
  ],
  circleHelp: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }], ['path', { d: 'M12 17h.01' }]],
} as const satisfies Record<string, readonly Shape[]>

export type LiffIconName = keyof typeof ICONS

export function LiffIcon({ name, className }: { readonly name: LiffIconName; readonly className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-5 shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      {(ICONS[name] as readonly Shape[]).map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}
    </svg>
  )
}

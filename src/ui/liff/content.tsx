import type { ReactNode } from 'react'
import { cn } from '../cn'

// The content column of a LIFF page (§9.4, §9.9) — what a client component of a LIFF page may import without pulling in
// the frame's top bar (./frame.tsx re-exports all of this for server pages). One column for a phone in the LINE app:
// 16 px side gutters that keep clear of the notch and rounded corners (safe-area insets: the layout asks for
// viewport-fit=cover); at most 36rem wide on a wider screen.

/** Side gutters: 16 px, or the safe-area inset when that is wider (a phone held sideways) */
export const LIFF_GUTTER = 'pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]'
/** The width of the LIFF column on a wider screen (a tablet, LINE on a computer, or LIFF opened in a desktop browser) */
export const LIFF_COLUMN = 'mx-auto w-full max-w-xl'

/** The content column of a LIFF page: grows to push the action bar to the bottom of a short page */
export function LiffContent({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cn(LIFF_COLUMN, LIFF_GUTTER, 'flex flex-1 flex-col gap-6 pt-5 pb-8', className)}>{children}</div>
}

/** A titled part of a LIFF page: a heading (h2) and what belongs to it, set off by a rule */
export function LiffSection({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-line pt-5">
      <h2 id={id} className="text-lg leading-snug font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

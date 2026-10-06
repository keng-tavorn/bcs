import type { ReactNode } from 'react'
import { cn } from './cn'
import { LIFF_COLUMN, LIFF_GUTTER } from './content'
import { LiffIcon } from './icons'
import { LiffLink } from './liff-link'

// The frame of a LIFF page (§9.4, §9.9): one column for a phone in the LINE app — no workspace menu, a small top bar with
// the page title and, where useful, a back link; 16 px text whatever the width, the workspace parts it draws included
// (liff-type, src/app/globals.css), at line height 1.6; headings told apart by size and weight — the page title 20 px, a
// section's 18 px (LiffSection), a part's 16 px; the top bar keeps clear of the notch (safe-area inset). Flat surfaces
// and rules, no cards or shadows. A server page renders <LiffFrame>, puts its content
// in <LiffContent> and, when it decides something, its buttons in <LiffActionBar> (./action-bar.tsx) right after it, so
// the bar sits at the bottom of the screen. Client components import the content column from ./content.tsx, not from
// here, so the top bar stays out of their JavaScript. Nothing here pulls a client library into the page
// (./liff-link.tsx, ./icons.tsx: §9.4 allows 200 KB gzip of first JavaScript).

export { LIFF_COLUMN, LIFF_GUTTER, LiffContent, LiffSection } from './content'

export interface LiffFrameProps {
  /** The page title (h1) */
  readonly title: string
  /** A back link to the LIFF page this one belongs to, when there is one */
  readonly back?: { readonly href: string; readonly label: string }
  readonly children: ReactNode
}

export function LiffFrame({ title, back, children }: LiffFrameProps) {
  return (
    <div className="liff-type flex min-h-dvh flex-col bg-bg text-base text-ink">
      <header className="border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
        <div className={cn(LIFF_COLUMN, LIFF_GUTTER, 'flex min-h-14 items-center gap-1 py-1.5')}>
          {back ? (
            <LiffLink
              href={back.href}
              className="-ml-2 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-primary underline-offset-4 hover:underline"
            >
              <LiffIcon name="chevronLeft" />
              <span>{back.label}</span>
            </LiffLink>
          ) : null}
          <h1 className="min-w-0 flex-1 text-xl font-semibold">{title}</h1>
        </div>
      </header>
      <main id="content" className="flex flex-1 flex-col">
        {children}
      </main>
    </div>
  )
}

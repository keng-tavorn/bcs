import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLinks, type NavEntry } from './nav-links'

// Workspace frame (§9.9): menu on the left on wide screens, a menu button on phones; content at most 1280 px wide.
// Flat surfaces separated by rules — no cards, shadows or decoration. Strings arrive translated.

export interface WorkspaceShellProps {
  readonly brand: string
  readonly orgName: string
  readonly userLine: string
  readonly labels: { readonly skipToContent: string; readonly menu: string; readonly mainNav: string }
  readonly nav: readonly NavEntry[]
  readonly account: ReactNode
  readonly children: ReactNode
}

function Brand({ brand, orgName }: { brand: string; orgName: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xl font-bold text-ink">{brand}</span>
      <span className="text-base text-ink-muted md:text-sm">{orgName}</span>
    </div>
  )
}

export function WorkspaceShell({ brand, orgName, userLine, labels, nav, account, children }: WorkspaceShellProps) {
  return (
    <div className="min-h-dvh bg-bg lg:grid lg:grid-cols-[17rem_1fr]">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-bg focus:px-3 focus:py-2"
      >
        {labels.skipToContent}
      </a>

      <aside className="hidden border-r border-line bg-surface lg:flex lg:min-h-dvh lg:flex-col lg:gap-6 lg:px-3 lg:py-5">
        <div className="px-3">
          <Brand brand={brand} orgName={orgName} />
        </div>
        <nav aria-label={labels.mainNav} className="flex-1">
          <NavLinks entries={nav} />
        </nav>
        <div className="flex flex-col gap-3 border-t border-line px-3 pt-4">
          <p className="text-base text-ink-muted md:text-sm">{userLine}</p>
          {account}
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="relative border-b border-line bg-surface lg:hidden">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <Brand brand={brand} orgName={orgName} />
              <span className="inline-flex min-h-11 items-center gap-1 rounded-md border border-input bg-bg px-3 font-medium text-ink">
                {labels.menu}
                <ChevronDown className="size-4 transition-transform duration-150 group-open:rotate-180" aria-hidden="true" />
              </span>
            </summary>
            <div className="absolute inset-x-0 top-full z-20 flex max-h-[80dvh] flex-col gap-5 overflow-y-auto border-b border-line bg-surface px-3 py-4">
              <nav aria-label={labels.mainNav}>
                <NavLinks entries={nav} />
              </nav>
              <div className="flex flex-col gap-3 border-t border-line px-3 pt-4">
                <p className="text-ink-muted">{userLine}</p>
                {account}
              </div>
            </div>
          </details>
        </header>

        <main id="content" className="mx-auto w-full max-w-[1280px] px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  )
}

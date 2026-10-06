import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLinks, type NavEntry } from './nav-links'
import { NewRequestDoor } from './new-request-door'
import { SHELL_PANELS } from './panels'

// Workspace frame (§9.9): menu on the left on wide screens, a menu button on phones; content at most 1280 px wide; the
// one door "ขอซื้อ / ขอจ้าง" as the main button on every page (principle 2): in the bar above the content beside the
// bell on a wide screen, in a row of its own under the header on a phone. Flat surfaces separated by rules — no cards,
// shadows or decoration. Strings arrive translated.

export interface WorkspaceShellProps {
  readonly brand: string
  readonly orgName: string
  readonly userLine: string
  readonly labels: { readonly skipToContent: string; readonly menu: string; readonly mainNav: string }
  readonly nav: readonly NavEntry[]
  readonly account: ReactNode
  /** The notification bell, shown in the phone header and in the bar above the content on wide screens */
  readonly bell?: ReactNode
  /** The door to a new request, for a member who may create one (the menu's newRequest entry) */
  readonly newRequest?: { readonly href: string; readonly label: string }
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

export function WorkspaceShell({ brand, orgName, userLine, labels, nav, account, bell, newRequest, children }: WorkspaceShellProps) {
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
        <header className="relative flex items-center gap-2 border-b border-line bg-surface pr-4 lg:hidden">
          {/* The menu and the bell are one group (SHELL_PANELS): opening one closes the other, so no panel opens over another */}
          <details name={SHELL_PANELS} className="group min-w-0 flex-1">
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
          {bell}
        </header>
        {/* A phone has no room for the door beside the menu and the bell: it gets a row of its own, outside the menu */}
        {newRequest ? <NewRequestDoor href={newRequest.href} label={newRequest.label} className="border-b border-line bg-surface px-4 py-2 lg:hidden" linkClassName="w-full" /> : null}
        {bell || newRequest ? (
          <div className="hidden items-center justify-end gap-3 border-b border-line px-8 py-3 lg:flex">
            {newRequest ? <NewRequestDoor href={newRequest.href} label={newRequest.label} /> : null}
            {bell}
          </div>
        ) : null}

        <main id="content" className="mx-auto w-full max-w-[1280px] px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  )
}

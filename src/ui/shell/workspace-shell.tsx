import type { ReactNode } from 'react'
import { Sidebar, SidebarHeader, SidebarTrigger } from '../shadcn/sidebar'
import { NavLinks, type NavEntry } from './nav-links'
import { NewRequestDoor } from './new-request-door'
import { ShellBreadcrumb, type TrailEntry } from './shell-breadcrumb'
import { ShellFrame } from './shell-frame'
import { UserMenu } from './user-menu'

// Workspace frame (§9.9 §9.10, FR-PLT-013 AC2–AC4): the dark green sidebar on the left (256 px, collapsed to 64 px of
// icons; a sheet from the left below 1024 px), and a 56 px top bar over the content — the sidebar's toggle, the trail of
// a deeper page, the ⌘K search, the bell, the one door "ขอซื้อ / ขอจ้าง" and the user menu. A phone's bar has room for
// the door but not the user menu, which moves to the foot of the menu sheet (§9.10 puts it at the sidebar's foot).
// Content is at most 1280 px wide with 24 px sides (16 px on a phone). Strings arrive translated.

export interface WorkspaceShellProps {
  readonly brand: string
  readonly orgName: string
  readonly labels: { readonly skipToContent: string; readonly mainNav: string; readonly account: string }
  /** The sidebar's entries, in their groups (menu.ts SIDEBAR_GROUPS) */
  readonly nav: readonly NavEntry[]
  /** Every page of the member's menu, for the trail of a deeper page */
  readonly pages?: readonly TrailEntry[]
  /** Whether the sidebar starts open: the member's last choice (FR-PLT-013 AC2) */
  readonly sidebarOpen: boolean
  readonly user: { readonly name: string; readonly detail?: string }
  /** The user menu's content below the name: language, install, sign out */
  readonly account: ReactNode
  readonly bell?: ReactNode
  /** The door to a new request, for a member who may create one (the menu's newRequest entry) */
  readonly newRequest?: { readonly href: string; readonly label: string }
  /** The ⌘K search (FR-PLT-014): rendered once, as its keyboard shortcut listens on the whole page */
  readonly search?: ReactNode
  readonly children: ReactNode
}

export function WorkspaceShell({ brand, orgName, labels, nav, pages = [], sidebarOpen, user, account, bell, newRequest, search, children }: WorkspaceShellProps) {
  return (
    <ShellFrame defaultOpen={sidebarOpen}>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-bg focus:px-3 focus:py-2"
      >
        {labels.skipToContent}
      </a>

      <Sidebar collapsible="icon">
        <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-4 group-data-[collapsible=icon]:px-2">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary font-bold text-sidebar-primary-foreground" aria-hidden="true">
              {brand.slice(0, 1)}
            </span>
            <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:sr-only">
              <span className="font-bold">{brand}</span>
              <span className="truncate text-sm text-nav-ink-muted">{orgName}</span>
            </span>
          </div>
        </SidebarHeader>
        <NavLinks entries={nav} label={labels.mainNav} />
        {/* The user menu of a phone, at the foot of the sheet, on the page's light surface */}
        <section aria-label={labels.account} className="m-2 flex flex-col gap-3 rounded-md bg-bg p-3 text-ink md:hidden">
          <div className="flex flex-col gap-1">
            <p className="font-semibold">{user.name}</p>
            {user.detail ? <p className="text-ink-muted">{user.detail}</p> : null}
          </div>
          {account}
        </section>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-line bg-bg px-3 sm:gap-2 sm:px-4 lg:px-6">
          <SidebarTrigger className="size-11 shrink-0 lg:size-10" />
          <ShellBreadcrumb entries={pages} />
          <div className="flex min-w-0 flex-1 justify-end md:justify-start lg:px-2">{search}</div>
          {bell}
          {newRequest ? <NewRequestDoor href={newRequest.href} label={newRequest.label} /> : null}
          <div className="hidden md:block">
            <UserMenu label={labels.account} name={user.name} detail={user.detail}>
              {account}
            </UserMenu>
          </div>
        </header>

        <main id="content" className="mx-auto w-full max-w-[1280px] px-4 py-6 lg:px-6 lg:py-8">
          {children}
        </main>
      </div>
    </ShellFrame>
  )
}

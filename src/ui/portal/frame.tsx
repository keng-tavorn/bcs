import type { ReactNode } from 'react'
import { LiffContent } from '../liff/content'

// The frame of a portal page (S7-04 · ADR-184): the light set of the LIFF pages (no Workspace library · ADR-052), one
// column for a phone at 375 px, the organization's name above the page title. S7-08 builds the rest of the portal's
// components here (src/ui/portal).

export { LiffNotice as PortalNotice } from '../liff/notice'
export { Button as PortalButton } from '../liff/button'
export { inputClass as portalInputClass } from '../liff/requests/classes'

export function PortalFrame({ organization, title, children }: { readonly organization: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="border-b border-line bg-surface">
        <LiffContent className="py-3">
          <p className="text-sm text-ink-muted">{organization}</p>
          <h1 className="text-lg font-semibold">{title}</h1>
        </LiffContent>
      </header>
      <main>
        <LiffContent className="flex flex-col gap-4 py-5">{children}</LiffContent>
      </main>
    </div>
  )
}

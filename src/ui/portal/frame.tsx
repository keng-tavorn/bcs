import type { ReactNode } from 'react'
import { cn } from '../liff/cn'
import { LiffActionBar } from '../liff/action-bar'
import { LiffContent } from '../liff/content'

// The frame of a portal page (S7-04 S7-08 · ADR-184): the light set of the LIFF pages (no Workspace library · ADR-052),
// one column for a phone at 375 px, the organization's name above the page title, and the portal's sections as plain
// links under it (the page of the moment marked with aria-current). Every page is a server page whose forms post to the
// portal's route handlers, so the first JavaScript is Next.js's own and nothing more (§9.4: at most 200 KB gzip).

export { LiffNotice as PortalNotice } from '../liff/notice'
export { Button as PortalButton } from '../liff/button'
export { checkboxClass as portalCheckboxClass, inputClass as portalInputClass, primaryLinkClass as portalPrimaryLinkClass, textareaClass as portalTextareaClass } from '../liff/requests/classes'

export interface PortalNavLink {
  readonly href: string
  readonly label: string
  readonly current: boolean
}

export function PortalFrame({
  organization,
  title,
  nav,
  navLabel,
  actions,
  actionsLabel,
  children,
}: {
  readonly organization: string
  readonly title: string
  readonly nav?: readonly PortalNavLink[]
  readonly navLabel?: string
  /** The page's main action, kept at the bottom of the screen (a button of a form on the page names it with form=) */
  readonly actions?: ReactNode
  readonly actionsLabel?: string
  readonly children: ReactNode
}) {
  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="border-b border-line bg-surface">
        <LiffContent className="py-3">
          <p className="text-sm text-ink-muted">{organization}</p>
          <h1 className="text-lg font-semibold">{title}</h1>
          {nav && nav.length ? (
            <nav aria-label={navLabel} className="mt-2">
              <ul className="-mx-2 flex flex-wrap">
                {nav.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      aria-current={link.current ? 'page' : undefined}
                      className={cn('inline-flex min-h-11 items-center px-2 underline-offset-4 hover:underline', link.current ? 'font-semibold text-ink underline' : 'text-primary')}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </LiffContent>
      </header>
      <main>
        <LiffContent className="flex flex-col gap-4 py-5">{children}</LiffContent>
        {actions ? <LiffActionBar label={actionsLabel ?? title}>{actions}</LiffActionBar> : null}
      </main>
    </div>
  )
}

/** A labelled control with its hint: the label above, the hint under it, joined to the control by aria-describedby */
export function PortalField({ id, label, hint, required, requiredLabel, children }: { readonly id: string; readonly label: string; readonly hint?: string; readonly required?: boolean; readonly requiredLabel?: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">
        {label}
        {required && requiredLabel ? <span className="font-normal text-ink-muted"> ({requiredLabel})</span> : null}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Where the form is: "ขั้นที่ 2 จาก 6" and the steps as links back to the ones done (the current one is not a link) */
export function PortalSteps({ label, caption, steps }: { readonly label: string; readonly caption: string; readonly steps: readonly { readonly key: string; readonly label: string; readonly href: string | null; readonly current: boolean }[] }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-2">
      <p className="font-medium">{caption}</p>
      <ol className="flex flex-wrap gap-x-3 gap-y-1">
        {steps.map((s) =>
          s.current ? (
            <li key={s.key} aria-current="step" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {s.label}
            </li>
          ) : (
            <li key={s.key} className="inline-flex min-h-11 items-center">
              {s.href ? (
                <a href={s.href} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
                  {s.label}
                </a>
              ) : (
                <span className="text-ink-muted">{s.label}</span>
              )}
            </li>
          ),
        )}
      </ol>
    </nav>
  )
}

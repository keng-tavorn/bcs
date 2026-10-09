import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { CompactHeader } from './doc-header-parts'

// The head of a document page (FR-INT-012 AC1, §9.10 "หัว"): back, the number and the title, its status and urgency
// badges, the follow button and the menu ⋯, and one row of facts — the total, the supplier, when it was sent and how many
// business days it has taken. Scrolled past, it shrinks to one row fixed at the top (CompactHeader). The page's <h1> is
// the title alone, as before, so a screen reader hears the document's name first.

export const DOC_HEADER_ID = 'document-header'

export interface SummaryItem {
  readonly label: string
  readonly value: ReactNode
}

export interface DocHeaderProps {
  readonly back: { readonly href: string; readonly label: string } | null
  readonly number: string
  readonly title: string
  readonly badges: ReactNode
  readonly actions: ReactNode
  readonly summary: readonly SummaryItem[]
  /** The status badge again, for the one-row header */
  readonly compactBadge: ReactNode
  /** What the document's state says beyond its badge (cancelled with a reason, a bounced e-mail), under the summary */
  readonly notices?: ReactNode
}

export function DocHeader({ back, number, title, badges, actions, summary, compactBadge, notices }: DocHeaderProps) {
  return (
    <>
      <header id={DOC_HEADER_ID} className="flex flex-col gap-3">
        {back ? (
          <Link href={back.href} className="inline-flex min-h-11 items-center gap-1 self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            <ChevronLeft className="size-4" aria-hidden="true" />
            {back.label}
          </Link>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium text-ink-muted">{number}</p>
            <h1 className="text-2xl font-semibold break-words text-ink">{title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">{badges}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
        {summary.length ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-y border-line py-3 sm:flex sm:flex-wrap">
            {summary.map((item) => (
              <div key={item.label} className="flex min-w-0 flex-col">
                <dt className="text-base text-ink-muted md:text-sm">{item.label}</dt>
                <dd className="tabular font-medium break-words text-ink">{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {notices}
      </header>
      <CompactHeader targetId={DOC_HEADER_ID}>
        <span className="shrink-0 font-medium text-ink-muted">{number}</span>
        <span className="min-w-0 truncate font-semibold text-ink">{title}</span>
        <span className="ml-auto shrink-0">{compactBadge}</span>
      </CompactHeader>
    </>
  )
}

/** The page under the header: the tabs on the left and the column of 360 px on the right, below the content under 1280 px */
export function DocBody({ main, rail }: { main: ReactNode; rail: ReactNode }) {
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22.5rem] xl:items-start">
      <div className="flex min-w-0 flex-col gap-6">{main}</div>
      <aside className="flex min-w-0 flex-col gap-6">{rail}</aside>
    </div>
  )
}

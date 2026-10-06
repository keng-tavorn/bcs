import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '../cn'
import { DocumentStatus } from './badges'
import { HeldMeter } from './meter'

// The drill-down of a budget line, a department or everything shown (spec §11.2, FR-BUD-005 AC2): its amounts — each
// leading to what makes it up on the same page — the imports behind the planned amount, the documents of each bucket
// with the amount each holds, and the ledger's movements behind what is available. Wide screens line the parts up in
// columns under one header row; phones stack them with every amount in a right-hand column of its own, never a table
// that scrolls sideways (§9.9 rules 6 and the forbidden list). Strings arrive translated and formatted.

const linkClass = 'text-primary underline underline-offset-4 hover:no-underline'

export interface LineFigureView {
  readonly key: string
  readonly term: string
  readonly amount: string
  /** In-page link to what makes up the amount, 0.00 too: the section says what will show there */
  readonly href: string
  readonly linkLabel: string
}

/** The amounts in one strip: label above, amount below, right-aligned; the shares and their bar after */
export function LineFigures({
  title,
  figures,
  shares,
  unit,
}: {
  title: string
  figures: readonly LineFigureView[]
  shares: { used: string; held: string; heldBp: number; low: boolean; out?: boolean } | null
  unit: string
}) {
  return (
    <section aria-labelledby="line-figures" className="flex flex-col gap-3">
      <h2 id="line-figures" className="sr-only">
        {title}
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-line py-4 sm:grid-cols-3 lg:grid-cols-5">
        {figures.map((f) => (
          <div key={f.key} className="flex flex-col gap-0.5">
            {/* The label sits over its amount, both on the right like every column of money */}
            <dt className="text-right text-base text-ink-muted md:text-sm">{f.term}</dt>
            <dd className="money text-lg font-semibold">
              <a href={f.href} aria-label={f.linkLabel} className={linkClass}>
                {f.amount}
              </a>
              <span className="sr-only"> {unit}</span>
            </dd>
          </div>
        ))}
      </dl>
      {shares ? (
        <div className="flex max-w-xl flex-col gap-1.5">
          <p className="tabular flex flex-wrap gap-x-6 gap-y-1">
            <span>{shares.used}</span>
            <span>{shares.held}</span>
          </p>
          <HeldMeter heldBp={shares.heldBp} low={shares.low} out={shares.out} />
        </div>
      ) : null}
    </section>
  )
}

export interface DocumentRowView {
  readonly key: string
  /** "คำขอ PR-2569-00012" */
  readonly title: string
  readonly href: string | null
  /** The request's title or the PO's supplier, for a viewer who may open the document */
  readonly detail: string | null
  readonly meta: readonly string[]
  /** A request's or PO's status; none for an import */
  readonly status: { readonly kind: string; readonly label: string } | null
  readonly note: string | null
  readonly amount: string
  readonly invoices: { readonly label: string; readonly rows: ReadonlyArray<{ readonly key: string; readonly text: string; readonly amount: string }> } | null
}

export interface DocumentListLabels {
  readonly document: string
  /** The middle column: the status, or when an import came in */
  readonly status: string
  readonly amount: string
  readonly unit: string
}

const DOC_GRID = 'md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_10rem] md:items-start md:gap-4'

/** One section of documents: id is the anchor its amount links to */
export function DocumentSection({
  id,
  title,
  intro,
  rows,
  empty,
  total,
  more,
  labels,
}: {
  id: string
  title: string
  intro: string
  rows: readonly DocumentRowView[]
  empty: string
  total: string
  /** Said when the list stops before every document ("แสดง 100 จาก 240 เอกสาร ยอดมากก่อน") */
  more: string | null
  labels: DocumentListLabels
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          {title}
        </h2>
        <p className="text-ink-muted">{intro}</p>
      </div>
      {rows.length === 0 ? (
        <p className="border-y border-line py-4 text-ink-muted">{empty}</p>
      ) : (
        <div className="flex flex-col">
          <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${DOC_GRID}`} aria-hidden="true">
            <span>{labels.document}</span>
            <span>{labels.status}</span>
            <span className="text-right">{labels.amount}</span>
          </div>
          <ul aria-label={title} className="flex flex-col divide-y divide-line border-b border-line">
            {rows.map((r) => (
              <li key={r.key} className={`flex flex-col gap-1.5 py-3 ${DOC_GRID}`}>
                <div className="flex min-w-0 flex-col">
                  {r.href ? (
                    <Link href={r.href} className={cn('font-semibold break-words', linkClass)}>
                      {r.title}
                    </Link>
                  ) : (
                    <span className="font-semibold break-words">{r.title}</span>
                  )}
                  {r.detail ? <span className="break-words">{r.detail}</span> : null}
                  {r.meta.map((m) => (
                    <span key={m} className="break-words text-base text-ink-muted md:text-sm">
                      {m}
                    </span>
                  ))}
                </div>
                <div className="flex flex-col gap-0.5">
                  {r.status ? (
                    <>
                      <span className="sr-only">{labels.status}: </span>
                      <DocumentStatus status={r.status.kind} label={r.status.label} />
                    </>
                  ) : null}
                  {r.note ? <span className="text-base text-ink-muted md:text-sm">{r.note}</span> : null}
                </div>
                <div className="flex flex-col items-end">
                  <p className="money font-semibold">
                    <span className="sr-only">{labels.amount}: </span>
                    {r.amount}
                    <span className="sr-only"> {labels.unit}</span>
                  </p>
                  <span className="text-base text-ink-muted md:hidden" aria-hidden="true">
                    {labels.amount}
                  </span>
                </div>
                {/* The invoices that make up the PO's actual, across the row: each amount in the right-hand column */}
                {r.invoices ? (
                  <ul aria-label={r.invoices.label} className="flex flex-col gap-1 border-l-4 border-line pl-3 md:col-span-3">
                    {r.invoices.rows.map((i) => (
                      <li key={i.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 text-base text-ink-muted md:text-sm">
                        <span className="min-w-0 break-words">{i.text}</span>
                        <span className="money">
                          {i.amount}
                          <span className="sr-only"> {labels.unit}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          {more ? <p className="pt-2 text-ink-muted">{more}</p> : null}
          <p className="money pt-2 font-semibold">{total}</p>
        </div>
      )}
    </section>
  )
}

export interface MovementRowView {
  readonly key: string
  readonly when: string
  readonly what: string
  readonly document: { readonly text: string; readonly href: string | null }
  /** The budget line it moved money on, when the page holds several ("บรรทัดงบ FIN-OPEX-2569") */
  readonly line: { readonly text: string; readonly href: string } | null
  readonly amount: string
}

const MOVE_GRID = 'md:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1.2fr)_9rem] md:items-start md:gap-4'
/** On wide screens every cell takes the next column of the row again */
const MOVE_CELL_WIDE = 'md:col-span-1 md:col-start-auto md:row-start-auto'

export function MovementSection({
  title,
  intro,
  count,
  rows,
  empty,
  labels,
}: {
  title: string
  intro: string
  count: string
  rows: readonly MovementRowView[]
  empty: string
  labels: { readonly when: string; readonly what: string; readonly document: string; readonly amount: string; readonly unit: string }
}) {
  return (
    <section id="movements" aria-labelledby="movements-title" className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="movements-title" className="text-xl font-semibold">
          {title}
        </h2>
        <p className="text-ink-muted">{intro}</p>
        {rows.length ? <p className="text-ink">{count}</p> : null}
      </div>
      {rows.length === 0 ? (
        <p className="border-y border-line py-4 text-ink-muted">{empty}</p>
      ) : (
        <div className="flex flex-col">
          <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted md:grid ${MOVE_GRID}`} aria-hidden="true">
            <span>{labels.when}</span>
            <span>{labels.what}</span>
            <span>{labels.document}</span>
            <span className="text-right">{labels.amount}</span>
          </div>
          <ul aria-label={title} className="flex flex-col divide-y divide-line border-b border-line">
            {rows.map((m) => (
              // Phones: the time across, then what happened with its amount in the right-hand column, then the document
              <li key={m.key} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-2.5 ${MOVE_GRID}`}>
                <MovementCell label={labels.when} className={cn('col-span-2 row-start-1 text-base text-ink-muted md:text-sm', MOVE_CELL_WIDE)}>
                  {m.when}
                </MovementCell>
                <MovementCell label={labels.what} className={cn('col-start-1 row-start-2 font-medium', MOVE_CELL_WIDE)}>
                  {m.what}
                </MovementCell>
                <MovementCell label={labels.document} className={cn('col-span-2 row-start-3 break-words', MOVE_CELL_WIDE)}>
                  {m.document.href ? (
                    <Link href={m.document.href} className={linkClass}>
                      {m.document.text}
                    </Link>
                  ) : (
                    m.document.text
                  )}
                  {m.line ? (
                    <span className="block text-base text-ink-muted md:text-sm">
                      <Link href={m.line.href} className={linkClass}>
                        {m.line.text}
                      </Link>
                    </span>
                  ) : null}
                </MovementCell>
                <p className={cn('money col-start-2 row-start-2 font-semibold', MOVE_CELL_WIDE)}>
                  <span className="sr-only">{labels.amount}: </span>
                  {m.amount}
                  <span className="sr-only"> {labels.unit}</span>
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function MovementCell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('min-w-0', className)}>
      <span className="sr-only">{label}: </span>
      {children}
    </div>
  )
}

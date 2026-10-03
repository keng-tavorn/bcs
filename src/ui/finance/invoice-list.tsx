'use client'

import { Clock, FileCheck2, FileOutput, FilePen, Flag, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { cn } from '../cn'
import { FileButton } from './file-button'

// Invoices recorded (spec §9.1 /finance/invoices, FR-P2P-008): each with its number, supplier or date, a link to its PO's
// invoice page, who recorded it and when, whether it is the last of its PO, where its values came from (an e-Tax file
// or typed) and whether an Express file took it — states as icon and words — and its amounts before VAT, VAT and with
// VAT right-aligned in tabular digits. The invoice's file opens through a short-lived address. Wide screens line the
// amounts up under one header row (not in a narrow side column); narrower ones stack them — never a table that scrolls
// sideways (§9.9). Strings arrive translated and formatted.

/** An invoice's states: the last of its PO, read from an e-Tax file or typed, in an Express file or not yet */
export type InvoiceStateKind = 'final' | 'etax' | 'typed' | 'exported' | 'notExported'

const STATE_LOOK: Readonly<Record<InvoiceStateKind, { Icon: LucideIcon; tone: string }>> = {
  final: { Icon: Flag, tone: 'text-primary' },
  etax: { Icon: FileCheck2, tone: 'text-primary' },
  typed: { Icon: FilePen, tone: 'text-ink-muted' },
  exported: { Icon: FileOutput, tone: 'text-primary' },
  notExported: { Icon: Clock, tone: 'text-warn' },
}

/** One state as an icon and words, never colour alone (NFR-A11Y-03) */
export function InvoiceState({ kind, children }: { kind: InvoiceStateKind; children: string }) {
  const { Icon, tone } = STATE_LOOK[kind]
  return (
    <span className="inline-flex items-start gap-1.5 text-base text-ink md:text-sm">
      <Icon className={cn('mt-[0.3em] size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{children}</span>
    </span>
  )
}

export interface InvoiceRowView {
  readonly id: string
  /** "เลขที่ IV-001" */
  readonly title: string
  /** Supplier, invoice date… one line each */
  readonly details: readonly string[]
  readonly link: { readonly href: string; readonly text: string } | null
  readonly meta: readonly string[]
  readonly states: ReadonlyArray<{ readonly kind: InvoiceStateKind; readonly text: string }>
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly file: { readonly fileId: string; readonly label: string; readonly busyLabel: string } | null
}

export interface InvoiceListLabels {
  readonly list: string
  readonly invoiceColumn: string
  readonly stateColumn: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly unit: string
  readonly fileFailed: string
}

const GRID = 'xl:grid xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_8rem_7rem_8rem] xl:items-start xl:gap-4'
const FIGURES = ['net', 'vat', 'gross'] as const

/**
 * table: columns under one header row on wide screens (the list page) · side: everything stacked (a side column) ·
 * main: stacked, the three amounts side by side from small screens up (a page's main column)
 */
export type InvoiceListLayout = 'table' | 'side' | 'main'

export function InvoiceList({ rows, labels, open, layout = 'table' }: { rows: readonly InvoiceRowView[]; labels: InvoiceListLabels; open: (fileId: string) => Promise<string | null>; layout?: InvoiceListLayout }) {
  const narrow = layout !== 'table'
  const grid = narrow ? '' : GRID
  return (
    <div className="flex flex-col">
      {narrow ? null : (
        <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
          <span>{labels.invoiceColumn}</span>
          <span>{labels.stateColumn}</span>
          {FIGURES.map((f) => (
            <span key={f} className="text-right">
              {labels[f]}
            </span>
          ))}
        </div>
      )}
      <ul aria-label={labels.list} className={cn('flex flex-col divide-y divide-line border-b border-line', narrow && 'border-t')}>
        {rows.map((row) => (
          <li key={row.id} className={`flex flex-col gap-2 py-3 ${grid}`}>
            <div className="flex min-w-0 flex-col">
              <span className="font-semibold break-words text-ink">{row.title}</span>
              {row.details.map((d) => (
                <span key={d} className="break-words text-ink">
                  {d}
                </span>
              ))}
              {row.link ? (
                <Link href={row.link.href} className={cn('inline-flex min-h-11 items-center self-start break-words text-primary underline underline-offset-4 hover:no-underline', !narrow && 'xl:min-h-0')}>
                  {row.link.text}
                </Link>
              ) : null}
              {row.meta.map((m) => (
                <span key={m} className="text-base break-words text-ink-muted md:text-sm">
                  {m}
                </span>
              ))}
              {row.file ? <FileButton fileId={row.file.fileId} label={row.file.label} busyLabel={row.file.busyLabel} failedText={labels.fileFailed} open={open} /> : null}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="sr-only">{labels.stateColumn}: </span>
              {row.states.map((s) => (
                <InvoiceState key={s.text} kind={s.kind}>
                  {s.text}
                </InvoiceState>
              ))}
            </div>
            <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-1', layout === 'table' && 'sm:grid-cols-3 xl:col-span-3 xl:grid-cols-[8rem_7rem_8rem] xl:gap-4', layout === 'main' && 'sm:grid-cols-3')}>
              {FIGURES.map((f) => (
                <div key={f} className={cn('flex items-baseline justify-between gap-3', !narrow && 'xl:block')}>
                  <dt className={cn('text-base text-ink-muted md:text-sm', !narrow && 'xl:sr-only')}>{labels[f]}</dt>
                  <dd className={`money text-ink ${f === 'gross' ? 'font-semibold' : ''}`}>
                    {row[f]}
                    <span className="sr-only"> {labels.unit}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  )
}

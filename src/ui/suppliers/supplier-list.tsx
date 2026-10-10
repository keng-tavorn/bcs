import Link from 'next/link'
import { cn } from '../cn'
import { Flag, SupplierStatusLabel } from './status'

// Rows of the supplier register (/suppliers, S4-02): the supplier (a link) with its code, branch and category, its
// status and VAT registration, and — for readers who see the register in full — its tax id, Express vendor code
// (BR-EXP-04) and how its identity was checked. Wide screens line the parts up in columns under one header row; phones
// stack them, never a table that scrolls sideways (§9.9). Strings arrive translated and formatted. For a reader of every
// PO, each supplier also shows the last approved price of its latest items (FR-VIS-006 AC1 "ผู้ขายและราคา").

export interface SupplierRow {
  readonly id: string
  readonly href: string
  readonly name: string
  readonly meta: readonly string[]
  readonly status: 'ACTIVE' | 'INACTIVE'
  readonly statusLabel: string
  readonly vat: string
  /** Readers who see the register in full only */
  readonly full: {
    readonly taxId: string | null
    readonly express: { readonly text: string; readonly missing: boolean }
    readonly check: string
  } | null
  /** Readers of prices only: the latest items, each its price and the PO it came from */
  readonly prices?: {
    readonly label: string
    readonly items: ReadonlyArray<{ readonly key: string; readonly text: string; readonly price: string; readonly source: string }>
    /** Said when the supplier has no approved PO yet */
    readonly none: string
  } | null
}

export interface SupplierListLabels {
  readonly list: string
  readonly supplier: string
  readonly status: string
  readonly account: string
}

export function SupplierList({ rows, labels, full }: { rows: readonly SupplierRow[]; labels: SupplierListLabels; full: boolean }) {
  const grid = full ? 'md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1.3fr)] md:items-start md:gap-6' : 'md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] md:items-start md:gap-6'
  return (
    <div className="flex flex-col">
      <div className={cn('hidden border-b border-line pb-2 text-sm text-ink-muted', grid)} aria-hidden="true">
        <span>{labels.supplier}</span>
        <span>{labels.status}</span>
        {full ? <span>{labels.account}</span> : null}
      </div>
      <ul aria-label={labels.list} className="flex flex-col divide-y divide-line">
        {rows.map((row) => (
          <li key={row.id} className={cn('flex flex-col gap-1.5 py-3', grid)}>
            <div className="flex min-w-0 flex-col">
              <Link href={row.href} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                {row.name}
              </Link>
              {row.meta.map((m) => (
                <span key={m} className="text-base break-words text-ink-muted md:text-sm">
                  {m}
                </span>
              ))}
              {row.full?.taxId ? <span className="tabular text-base text-ink-muted md:text-sm">{row.full.taxId}</span> : null}
              {row.prices ? (
                <div className="mt-1.5 flex flex-col gap-1">
                  <span className="text-base font-medium text-ink md:text-sm">{row.prices.label}</span>
                  {row.prices.items.length ? (
                    <ul aria-label={`${row.prices.label} ${row.name}`} className="flex flex-col gap-1">
                      {row.prices.items.map((item) => (
                        <li key={item.key} className="flex flex-col text-base md:text-sm">
                          <span className="flex flex-wrap justify-between gap-x-3">
                            <span className="break-words text-ink">{item.text}</span>
                            <span className="text-right text-ink tabular-nums">{item.price}</span>
                          </span>
                          <span className="text-ink-muted">{item.source}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-base text-ink-muted md:text-sm">{row.prices.none}</span>
                  )}
                </div>
              ) : null}
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="sr-only">{labels.status}: </span>
              <SupplierStatusLabel status={row.status} label={row.statusLabel} className="self-start" />
              <span className="text-base text-ink md:text-sm">{row.vat}</span>
            </div>
            {row.full ? (
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="sr-only">{labels.account}: </span>
                <Flag kind={row.full.express.missing ? 'warn' : 'ok'} className="text-base md:text-sm">
                  {row.full.express.text}
                </Flag>
                <span className="text-base text-ink-muted md:text-sm">{row.full.check}</span>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

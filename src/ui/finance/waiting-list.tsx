import Link from 'next/link'
import { PO_BADGES, StatusBadge } from '../document/badges'

// The POs that wait for their supplier's invoice (spec §9.1 /finance/invoices, FR-P2P-008): each PO as a link to record
// its invoice, with its supplier, status (the badge of §9.10: icon and words), and four amounts before VAT — the PO, the goods received so
// far, the invoices so far and what the PO still holds — right-aligned in tabular digits. Wide screens line the amounts
// up under one header row; narrower ones stack them as label and amount pairs — never a table that scrolls sideways
// (§9.9). Strings arrive translated and formatted.

export interface WaitingRowView {
  readonly id: string
  readonly href: string
  /** "บันทึกใบกำกับ PO-2569-00012" */
  readonly linkText: string
  readonly supplier: string
  readonly meta: readonly string[]
  readonly status: string
  readonly statusLabel: string
  readonly po: string
  readonly received: string
  readonly invoiced: string
  readonly held: string
}

export interface WaitingListLabels {
  readonly list: string
  readonly poColumn: string
  readonly statusColumn: string
  readonly po: string
  readonly received: string
  readonly invoiced: string
  readonly held: string
  readonly unit: string
}

const GRID = 'xl:grid xl:grid-cols-[minmax(0,1.6fr)_minmax(0,0.9fr)_8rem_8rem_8rem_8rem] xl:items-start xl:gap-4'
const FIGURES: ReadonlyArray<keyof Pick<WaitingRowView, 'po' | 'received' | 'invoiced' | 'held'>> = ['po', 'received', 'invoiced', 'held']

export function WaitingList({ rows, labels }: { rows: readonly WaitingRowView[]; labels: WaitingListLabels }) {
  return (
    <div className="flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{labels.poColumn}</span>
        <span>{labels.statusColumn}</span>
        {FIGURES.map((f) => (
          <span key={f} className="text-right">
            {labels[f]}
          </span>
        ))}
      </div>
      <ul aria-label={labels.list} className="flex flex-col divide-y divide-line border-b border-line">
        {rows.map((row) => (
          <li key={row.id} className={`flex flex-col gap-2 py-3 ${GRID}`}>
            <div className="flex min-w-0 flex-col">
              <Link href={row.href} className="inline-flex min-h-11 items-center self-start font-semibold break-words text-primary underline underline-offset-4 hover:no-underline xl:min-h-0">
                {row.linkText}
              </Link>
              <span className="break-words text-ink">{row.supplier}</span>
              {row.meta.map((m) => (
                <span key={m} className="text-base break-words text-ink-muted md:text-sm">
                  {m}
                </span>
              ))}
            </div>
            <div>
              <span className="sr-only">{labels.statusColumn}: </span>
              <StatusBadge look={PO_BADGES[row.status]} label={row.statusLabel} className="text-base md:text-sm" />
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 xl:col-span-4 xl:grid-cols-4 xl:gap-4">
              {FIGURES.map((f) => (
                <div key={f} className="flex items-baseline justify-between gap-3 xl:block">
                  <dt className="text-base text-ink-muted md:text-sm xl:sr-only">{labels[f]}</dt>
                  <dd className={`money text-ink ${f === 'held' ? 'font-semibold' : ''}`}>
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

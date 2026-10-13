import Link from 'next/link'
import { DuplicateBadge, InvoiceStatusBadge } from './badges'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shadcn/table'

// The tier-2 invoices of one tab of /finance/invoices (S8-13, FR-AP-103 AC1): each invoice as a link to its page, with
// the supplier's invoice number, the supplier, the PO, the amounts before VAT, the VAT and the total (right-aligned,
// tabular digits), the due date, its status badge, and a "possible duplicate" badge when the match flagged one. A table
// on wide screens; phones get a list instead, so nothing scrolls sideways (§9.9). Strings arrive translated.

export interface ApInvoiceRowView {
  readonly id: string
  readonly href: string
  /** The BCS number, or "draft" */
  readonly title: string
  readonly supplierNo: string
  readonly supplier: string
  readonly po: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly due: string
  readonly status: string
  readonly statusLabel: string
  readonly notes: readonly string[]
  readonly duplicate: string | null
}

export interface ApInvoiceTableLabels {
  readonly list: string
  readonly invoice: string
  readonly supplier: string
  readonly po: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly due: string
  readonly status: string
  readonly unit: string
}

const LINK = 'inline-flex min-h-11 items-center font-semibold break-words text-primary underline underline-offset-4 hover:no-underline lg:min-h-0'

function States({ row }: { row: ApInvoiceRowView }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <InvoiceStatusBadge status={row.status} label={row.statusLabel} />
      {row.duplicate ? <DuplicateBadge label={row.duplicate} /> : null}
    </div>
  )
}

export function ApInvoiceTable({ rows, labels }: { rows: readonly ApInvoiceRowView[]; labels: ApInvoiceTableLabels }) {
  const figures = [
    { key: 'net', label: labels.net },
    { key: 'vat', label: labels.vat },
    { key: 'gross', label: labels.gross },
  ] as const
  return (
    <>
      <Table aria-label={labels.list} className="hidden text-base lg:table md:text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>{labels.invoice}</TableHead>
            <TableHead>{labels.supplier}</TableHead>
            <TableHead>{labels.po}</TableHead>
            {figures.map((f) => (
              <TableHead key={f.key} className="text-right">
                {f.label}
              </TableHead>
            ))}
            <TableHead>{labels.due}</TableHead>
            <TableHead>{labels.status}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="align-top whitespace-normal">
                <Link href={row.href} className={LINK}>
                  {row.title}
                </Link>
                <span className="block text-ink-muted">{row.supplierNo}</span>
                {row.notes.map((n) => (
                  <span key={n} className="block text-ink-muted">
                    {n}
                  </span>
                ))}
              </TableCell>
              <TableCell className="align-top whitespace-normal">{row.supplier}</TableCell>
              <TableCell className="align-top">{row.po}</TableCell>
              {figures.map((f) => (
                <TableCell key={f.key} className="money text-right align-top">
                  {row[f.key]}
                  <span className="sr-only"> {labels.unit}</span>
                </TableCell>
              ))}
              <TableCell className="align-top">{row.due}</TableCell>
              <TableCell className="align-top whitespace-normal">
                <States row={row} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={labels.list} className="flex flex-col divide-y divide-line border-y border-line lg:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-2 py-3">
            <div className="flex min-w-0 flex-col">
              <Link href={row.href} className={`${LINK} self-start`}>
                {row.title}
              </Link>
              <span className="break-words text-ink">{row.supplier}</span>
              <span className="text-ink-muted">{row.supplierNo}</span>
              <span className="text-ink-muted">
                {labels.po} {row.po} · {labels.due} {row.due}
              </span>
              {row.notes.map((n) => (
                <span key={n} className="text-ink-muted">
                  {n}
                </span>
              ))}
            </div>
            <States row={row} />
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-3">
              {figures.map((f) => (
                <div key={f.key} className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-muted">{f.label}</dt>
                  <dd className={`money text-ink ${f.key === 'gross' ? 'font-semibold' : ''}`}>
                    {row[f.key]}
                    <span className="sr-only"> {labels.unit}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}

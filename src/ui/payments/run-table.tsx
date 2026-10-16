import Link from 'next/link'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { FlagBadge, RunStatusBadge } from './badges'

// The payment runs of one tab of /finance/payments (S9-09, FR-PAY-101): each run as a link to its page — its number, or
// "draft" — with the pay date, the payer account masked, how many suppliers it pays, what it transfers (right-aligned,
// tabular digits), how many items carry a flag, and its status badge. A table on wide screens; phones get a list
// instead, so nothing scrolls sideways (§9.9). Strings arrive translated and formatted.

export interface RunRowView {
  readonly id: string
  readonly href: string
  readonly title: string
  readonly preparedBy: string
  readonly payDate: string
  readonly payer: string
  readonly suppliers: string
  readonly transfer: string
  /** "2 รายการมีธง", or null without a flag */
  readonly flags: string | null
  readonly noFlags: string
  readonly status: string
  readonly statusLabel: string
}

export interface RunTableLabels {
  readonly table: string
  readonly run: string
  readonly payDate: string
  readonly payer: string
  readonly suppliers: string
  readonly transfer: string
  readonly flags: string
  readonly status: string
  readonly unit: string
}

const LINK = 'inline-flex min-h-11 items-center font-semibold break-words text-primary underline underline-offset-4 hover:no-underline lg:min-h-0'

export function RunTable({ rows, labels }: { rows: readonly RunRowView[]; labels: RunTableLabels }) {
  return (
    <>
      <Table aria-label={labels.table} className="hidden text-base lg:table md:text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>{labels.run}</TableHead>
            <TableHead>{labels.payDate}</TableHead>
            <TableHead>{labels.payer}</TableHead>
            <TableHead className="text-right">{labels.suppliers}</TableHead>
            <TableHead className="text-right">{labels.transfer}</TableHead>
            <TableHead>{labels.flags}</TableHead>
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
                <span className="block text-ink-muted">{row.preparedBy}</span>
              </TableCell>
              <TableCell className="align-top">{row.payDate}</TableCell>
              <TableCell className="align-top whitespace-normal">{row.payer}</TableCell>
              <TableCell className="tabular text-right align-top">{row.suppliers}</TableCell>
              <TableCell className="money text-right align-top">
                {row.transfer}
                <span className="sr-only"> {labels.unit}</span>
              </TableCell>
              <TableCell className="align-top whitespace-normal">{row.flags ? <FlagBadge label={row.flags} /> : <span className="text-ink-muted">{row.noFlags}</span>}</TableCell>
              <TableCell className="align-top whitespace-normal">
                <RunStatusBadge status={row.status} label={row.statusLabel} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={labels.table} className="flex flex-col divide-y divide-line border-y border-line lg:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-2 py-3">
            <div className="flex min-w-0 flex-col">
              <Link href={row.href} className={`${LINK} self-start`}>
                {row.title}
              </Link>
              <span className="text-ink-muted">{row.preparedBy}</span>
              <span className="text-ink-muted">
                {labels.payDate} {row.payDate}
              </span>
              <span className="break-words text-ink-muted">
                {labels.payer} {row.payer}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <RunStatusBadge status={row.status} label={row.statusLabel} />
              {row.flags ? <FlagBadge label={row.flags} /> : null}
            </div>
            <dl className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-muted">{labels.suppliers}</dt>
                <dd className="tabular text-ink">{row.suppliers}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-muted">{labels.transfer}</dt>
                <dd className="money font-semibold text-ink">
                  {row.transfer}
                  <span className="sr-only"> {labels.unit}</span>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}

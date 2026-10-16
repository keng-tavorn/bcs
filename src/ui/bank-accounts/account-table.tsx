import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { AccountStatusBadge } from './badges'

// The organization's payer accounts on /finance/bank-accounts (S9-09, FR-PAY-102 AC5 AC8): code, bank, the number
// masked to its last four digits, the account's name, the file template, its status and the day it came into force. A
// table on wide screens; phones get a list instead, so nothing scrolls sideways (§9.9). Strings arrive translated.

export interface PayerAccountRowView {
  readonly id: string
  readonly code: string
  readonly bank: string
  /** "••••••0016" */
  readonly number: string
  readonly name: string
  readonly template: string
  readonly status: string
  readonly statusLabel: string
  readonly effective: string
}

export interface PayerAccountLabels {
  readonly list: string
  readonly code: string
  readonly bank: string
  readonly number: string
  readonly name: string
  readonly template: string
  readonly status: string
  readonly effective: string
}

export function PayerAccountTable({ rows, labels }: { rows: readonly PayerAccountRowView[]; labels: PayerAccountLabels }) {
  return (
    <>
      <Table aria-label={labels.list} className="hidden text-base lg:table md:text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>{labels.code}</TableHead>
            <TableHead>{labels.bank}</TableHead>
            <TableHead>{labels.number}</TableHead>
            <TableHead>{labels.name}</TableHead>
            <TableHead>{labels.template}</TableHead>
            <TableHead>{labels.status}</TableHead>
            <TableHead>{labels.effective}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="align-top font-medium">{row.code}</TableCell>
              <TableCell className="align-top whitespace-normal">{row.bank}</TableCell>
              <TableCell className="tabular align-top">{row.number}</TableCell>
              <TableCell className="align-top whitespace-normal">{row.name}</TableCell>
              <TableCell className="align-top whitespace-normal">{row.template}</TableCell>
              <TableCell className="align-top">
                <AccountStatusBadge status={row.status} label={row.statusLabel} />
              </TableCell>
              <TableCell className="align-top">{row.effective}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={labels.list} className="flex flex-col divide-y divide-line border-y border-line lg:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1.5 py-3">
            <span className="font-semibold break-words text-ink">
              {row.code} · {row.bank}
            </span>
            <span className="tabular text-ink">{row.number}</span>
            <span className="break-words text-ink">{row.name}</span>
            <AccountStatusBadge status={row.status} label={row.statusLabel} className="self-start" />
            <dl className="flex flex-col gap-0.5 text-ink-muted">
              <div className="flex flex-wrap gap-x-2">
                <dt>{labels.template}</dt>
                <dd className="break-words text-ink">{row.template}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt>{labels.effective}</dt>
                <dd className="text-ink">{row.effective}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}

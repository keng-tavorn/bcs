import Link from 'next/link'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { ChangeStatusBadge } from './badges'

// The requests to change a bank account on /finance/bank-accounts (S9-09, FR-PAY-102 AC7): each request as a link to its
// page, what it does in words (add, replace, close), whose account (a supplier's code and name, or the organization's),
// its status, who proposed it and when it was sent. No number appears here. A table on wide screens; phones get a list
// instead, so nothing scrolls sideways (§9.9). Strings arrive translated.

export interface ChangeRowView {
  readonly id: string
  readonly href: string
  /** The number BAC-…, or "draft" */
  readonly title: string
  readonly kind: string
  readonly owner: string
  readonly status: string
  readonly statusLabel: string
  readonly proposer: string
  readonly submitted: string
}

export interface ChangeTableLabels {
  readonly list: string
  readonly number: string
  readonly kind: string
  readonly owner: string
  readonly status: string
  readonly proposer: string
  readonly submitted: string
}

const LINK = 'inline-flex min-h-11 items-center font-semibold break-words text-primary underline underline-offset-4 hover:no-underline lg:min-h-0'

export function ChangeTable({ rows, labels }: { rows: readonly ChangeRowView[]; labels: ChangeTableLabels }) {
  return (
    <>
      <Table aria-label={labels.list} className="hidden text-base lg:table md:text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>{labels.number}</TableHead>
            <TableHead>{labels.kind}</TableHead>
            <TableHead>{labels.owner}</TableHead>
            <TableHead>{labels.status}</TableHead>
            <TableHead>{labels.proposer}</TableHead>
            <TableHead>{labels.submitted}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="align-top whitespace-normal">
                <Link href={row.href} className={LINK}>
                  {row.title}
                </Link>
              </TableCell>
              <TableCell className="align-top">{row.kind}</TableCell>
              <TableCell className="align-top whitespace-normal">{row.owner}</TableCell>
              <TableCell className="align-top">
                <ChangeStatusBadge status={row.status} label={row.statusLabel} />
              </TableCell>
              <TableCell className="align-top whitespace-normal">{row.proposer}</TableCell>
              <TableCell className="align-top">{row.submitted}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={labels.list} className="flex flex-col divide-y divide-line border-y border-line lg:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1.5 py-3">
            <Link href={row.href} className={`${LINK} self-start`}>
              {row.title}
            </Link>
            <span className="break-words text-ink">
              {row.kind} · {row.owner}
            </span>
            <ChangeStatusBadge status={row.status} label={row.statusLabel} className="self-start" />
            <span className="break-words text-ink-muted">
              {labels.proposer} {row.proposer} · {labels.submitted} {row.submitted}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

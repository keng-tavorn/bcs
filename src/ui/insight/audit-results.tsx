import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '../cn'

// The audit trail's events (spec §4.5, FR-VIS-004 AC1, FR-DOA-005): when, what happened, to which document, by whom
// (and on whose behalf), through which channel, and the DOA version and rule a decision names. Wide screens get a table
// (caption, column headers, the event as row header); narrower screens the same as a list, never a table that scrolls
// sideways (§9.9). A document opens its page for readers who may open it. Strings arrive translated.

export interface AuditLink {
  readonly text: string
  readonly href: string | null
}

export interface AuditRowView {
  readonly id: string
  /** "ลำดับที่ 1234": the seq column of the exported file */
  readonly seq: string
  readonly when: string
  readonly event: string
  readonly document: AuditLink | null
  readonly actor: string
  /** "ทำแทน ดำรง ก่อสร้างไทย" */
  readonly onBehalfOf: string | null
  readonly channel: string
  /** "DOA-DEMO ฉบับ 1 ข้อ PR-02" */
  readonly doa: AuditLink | null
}

export interface AuditResultsLabels {
  readonly caption: string
  readonly when: string
  readonly event: string
  readonly document: string
  readonly actor: string
  readonly channel: string
  readonly doa: string
  /** Read for an empty cell: "ไม่มี" */
  readonly none: string
}

const linkClass = 'text-primary underline underline-offset-4 hover:no-underline'

function Linked({ link }: { link: AuditLink }) {
  return link.href ? (
    <Link href={link.href} className={cn(linkClass, 'break-words')}>
      {link.text}
    </Link>
  ) : (
    <span className="break-words">{link.text}</span>
  )
}

function Empty({ none }: { none: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{none}</span>
    </>
  )
}

function WideTable({ rows, labels }: { rows: readonly AuditRowView[]; labels: AuditResultsLabels }) {
  // the cells are the page's content, at the body's 15 px; only the column headers are secondary text
  const th = 'border-b border-line px-3 py-2 text-left text-sm font-medium text-ink-muted'
  const td = 'px-3 py-2.5 align-top'
  return (
    <table className="hidden w-full border-collapse xl:table">
      <caption className="sr-only">{labels.caption}</caption>
      <thead>
        <tr>
          <th scope="col" className={cn(th, 'w-40')}>
            {labels.when}
          </th>
          <th scope="col" className={th}>
            {labels.event}
          </th>
          <th scope="col" className={th}>
            {labels.document}
          </th>
          <th scope="col" className={th}>
            {labels.actor}
          </th>
          <th scope="col" className={th}>
            {labels.channel}
          </th>
          <th scope="col" className={th}>
            {labels.doa}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-line">
            <td className={cn(td, 'tabular')}>
              {/* the time on one line: the column widens rather than leave "น." alone below */}
              <span className="block whitespace-nowrap">{r.when}</span>
              <span className="block text-ink-muted">{r.seq}</span>
            </td>
            <th scope="row" className={cn(td, 'text-left font-medium')}>
              {r.event}
            </th>
            <td className={td}>{r.document ? <Linked link={r.document} /> : <Empty none={labels.none} />}</td>
            <td className={td}>
              <span className="block">{r.actor}</span>
              {r.onBehalfOf ? <span className="block text-ink-muted">{r.onBehalfOf}</span> : null}
            </td>
            {/* a channel's name is short and reads as one: "หน้าจอใน LINE" never splits over two lines */}
            <td className={cn(td, 'whitespace-nowrap')}>{r.channel}</td>
            <td className={td}>{r.doa ? <Linked link={r.doa} /> : <Empty none={labels.none} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Pair({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

function NarrowList({ rows, labels }: { rows: readonly AuditRowView[]; labels: AuditResultsLabels }) {
  return (
    <ul aria-label={labels.caption} className="flex flex-col divide-y divide-line border-y border-line xl:hidden">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 py-3">
          <div className="flex flex-col">
            <p className="font-semibold text-ink">{r.event}</p>
            {/* The record's time and number: content, at the body's size like the wide table's cells (§9.9: 15 px on the web) */}
            <p className="tabular text-ink-muted">
              {r.when} · {r.seq}
            </p>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <Pair term={labels.document}>{r.document ? <Linked link={r.document} /> : <Empty none={labels.none} />}</Pair>
            <Pair term={labels.actor}>
              {r.actor}
              {r.onBehalfOf ? <span className="block text-ink-muted">{r.onBehalfOf}</span> : null}
            </Pair>
            <Pair term={labels.channel}>{r.channel}</Pair>
            <Pair term={labels.doa}>{r.doa ? <Linked link={r.doa} /> : <Empty none={labels.none} />}</Pair>
          </dl>
        </li>
      ))}
    </ul>
  )
}

export function AuditResults({ rows, labels }: { rows: readonly AuditRowView[]; labels: AuditResultsLabels }) {
  return (
    <>
      <WideTable rows={rows} labels={labels} />
      <NarrowList rows={rows} labels={labels} />
    </>
  )
}

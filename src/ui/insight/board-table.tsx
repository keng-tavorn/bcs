import { CircleAlert, MessageCircleQuestion } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '../cn'

// The board "เอกสารค้างที่ใคร" (spec §11.1, FR-VIS-001 AC1): one row per person holding open documents — how many wait
// for their decision, how many are past their SLA, how many wait for the requester's answer, and the oldest and the
// average wait in business hours. Wide screens get a table (caption, column and row headers, figures right-aligned in
// tabular digits); phones get the same figures as a list, never a table that scrolls sideways (§9.9). Every figure
// opens the person's documents (§9.9: a number leads to its list). Past SLA is an icon and words, never colour alone.
// Strings arrive translated.

export interface BoardFigure {
  readonly text: string
  /** Says whose figure it is and where it leads, e.g. "เกิน SLA 2 รายการของ วีระ ปฏิบัติการ: ดูเอกสาร" */
  readonly label: string
}

export interface BoardRowView {
  readonly id: string
  readonly name: string
  readonly href: string
  /** "ดูเอกสารที่ค้างที่ วีระ ปฏิบัติการ" */
  readonly nameLabel: string
  readonly open: BoardFigure
  readonly overdue: BoardFigure & { readonly count: number }
  readonly waiting: BoardFigure & { readonly count: number }
  readonly oldest: string
  readonly average: string
}

export interface BoardTableLabels {
  readonly caption: string
  readonly person: string
  readonly open: string
  readonly overdue: string
  readonly waiting: string
  readonly oldest: string
  readonly average: string
  /** "ชั่วโมงทำการ", read after each age */
  readonly hours: string
  /** Words next to the warning icon: "เกิน SLA" */
  readonly overdueWord: string
  readonly waitingWord: string
}

const link = 'text-primary underline underline-offset-4 hover:no-underline'

function Figure({ figure, href, className }: { figure: BoardFigure; href: string; className?: string }) {
  return (
    <Link href={href} aria-label={figure.label} className={cn(link, className)}>
      {figure.text}
    </Link>
  )
}

function Overdue({ row, href, labels }: { row: BoardRowView; href: string; labels: BoardTableLabels }) {
  if (row.overdue.count === 0) return <Figure figure={row.overdue} href={href} />
  return (
    <span className="inline-flex items-center justify-end gap-1.5 font-semibold text-danger">
      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
      <span className="sr-only">{labels.overdueWord}</span>
      <Figure figure={row.overdue} href={href} className="text-danger" />
    </span>
  )
}

function Waiting({ row, href, labels }: { row: BoardRowView; href: string; labels: BoardTableLabels }) {
  if (row.waiting.count === 0) return <Figure figure={row.waiting} href={href} />
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <MessageCircleQuestion className="size-4 shrink-0 text-info" aria-hidden="true" />
      <span className="sr-only">{labels.waitingWord}</span>
      <Figure figure={row.waiting} href={href} />
    </span>
  )
}

function WideTable({ rows, labels }: { rows: readonly BoardRowView[]; labels: BoardTableLabels }) {
  const th = 'border-b border-line px-3 py-2 text-sm font-medium text-ink-muted'
  const num = 'money px-3 py-2.5 align-top'
  return (
    <table className="hidden w-full border-collapse lg:table">
      <caption className="sr-only">{labels.caption}</caption>
      <thead>
        <tr>
          <th scope="col" className={cn(th, 'w-[30%] text-left')}>
            {labels.person}
          </th>
          {[labels.open, labels.overdue, labels.waiting, labels.oldest, labels.average].map((h) => (
            <th key={h} scope="col" className={cn(th, 'text-right')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-line">
            <th scope="row" className="px-3 py-2.5 text-left align-top font-normal">
              <Link href={r.href} aria-label={r.nameLabel} className={cn(link, 'font-semibold')}>
                {r.name}
              </Link>
            </th>
            <td className={num}>
              <Figure figure={r.open} href={r.href} />
            </td>
            <td className={num}>
              <Overdue row={r} href={r.href} labels={labels} />
            </td>
            <td className={num}>
              <Waiting row={r} href={r.href} labels={labels} />
            </td>
            <td className={num}>
              {r.oldest}
              <span className="sr-only"> {labels.hours}</span>
            </td>
            <td className={num}>
              {r.average}
              <span className="sr-only"> {labels.hours}</span>
            </td>
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
      <dd className="money">{children}</dd>
    </>
  )
}

function NarrowList({ rows, labels }: { rows: readonly BoardRowView[]; labels: BoardTableLabels }) {
  return (
    <ul aria-label={labels.caption} className="flex flex-col divide-y divide-line border-y border-line lg:hidden">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 py-3">
          <Link href={r.href} aria-label={r.nameLabel} className={cn(link, 'font-semibold')}>
            {r.name}
          </Link>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
            <Pair term={labels.open}>
              <Figure figure={r.open} href={r.href} />
            </Pair>
            <Pair term={labels.overdue}>
              <Overdue row={r} href={r.href} labels={labels} />
            </Pair>
            <Pair term={labels.waiting}>
              <Waiting row={r} href={r.href} labels={labels} />
            </Pair>
            <Pair term={labels.oldest}>
              {r.oldest}
              <span className="sr-only"> {labels.hours}</span>
            </Pair>
            <Pair term={labels.average}>
              {r.average}
              <span className="sr-only"> {labels.hours}</span>
            </Pair>
          </dl>
        </li>
      ))}
    </ul>
  )
}

export function BoardTable({ rows, labels }: { rows: readonly BoardRowView[]; labels: BoardTableLabels }) {
  return (
    <>
      <WideTable rows={rows} labels={labels} />
      <NarrowList rows={rows} labels={labels} />
    </>
  )
}

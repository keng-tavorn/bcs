import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '../cn'
import { LineStatusBadge, LowBadge } from './badges'
import { HeldMeter } from './meter'

// The budget dashboard's figures (spec §11.2, FR-BUD-005 AC1 AC2): each department's total over its budget lines, then
// the total of everything shown. Wide screens get a real table (caption, column and row headers) with money right-
// aligned in tabular digits; narrower screens get the same figures as stacked lists, never a table that scrolls
// sideways (§9.9). Every number leads to what makes it up (AC2, §9.9 "ทุกตัวเลขต้องคลิกไปที่รายการได้"), on a line, a
// department and the total alike, 0.00 too: reserved, committed and actual to their documents, planned to the imports
// and available to the ledger's movements — an empty section of the drill-down says what will show there; the shares
// to the documents that make them up, and the warning's share or amount left to the movements. A row running low says
// so in words beside its warning-coloured bar, and one with nothing left that it is used up, in the danger colour of
// งบไม่พอ (§9.9 token table, NFR-A11Y-03). Strings arrive translated and formatted.

export interface AmountLink {
  readonly href: string
  /** Says which figure of what it is and where it leads; it begins with the figure as shown */
  readonly label: string
}

export type Bucket = 'planned' | 'available' | 'reserved' | 'committed' | 'actual'
export const BUCKETS: readonly Bucket[] = ['planned', 'available', 'reserved', 'committed', 'actual']

/** The link of each amount, whatever the amount: the section that makes it up says when it holds nothing */
export type AmountLinks = Readonly<Record<Bucket, AmountLink>>

/** A row's links: its amounts', and its shares' and its warning's where it has them (null where it has none) */
export interface FigureLinks extends AmountLinks {
  /** "ใช้แล้ว 18.0%": to the POs that commit, followed by the actual */
  readonly used: AmountLink | null
  /** "รวมที่จองแล้ว 26.0%": to the documents that reserve, followed by the rest */
  readonly held: AmountLink | null
  /** "ใกล้หมด เหลือ 8.3%" or "งบหมด เหลือ 0.00 บาท": to the ledger's movements behind what is left */
  readonly low: AmountLink | null
}

export interface FigureView {
  readonly planned: string
  readonly available: string
  readonly reserved: string
  readonly committed: string
  readonly actual: string
  /** "ใช้แล้ว 18.0%", or null when nothing is planned */
  readonly used: string | null
  /** "รวมที่จองแล้ว 26.0%" */
  readonly held: string | null
  readonly heldBp: number | null
  /** The low warning in words ("ใกล้หมด เหลือ 8.3%", or "งบหมด เหลือ 0.00 บาท" once nothing is left), or null */
  readonly low: string | null
  /** Nothing is left (the warning is the used-up one, in --danger): new requests on it are refused */
  readonly out: boolean
  readonly links: FigureLinks
}

export interface BudgetLineView extends FigureView {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly href: string
  readonly status: { readonly kind: 'FROZEN' | 'CLOSED'; readonly label: string } | null
}

export interface BudgetDepartmentView extends FigureView {
  readonly id: string
  /** "รวมฝ่ายก่อสร้าง" */
  readonly totalLabel: string
  readonly name: string
  /** The department's documents (its drill-down) */
  readonly href: string
  readonly lines: readonly BudgetLineView[]
}

export interface BudgetTotalView extends FigureView {
  /** "รวมทั้งองค์กร" or "รวมแผนกที่คุณดูแล" */
  readonly label: string
  /** The documents of everything shown (its drill-down) */
  readonly href: string
}

export interface BudgetTableLabels {
  readonly caption: string
  readonly line: string
  readonly planned: string
  readonly available: string
  readonly reserved: string
  readonly committed: string
  readonly actual: string
  readonly share: string
  readonly noShare: string
  readonly unit: string
}

const linkClass = 'text-primary underline underline-offset-4 hover:no-underline'

/** One amount: a link to what makes it up, named with the amount, what it is of and where it leads */
function Amount({ text, link }: { text: string; link: AmountLink }) {
  return (
    <Link href={link.href} aria-label={link.label} className={linkClass}>
      {text}
    </Link>
  )
}

/** A share: a link to the documents that make it up, named with the share, what it is of and where it leads */
function Share({ text, link }: { text: string; link: AmountLink | null }) {
  return link ? (
    <Link href={link.href} aria-label={link.label} className={cn('tabular self-start', linkClass)}>
      {text}
    </Link>
  ) : (
    <span className="tabular">{text}</span>
  )
}

/** Used and held, then the bar; stacked in the table's narrow column, side by side in the lists */
function Shares({ f, noShare, inline, className }: { f: FigureView; noShare: string; inline?: boolean; className?: string }) {
  if (!f.used || !f.held) return <span className={cn('text-ink-muted', className)}>{noShare}</span>
  return (
    <span className={cn('flex flex-col gap-1', className)}>
      <span className={inline ? 'flex flex-wrap gap-x-4' : 'flex flex-col gap-1'}>
        <Share text={f.used} link={f.links.used} />
        <Share text={f.held} link={f.links.held} />
      </span>
      <HeldMeter heldBp={f.heldBp} low={f.low !== null} out={f.out} />
    </span>
  )
}

/**
 * The states of a row in words with an icon: running low or used up — a link to the ledger's movements behind what is
 * left, in its own icon and colour — and a line's frozen or closed status
 */
function States({ f, status, className }: { f: FigureView; status?: BudgetLineView['status']; className?: string }) {
  if (!f.low && !status) return null
  return (
    <span className={cn('flex flex-col gap-0.5', className)}>
      {f.low ? <LowBadge label={f.low} out={f.out} link={f.links.low} /> : null}
      {status ? <LineStatusBadge status={status.kind} label={status.label} /> : null}
    </span>
  )
}

function WideTable({ departments, total, labels }: { departments: readonly BudgetDepartmentView[]; total: BudgetTotalView; labels: BudgetTableLabels }) {
  const th = 'border-b border-line px-3 py-2 text-sm font-medium text-ink-muted'
  const money = 'money px-3 py-2.5 align-top'
  return (
    <table className="hidden w-full border-collapse xl:table">
      <caption className="sr-only">{labels.caption}</caption>
      <thead>
        <tr>
          <th scope="col" className={cn(th, 'w-[26%] text-left')}>
            {labels.line}
          </th>
          {BUCKETS.map((b) => (
            <th key={b} scope="col" className={cn(th, 'text-right')}>
              {labels[b]}
            </th>
          ))}
          <th scope="col" className={cn(th, 'w-44 text-left')}>
            {labels.share}
          </th>
        </tr>
      </thead>
      {departments.map((d) => (
        <tbody key={d.id} className="border-b border-line">
          <tr className="bg-surface font-semibold">
            <th scope="row" className="px-3 py-2.5 text-left align-top">
              <Link href={d.href} className={cn('break-words', linkClass)}>
                {d.totalLabel}
              </Link>
              <States f={d} className="mt-1" />
            </th>
            {BUCKETS.map((b) => (
              <td key={b} className={money}>
                <Amount text={d[b]} link={d.links[b]} />
              </td>
            ))}
            <td className="px-3 py-2.5 align-top font-normal">
              <Shares f={d} noShare={labels.noShare} />
            </td>
          </tr>
          {d.lines.map((l) => (
            <tr key={l.id} className="border-t border-line">
              <th scope="row" className="px-3 py-2.5 text-left align-top font-normal">
                <Link href={l.href} className={cn('font-semibold break-words', linkClass)}>
                  {l.code}
                </Link>
                <span className="block break-words text-ink-muted">{l.name}</span>
                <States f={l} status={l.status} className="mt-1" />
              </th>
              {BUCKETS.map((b) => (
                <td key={b} className={money}>
                  <Amount text={l[b]} link={l.links[b]} />
                </td>
              ))}
              <td className="px-3 py-2.5 align-top">
                <Shares f={l} noShare={labels.noShare} />
              </td>
            </tr>
          ))}
        </tbody>
      ))}
      <tfoot>
        {/* The organization's total: the rule colour of every divider (--line, §9.9 tokens), 1 px thicker than a row's,
            under its own heading and in bold */}
        <tr className="border-t-2 border-line font-semibold">
          <th scope="row" className="px-3 py-3 text-left align-top">
            <Link href={total.href} className={linkClass}>
              {total.label}
            </Link>
            <States f={total} className="mt-1" />
          </th>
          {BUCKETS.map((b) => (
            <td key={b} className="money px-3 py-3 align-top">
              <Amount text={total[b]} link={total.links[b]} />
            </td>
          ))}
          <td className="px-3 py-3 align-top font-normal">
            <Shares f={total} noShare={labels.noShare} />
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

/** Label left, amount right: the figures of a stacked list */
function FigureList({ f, labels, strong }: { f: FigureView; labels: BudgetTableLabels; strong?: boolean }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
      {BUCKETS.map((b) => (
        <FigurePair key={b} term={labels[b]} strong={strong}>
          <Amount text={f[b]} link={f.links[b]} />
          <span className="sr-only"> {labels.unit}</span>
        </FigurePair>
      ))}
    </dl>
  )
}

function FigurePair({ term, children, strong }: { term: string; children: ReactNode; strong?: boolean }) {
  return (
    <>
      <dt className="text-ink-muted">{term}</dt>
      <dd className={cn('money', strong ? 'font-semibold' : '')}>{children}</dd>
    </>
  )
}

function NarrowList({ departments, total, labels }: { departments: readonly BudgetDepartmentView[]; total: BudgetTotalView; labels: BudgetTableLabels }) {
  return (
    <div className="flex flex-col gap-8 xl:hidden">
      {departments.map((d) => (
        <section key={d.id} aria-labelledby={`budget-dept-${d.id}`} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 border-y border-line bg-surface px-3 py-3">
            <h2 id={`budget-dept-${d.id}`} className="text-lg font-semibold">
              <Link href={d.href} className={cn('break-words', linkClass)}>
                {d.totalLabel}
              </Link>
            </h2>
            <States f={d} />
            <FigureList f={d} labels={labels} strong />
            <Shares f={d} noShare={labels.noShare} inline />
          </div>
          <ul className="flex flex-col divide-y divide-line border-b border-line" aria-label={d.name}>
            {d.lines.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 px-3 py-3">
                <div className="flex flex-col gap-0.5">
                  <Link href={l.href} className={cn('font-semibold break-words', linkClass)}>
                    {l.code}
                  </Link>
                  <span className="break-words text-ink-muted">{l.name}</span>
                  <States f={l} status={l.status} />
                </div>
                <FigureList f={l} labels={labels} />
                <Shares f={l} noShare={labels.noShare} inline />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section aria-labelledby="budget-total" className="flex flex-col gap-2 border-t-2 border-line px-3 pt-3">
        <h2 id="budget-total" className="text-lg font-semibold">
          <Link href={total.href} className={linkClass}>
            {total.label}
          </Link>
        </h2>
        <States f={total} />
        <FigureList f={total} labels={labels} strong />
        <Shares f={total} noShare={labels.noShare} inline />
      </section>
    </div>
  )
}

export function BudgetTable({ departments, total, labels }: { departments: readonly BudgetDepartmentView[]; total: BudgetTotalView; labels: BudgetTableLabels }) {
  return (
    <>
      <WideTable departments={departments} total={total} labels={labels} />
      <NarrowList departments={departments} total={total} labels={labels} />
    </>
  )
}

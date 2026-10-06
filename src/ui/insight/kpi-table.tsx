import Link from 'next/link'
import { cn } from '../cn'

// The KPI page's figures (spec §11.4, FR-VIS-003 AC2): goal by goal (G-1 to G-5), each measure with what it counts in
// plain words, its value for the period next to the Phase 0 baseline and the proposed target. Not a wall of big
// numbers: every value is a link to the documents it counts, and a detail that stands for a list of its own links to it
// (§9.9). Wide screens get one table (goals as group headers); phones get the same as a list per goal, never a table
// that scrolls sideways. Strings arrive translated.

export interface KpiMeasureView {
  readonly id: string
  readonly name: string
  readonly formula: string
  readonly value: string
  /** "3 จาก 5 การตัดสิน" */
  readonly detail: string | null
  /** The documents the value counts; null when there is nothing to list (no data in the period) */
  readonly href: string | null
  /** Says what the link opens: "ดูรายการที่นับ: … 60.0% (3 จาก 5 การตัดสิน)" */
  readonly linkLabel: string
  /**
   * The detail as a link of its own, where its "of y" is a list the value's link does not open: "1 จาก 37 ขั้น" of the
   * steps past due opens all 37 steps assigned, the counted ones first; null where the detail is words only
   */
  readonly detailLink: { readonly href: string; readonly label: string } | null
  readonly baseline: string
  readonly target: string
}

export interface KpiGoalView {
  readonly code: string
  readonly title: string
  readonly measures: readonly KpiMeasureView[]
}

export interface KpiTableLabels {
  readonly caption: string
  readonly measure: string
  readonly value: string
  readonly baseline: string
  readonly target: string
}

const linkClass = 'font-semibold text-primary underline underline-offset-4 hover:no-underline'

function Value({ m }: { m: KpiMeasureView }) {
  return (
    <>
      {m.href ? (
        <Link href={m.href} aria-label={m.linkLabel} className={cn(linkClass, 'tabular')}>
          {m.value}
        </Link>
      ) : (
        <span className="font-semibold text-ink">{m.value}</span>
      )}
      {/* secondary in the wide table, like the formula beside it; the list below lg keeps it at the body size. A detail
          whose numbers stand for a list of their own opens it (§9.9: every number opens its list) */}
      {m.detail && m.detailLink ? (
        <Link href={m.detailLink.href} aria-label={m.detailLink.label} className="block w-fit text-primary underline underline-offset-4 hover:no-underline lg:text-sm">
          {m.detail}
        </Link>
      ) : m.detail ? (
        <span className="block text-ink-muted lg:text-sm">{m.detail}</span>
      ) : null}
    </>
  )
}

function WideTable({ goals, labels }: { goals: readonly KpiGoalView[]; labels: KpiTableLabels }) {
  const th = 'border-b border-line px-3 py-2 text-left text-sm font-medium text-ink-muted'
  return (
    <table className="hidden w-full border-collapse lg:table">
      <caption className="sr-only">{labels.caption}</caption>
      <thead>
        <tr>
          <th scope="col" className={cn(th, 'w-[44%]')}>
            {labels.measure}
          </th>
          <th scope="col" className={th}>
            {labels.value}
          </th>
          <th scope="col" className={cn(th, 'w-36 whitespace-nowrap')}>
            {labels.baseline}
          </th>
          <th scope="col" className={th}>
            {labels.target}
          </th>
        </tr>
      </thead>
      {goals.map((g) => (
        <tbody key={g.code} className="border-b border-line">
          <tr className="bg-surface">
            {/* A goal heads its measures a size up (18 px, subheading) as well as a weight up: headings differ by both (§9.9) */}
            <th scope="rowgroup" colSpan={4} className="subheading px-3 py-2 text-left font-semibold">
              {g.code} · {g.title}
            </th>
          </tr>
          {g.measures.map((m) => (
            <tr key={m.id} className="border-t border-line">
              <th scope="row" className="px-3 py-2.5 text-left align-top font-normal">
                <span className="block font-medium text-ink">{m.name}</span>
                <span className="block text-sm text-ink-muted">{m.formula}</span>
              </th>
              {/* the figures at the body's 15 px: only the column headers and the formula are secondary text */}
              <td className="px-3 py-2.5 align-top">
                <Value m={m} />
              </td>
              <td className="px-3 py-2.5 align-top whitespace-nowrap">{m.baseline}</td>
              <td className="px-3 py-2.5 align-top">{m.target}</td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  )
}

function NarrowList({ goals, labels }: { goals: readonly KpiGoalView[]; labels: KpiTableLabels }) {
  return (
    <div className="flex flex-col gap-6 lg:hidden">
      {goals.map((g) => (
        <section key={g.code} aria-labelledby={`kpi-goal-${g.code}`} className="flex flex-col gap-2">
          <h3 id={`kpi-goal-${g.code}`} className="subheading border-y border-line bg-surface px-3 py-2 font-semibold">
            {g.code} · {g.title}
          </h3>
          <ul className="flex flex-col divide-y divide-line border-b border-line">
            {g.measures.map((m) => (
              <li key={m.id} className="flex flex-col gap-2 px-3 py-3">
                <div className="flex flex-col gap-0.5">
                  <p className="font-medium text-ink">{m.name}</p>
                  <p className="text-ink-muted">{m.formula}</p>
                </div>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                  <dt className="text-ink-muted">{labels.value}</dt>
                  <dd>
                    <Value m={m} />
                  </dd>
                  <dt className="text-ink-muted">{labels.baseline}</dt>
                  <dd>{m.baseline}</dd>
                  <dt className="text-ink-muted">{labels.target}</dt>
                  <dd>{m.target}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export function KpiTable({ goals, labels }: { goals: readonly KpiGoalView[]; labels: KpiTableLabels }) {
  return (
    <>
      <WideTable goals={goals} labels={labels} />
      <NarrowList goals={goals} labels={labels} />
    </>
  )
}

import { cn } from '../cn'

// A report's result (spec §11.3, FR-VIS-002 AC1): the columns the report defines and its rows, read within the reader's
// scope (AC3). Wide screens get a table with a caption and column headers, numbers right-aligned in tabular digits;
// phones get each row as a short list headed by its first two columns, never a table that scrolls sideways (§9.9).
// Cells arrive translated and formatted; an empty cell is a dash that reads as words.

export interface ReportColumnView {
  readonly key: string
  readonly header: string
  readonly numeric: boolean
}

export interface ReportCellView {
  readonly text: string
  /** Read instead of a dash for an empty cell, e.g. "ยังคำนวณไม่ได้" */
  readonly emptyLabel?: string
}

export interface ReportRowView {
  readonly id: string
  readonly cells: Readonly<Record<string, ReportCellView>>
}

function Cell({ cell }: { cell: ReportCellView | undefined }) {
  if (cell?.text) return <>{cell.text}</>
  return (
    <>
      <span aria-hidden="true">—</span>
      {cell?.emptyLabel ? <span className="sr-only">{cell.emptyLabel}</span> : null}
    </>
  )
}

export function ReportTable({ caption, columns, rows }: { caption: string; columns: readonly ReportColumnView[]; rows: readonly ReportRowView[] }) {
  const [first, second, ...rest] = columns
  const th = 'border-b border-line px-3 py-2 text-sm font-medium text-ink-muted'
  return (
    <>
      <table className="hidden w-full border-collapse md:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn(th, c.numeric ? 'text-right' : 'text-left')}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line">
              {columns.map((c, i) =>
                i === 1 ? (
                  <th key={c.key} scope="row" className="px-3 py-2.5 text-left align-top font-normal">
                    <Cell cell={r.cells[c.key]} />
                  </th>
                ) : (
                  <td key={c.key} className={cn('px-3 py-2.5 align-top', c.numeric ? 'money' : '')}>
                    <Cell cell={r.cells[c.key]} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <ul aria-label={caption} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5 py-3">
            <p className="font-semibold text-ink">
              {first ? <Cell cell={r.cells[first.key]} /> : null}
              {second ? (
                <>
                  {' · '}
                  <Cell cell={r.cells[second.key]} />
                </>
              ) : null}
            </p>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
              {rest.map((c) => (
                <div key={c.key} className="contents">
                  <dt className="text-ink-muted">{c.header}</dt>
                  <dd className={c.numeric ? 'money' : ''}>
                    <Cell cell={r.cells[c.key]} />
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

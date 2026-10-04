import { StateLine } from '../../request-view/status'
import type { TaskRow } from '../../tasks/task-list'
import { LiffLink } from '../liff-link'

// The member's tasks on /liff/tasks (§9.4, §9.9 principle 1): the rows of the web inbox (src/ui/tasks/task-list.tsx,
// built by the same row builder) laid out for a phone in the LINE app. Each row: what it is — the document number and
// title, a link to its LIFF decision page at least 44 px high (§9.4) — who asked and for which department, the amount
// right-aligned in tabular digits with what it is, how long it has waited and when it is due, an overdue one marked with
// an icon and words (never colour alone, NFR-A11Y-03), and its tags (the PIN it needs, whom the member holds it for).
// No cards: rows separated by rules. The links are LIFF links (no next/link in a LIFF page's first JavaScript, §9.4).

export function LiffTaskList({ rows, label }: { readonly rows: readonly TaskRow[]; readonly label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line border-y border-line">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-1 py-3">
          <LiffLink href={row.href} className="inline-flex min-h-11 items-center self-start font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
            {row.title}
          </LiffLink>
          {row.meta ? <p className="break-words text-ink-muted">{row.meta}</p> : null}
          {row.amount ? (
            <p className="flex items-baseline justify-between gap-4">
              <span className="text-ink-muted">{row.amountLabel}</span>
              <span className="money shrink-0 font-semibold text-ink">
                {row.amount}
                {row.amountUnit ? <span className="sr-only"> {row.amountUnit}</span> : null}
              </span>
            </p>
          ) : null}
          {row.states.length ? (
            <div className="flex flex-col gap-0.5">
              {row.states.map((s) => (
                <StateLine key={s.text} kind={s.kind}>
                  {s.text}
                </StateLine>
              ))}
            </div>
          ) : null}
          {row.tags.length ? (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {row.tags.map((tag) => (
                <span key={tag} className="rounded-sm border border-line px-1.5 text-ink">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

import Link from 'next/link'
import { StateLine, type StateKind } from '../request-view/status'
import type { RemindOutcome } from './outcome'
import { RemindButton } from './remind-button'

// One person's documents on the board (FR-VIS-001 AC2): each document links to its page (or the reader's own task),
// says what kind it is and since when it waits, how long in business hours, and whether it is past its due time or
// waits for the requester's answer — icons with words. A document waiting for a decision can be reminded by hand; one
// waiting for the requester cannot (the approver has nothing to do yet). No cards: rows separated by rules. Strings
// arrive translated.

export interface BoardDocumentView {
  readonly id: string
  readonly title: string
  readonly href: string | null
  /** "คำขอซื้อ · มอบงานเมื่อ 2 ต.ค. 2569 09:00 น." */
  readonly meta: string
  readonly states: ReadonlyArray<{ readonly kind: StateKind; readonly text: string }>
  readonly remind: { readonly label: string; readonly ariaLabel: string; readonly hint: string | null } | null
}

export function BoardDocuments({ documents, label, locale, remind }: { documents: readonly BoardDocumentView[]; label: string; locale: string; remind: (taskId: string, idempotencyKey: string) => Promise<RemindOutcome> }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line border-y border-line">
      {documents.map((d) => (
        <li key={d.id} className="flex flex-col gap-2 py-4">
          <div className="flex flex-col gap-0.5">
            {d.href ? (
              <Link href={d.href} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                {d.title}
              </Link>
            ) : (
              <p className="font-semibold break-words text-ink">{d.title}</p>
            )}
            <p className="text-base text-ink-muted md:text-sm">{d.meta}</p>
          </div>
          <div className="flex flex-wrap items-start gap-x-5 gap-y-1 text-base md:text-sm">
            {d.states.map((s) => (
              <StateLine key={s.text} kind={s.kind}>
                {s.text}
              </StateLine>
            ))}
          </div>
          {d.remind ? <RemindButton taskId={d.id} label={d.remind.label} ariaLabel={d.remind.ariaLabel} hint={d.remind.hint} locale={locale} remind={remind} /> : null}
        </li>
      ))}
    </ul>
  )
}

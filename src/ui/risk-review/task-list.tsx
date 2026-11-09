import Link from 'next/link'
import { StatusBadge } from '../document/badges'
import type { BadgeLook } from '../document/badge-looks'
import { TierBadge } from './badges'

// The rows of /risk/reviews (S11-06 · FR-RSK-202 AC3): one assessment a reviewer holds a slot of — its number and
// supplier (a link to the task), the parts the slot reviews, the supplier's tier, and where the task stands: when it is
// due (waiting, half its time used, overdue: the step badge of §9.10), or how it was decided and when. A task held for
// someone says for whom ("แทนคุณ…", §9.10). No decision in the list: the reviewer reads the answers first (§9.9 rule 5).
// Strings arrive translated and formatted; rows are separated by rules inside the page's card.

export interface ReviewTaskRowUi {
  readonly taskId: string
  readonly href: string
  readonly title: string
  /** The parts the slot reviews, e.g. "ส่วนที่ตรวจ: ข้อมูลส่วนบุคคล" */
  readonly meta: string
  readonly tier: { readonly code: 'LOW' | 'MEDIUM' | 'HIGH'; readonly label: string } | null
  /** Due or decided, as a badge with its icon and word */
  readonly badge: { readonly look: BadgeLook; readonly label: string }
  /** Assigned or decided at */
  readonly when: string
  /** "แทนคุณ{name}" when the member holds it for someone */
  readonly onBehalfOf: string | null
}

export function ReviewTaskList({ rows, label }: { rows: readonly ReviewTaskRowUi[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line">
      {rows.map((row) => (
        <li key={row.taskId} className="flex flex-col gap-1.5 py-3">
          <div className="flex min-w-0 flex-col">
            <Link href={row.href} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
              {row.title}
            </Link>
            <span className="text-ink-muted">{row.meta}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <StatusBadge look={row.badge.look} label={row.badge.label} className="text-base md:text-sm" />
            {row.tier ? <TierBadge tier={row.tier.code} label={row.tier.label} className="text-base md:text-sm" /> : null}
            <span className="text-ink-muted">{row.when}</span>
            {row.onBehalfOf ? <span className="rounded-sm border border-line px-1.5 text-ink">{row.onBehalfOf}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

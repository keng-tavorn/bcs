import Link from 'next/link'
import { StatusBadge } from '../document/badges'
import { Amounts, Section } from '../request-view/facts'
import { OverrunAsk, type SubmitOverrun } from './overrun-ask'
import { OverrunCancel, type CancelOverrun } from './overrun-cancel'
import { OVERRUN_BADGES, type OverrunPanelView } from './overrun-model'

// The over-budget part of a request page (S6-16 · FR-BUD-101 · BR-BUD-12): for its requester while the line is short and
// the DOA in effect has an OVER_BUDGET rule, what the request needs, what is left and what is short, with
// "ขออนุมัติเกินงบ"; for whoever reads the request, every over-budget approval asked for it — its OB number opening its
// page, its state as a badge with an icon and words (NFR-A11Y-03), the shortfall and where it stands for the request —
// and, for the requester, cancel on one that waits or is approved and not yet used. The page draws it only when there is
// something to show (overrunPanelView). The texts arrive translated; the services check every command again.
export function OverrunPanel({ requestId, view, mine, actions }: { requestId: string; view: OverrunPanelView; mine: boolean; actions: { submit: SubmitOverrun; cancel: CancelOverrun } }) {
  return (
    <Section id="overrun" title={view.title}>
      <div className="flex flex-col gap-4">
        {view.short ? (
          <div className="flex flex-col gap-2">
            <p className="text-ink">{view.short.headline}</p>
            <Amounts rows={view.short.amounts} heading={view.short.unit} unit={view.short.unit} />
            <p className="text-ink-muted">{view.short.hint}</p>
          </div>
        ) : null}
        {/* Kept for the requester whatever the request's state, so the words of what was just asked stay after the refresh */}
        {mine ? <OverrunAsk requestId={requestId} canAsk={view.canAsk} shortfall={view.shortfall} submit={actions.submit} /> : null}
        {view.rows.length ? (
          <ul aria-label={view.listLabel} className="flex flex-col divide-y divide-line border-y border-line">
            {view.rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={row.href} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
                    {row.number}
                  </Link>
                  <StatusBadge look={OVERRUN_BADGES[row.status]} label={row.statusLabel} className="h-auto text-base whitespace-normal md:text-sm" />
                </div>
                <p className="tabular text-ink">{row.shortfall}</p>
                {row.hint ? <p className="text-ink-muted">{row.hint}</p> : null}
                {row.mine ? <OverrunCancel overrunId={row.id} number={row.number} cancel={row.cancel} approved={row.status === 'APPROVED'} action={actions.cancel} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  )
}

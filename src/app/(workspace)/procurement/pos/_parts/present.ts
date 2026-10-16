import type { getTranslations } from 'next-intl/server'
import type { DocTrackEntryDto, DocTrackWhat, PoWaitingDto } from '@/server/queries/purchase-orders'
import type { ApproverRoleDto, MemberRefDto } from '@/server/queries/requests'
import type { StateKind } from '@/ui/request-view/status'
import type { TimelineItem, TimelineOutcome } from '@/ui/timeline/timeline'
import { doaHref, doaRefText, dueText, expectedText, memberName, roleText, waitingText, when, type Locale, type TimelineT, type ViewT } from '../../../_tracking/present'

// Turns the purchase-order read models into translated, formatted strings: whom a PO waits for (the list and the page
// header) and its timeline as stamps — who, position, when, channel and the DOA rule of every decision, with the
// escalated flag of a step the band above joined past its time (§9.9, FR-PLT-003 AC3, BR-SLA-04). The decision page of a
// PO or a variance task uses the same timeline.

export type PoT = Awaited<ReturnType<typeof getTranslations<'purchaseOrder'>>>

/** "name (position)" of one approver the PO waits for, with whom a delegate acts for (BR-DLG-04) */
function approverText(t: PoT, tv: ViewT, locale: Locale, a: { readonly assignee: MemberRefDto; readonly onBehalfOf: MemberRefDto | null; readonly role: ApproverRoleDto }): string {
  const who = a.onBehalfOf ? t('waiting.actingFor', { name: memberName(locale, a.assignee), principal: memberName(locale, a.onBehalfOf) }) : memberName(locale, a.assignee)
  const role = roleText(tv, locale, a.role)
  return role ? `${who} (${role})` : who
}

/** How long a wait on procurement or the supplier has lasted, in business time, as a state line (none without a calendar) */
function waitedStates(tv: ViewT, minutes: number | null): Array<{ kind: StateKind; text: string }> {
  const waited = waitingText(tv, minutes)
  return waited ? [{ kind: 'waiting', text: waited }] : []
}

/**
 * Whom the PO waits for, in words, with how long (§9.9 principle 4, FR-INT-008 AC1 for POs) — and until when for an
 * approver. An escalated step waits for its co-assignee too, whoever decides first: "A (…) หรือ B (…)" in the reader's
 * language, oldest task first (BR-SLA-04, NEW-46, as a request's "now" line); the time waited and the due time are the
 * first approver's. A draft, an approved PO and a sent one say how long procurement or the supplier has had it, and a
 * PO partly or fully received how long the rest of its goods, or its invoice and closing, have waited since its latest
 * goods receipt.
 */
export function waitingOf(t: PoT, tv: ViewT, locale: Locale, waiting: PoWaitingDto): { now: string; states: Array<{ kind: StateKind; text: string }> } {
  switch (waiting.kind) {
    case 'APPROVER': {
      if (!waiting.assignee) return { now: t('waiting.APPROVER_UNKNOWN'), states: [] }
      const lead = { assignee: waiting.assignee, onBehalfOf: waiting.onBehalfOf, role: waiting.role }
      const approvers = waiting.approvers.length ? waiting.approvers : [lead]
      const name = new Intl.ListFormat(locale, { type: 'disjunction' }).format(approvers.map((a) => approverText(t, tv, locale, a)))
      const states: Array<{ kind: StateKind; text: string }> = []
      const waited = waitingText(tv, waiting.waitingMinutes)
      if (waited) states.push({ kind: 'waiting', text: waited })
      const due = dueText(tv, locale, waiting.dueAt, waiting.overdue)
      if (due) states.push({ kind: waiting.overdue ? 'overdue' : 'due', text: due })
      return { now: t('waiting.APPROVER', { name }), states }
    }
    case 'SEND':
      return { now: waiting.bounced ? t('waiting.SEND_BOUNCED') : t('waiting.SEND'), states: waitedStates(tv, waiting.waitingMinutes) }
    case 'EDIT':
    case 'DELIVERY':
    case 'REST':
    case 'CLOSE':
      return { now: t(`waiting.${waiting.kind}`), states: waitedStates(tv, waiting.waitingMinutes) }
    default:
      return { now: t(`waiting.${waiting.kind}`), states: [] }
  }
}

const OUTCOME: Partial<Record<DocTrackWhat, TimelineOutcome>> = { APPROVED: 'approved', REJECTED: 'rejected', RETURNED: 'returned', CANCELLED: 'cancelled', BOUNCED: 'returned' }
const STAMPED: ReadonlyArray<DocTrackWhat> = ['APPROVED', 'RETURNED', 'REJECTED']
/** Steps that wait for a team rather than a person */
const TEAM: ReadonlyArray<DocTrackWhat> = ['WAIT_EDIT', 'WAIT_SEND', 'WAIT_CLOSE']
const CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'APP', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const

/**
 * The timeline of a PO or a variance as stamps (§9.9): who, position, when, channel, the DOA rule of every decision —
 * a link to its version only for readers who may open it (`doaLinks`) — and the reason of a return, a rejection, a
 * cancellation or a sending again.
 */
export function docTimelineItems(t: PoT, tv: ViewT, tl: TimelineT, locale: Locale, track: readonly DocTrackEntryDto[], options: { readonly doaLinks: boolean }): TimelineItem[] {
  return track.map((entry) => {
    const outcome = entry.state === 'done' ? (OUTCOME[entry.what] ?? 'neutral') : undefined
    let title: string
    if (entry.what === 'SUBMITTED' && entry.detail) title = t('track.submittedNumber', { number: entry.detail })
    else if (entry.what === 'RECEIVED' && entry.detail) title = t('track.receivedNumber', { number: entry.detail })
    else if (entry.what === 'REASSIGNED' && entry.other) title = t('track.reassignedTo', { name: memberName(locale, entry.other) })
    else title = t(`track.what.${entry.what}`)

    // Whom the step waits for or who acted: a member, the approver a step expects, the supplier who delivers, a team
    const actor = entry.actor
      ? memberName(locale, entry.actor)
      : entry.what === 'NEXT_APPROVAL'
        ? expectedText(locale, entry.expected)
        : entry.supplierName
          ? entry.supplierName
          : TEAM.includes(entry.what)
            ? t('track.procurement')
            : entry.what === 'DRAFTED'
              ? t('track.round')
              : entry.state === 'done'
                ? t('track.system')
                : ''
    const role = roleText(tv, locale, entry.role)
    const statusLabel =
      entry.state === 'current'
        ? t('track.statusLabel.current')
        : entry.state === 'upcoming'
          ? t('track.statusLabel.upcoming')
          : outcome && outcome !== 'neutral'
            ? t(`track.statusLabel.${outcome}`)
            : t('track.statusLabel.done')
    const channel = entry.channel && (CHANNELS as readonly string[]).includes(entry.channel) ? tl(`channel.${entry.channel as (typeof CHANNELS)[number]}`) : undefined
    const note = entry.what === 'BOUNCED' && entry.detail ? [t('track.bouncedCode', { code: entry.detail }), entry.note].filter(Boolean).join(' · ') : entry.note
    // Muted lines under the actor: whom a delegate acted for (BR-DLG-04), and the escalated flag of a decision on a step
    // the band above joined past its time (BR-SLA-04: the route's own DOA reference with the flag)
    const aside = [entry.onBehalfOf ? tv('actingFor', { name: memberName(locale, entry.onBehalfOf) }) : null, entry.escalated ? tv('timeline.escalated') : null].filter((s): s is string => Boolean(s))
    const item: TimelineItem = {
      id: entry.key,
      title,
      actor,
      state: entry.state,
      statusLabel,
      ...(role ? { role } : {}),
      ...(entry.state === 'done' && entry.at ? { when: when(locale, entry.at) } : {}),
      ...(entry.state === 'done' && channel ? { channel } : {}),
      ...(entry.doa ? { doaRef: doaRefText(tl, entry.doa), ...(options.doaLinks ? { doaHref: doaHref(entry.doa.versionId) } : {}) } : {}),
      ...(aside.length ? { onBehalfOf: aside.join(' · ') } : {}),
      ...(entry.state === 'current' && waitingText(tv, entry.waitingMinutes) ? { waiting: waitingText(tv, entry.waitingMinutes)! } : {}),
      ...(entry.state === 'current' && entry.dueAt ? { due: dueText(tv, locale, entry.dueAt, entry.overdue)!, overdue: entry.overdue } : {}),
      ...(note ? { note, ...(entry.what === 'BOUNCED' ? {} : { noteLabel: t('track.noteReason') }) } : {}),
      ...(outcome ? { outcome } : {}),
      ...(STAMPED.includes(entry.what) ? { stamp: true } : {}),
    }
    return item
  })
}

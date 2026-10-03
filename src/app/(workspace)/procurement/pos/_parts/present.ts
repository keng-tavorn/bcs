import type { getTranslations } from 'next-intl/server'
import type { DocTrackEntryDto, DocTrackWhat, PoWaitingDto } from '@/server/queries/purchase-orders'
import type { StateKind } from '@/ui/request-view/status'
import type { TimelineItem, TimelineOutcome } from '@/ui/timeline/timeline'
import { doaHref, doaRefText, dueText, expectedText, memberName, roleText, waitingText, when, type Locale, type TimelineT, type ViewT } from '../../../_tracking/present'

// Turns the purchase-order read models into translated, formatted strings: whom a PO waits for (the list and the page
// header) and its timeline as stamps — who, position, when, channel and the DOA rule of every decision (§9.9, FR-PLT-003
// AC3). The decision page of a PO or a variance task uses the same timeline.

export type PoT = Awaited<ReturnType<typeof getTranslations<'purchaseOrder'>>>

/** Whom the PO waits for, in words, with how long and until when for an approver (FR-INT-008 AC1 for POs) */
export function waitingOf(t: PoT, tv: ViewT, locale: Locale, waiting: PoWaitingDto): { now: string; states: Array<{ kind: StateKind; text: string }> } {
  switch (waiting.kind) {
    case 'APPROVER': {
      if (!waiting.assignee) return { now: t('waiting.APPROVER_UNKNOWN'), states: [] }
      const who = waiting.onBehalfOf
        ? t('waiting.actingFor', { name: memberName(locale, waiting.assignee), principal: memberName(locale, waiting.onBehalfOf) })
        : memberName(locale, waiting.assignee)
      const role = roleText(tv, locale, waiting.role)
      const states: Array<{ kind: StateKind; text: string }> = []
      const waited = waitingText(tv, waiting.waitingMinutes)
      if (waited) states.push({ kind: 'waiting', text: waited })
      const due = dueText(tv, locale, waiting.dueAt, waiting.overdue)
      if (due) states.push({ kind: waiting.overdue ? 'overdue' : 'due', text: due })
      return { now: t('waiting.APPROVER', { name: role ? `${who} (${role})` : who }), states }
    }
    case 'SEND':
      return waiting.bounced ? { now: t('waiting.SEND_BOUNCED'), states: [] } : { now: t('waiting.SEND'), states: [] }
    default:
      return { now: t(`waiting.${waiting.kind}`), states: [] }
  }
}

const OUTCOME: Partial<Record<DocTrackWhat, TimelineOutcome>> = { APPROVED: 'approved', REJECTED: 'rejected', RETURNED: 'returned', CANCELLED: 'cancelled', BOUNCED: 'returned' }
const STAMPED: ReadonlyArray<DocTrackWhat> = ['APPROVED', 'RETURNED', 'REJECTED']
/** Steps that wait for a team rather than a person */
const TEAM: ReadonlyArray<DocTrackWhat> = ['WAIT_EDIT', 'WAIT_SEND', 'WAIT_CLOSE']
const CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const

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

    const actor = entry.actor
      ? memberName(locale, entry.actor)
      : entry.what === 'NEXT_APPROVAL'
        ? expectedText(locale, entry.expected)
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
      ...(entry.onBehalfOf ? { onBehalfOf: tv('actingFor', { name: memberName(locale, entry.onBehalfOf) }) } : {}),
      ...(entry.state === 'current' && waitingText(tv, entry.waitingMinutes) ? { waiting: waitingText(tv, entry.waitingMinutes)! } : {}),
      ...(entry.state === 'current' && entry.dueAt ? { due: dueText(tv, locale, entry.dueAt, entry.overdue)!, overdue: entry.overdue } : {}),
      ...(note ? { note, ...(entry.what === 'BOUNCED' ? {} : { noteLabel: t('track.noteReason') }) } : {}),
      ...(outcome ? { outcome } : {}),
      ...(STAMPED.includes(entry.what) ? { stamp: true } : {}),
    }
    return item
  })
}

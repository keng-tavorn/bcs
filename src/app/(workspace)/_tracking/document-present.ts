import type { getTranslations } from 'next-intl/server'
import type { StepDetailDto, StepEventDto } from '@/server/queries/document-page'
import type { DocTrackEntryDto, DocTrackWhat } from '@/server/queries/purchase-orders'
import type { RouteDto, RouteStepDto, TrackEntryDto, TrackWhat } from '@/server/queries/requests'
import { STEP_BADGES, type StepBadgeKey } from '@/ui/document/badges'
import type { HistoryKind, HistoryRowView } from '@/ui/document/history-table'
import type { StepCardView } from '@/ui/document/step-cards'
import type { TimelineItem } from '@/ui/timeline/timeline'
import { doaHref, doaRefText, expectedText, memberName, nameIn, roleText, routeSentence, when, type Locale, type TimelineT, type ViewT } from './present'

// The tabbed document page in words (FR-INT-012, §9.10 "หน้าเอกสาร"): the route as step cards that turn into stamps
// (AC3), the history table and the comments of the right column from the document's Events (AC5, FR-PLT-003 AC3). Shared
// by the request page and the PO page, so both read the same (AC6).

export type DocumentT = Awaited<ReturnType<typeof getTranslations<'document'>>>

const CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const
export const channelName = (tl: TimelineT, channel: string | null): string | undefined =>
  channel && (CHANNELS as readonly string[]).includes(channel) ? tl(`channel.${channel as (typeof CHANNELS)[number]}`) : undefined

/** Business hours with one decimal at most, in the reader's digits */
export function hoursText(locale: Locale, minutes: number): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en' : 'th', { maximumFractionDigits: 1 }).format(Math.round(minutes / 6) / 10)
}

/** The badge of a step (§9.10 งานอนุมัติ): waiting neutral, warn from half of its time, danger past it; or its decision */
export function stepBadge(t: DocumentT, locale: Locale, step: RouteStepDto, detail: StepDetailDto | undefined): { key: StepBadgeKey; label: string } {
  if (step.decision) return { key: step.decision, label: t(`badge.step.${step.decision}`) }
  if (step.status === 'WAITING') return { key: 'WAITING', label: t('badge.step.WAITING') }
  if (step.status === 'CANCELLED') return { key: 'CANCELLED', label: t('badge.step.CANCELLED') }
  if (step.status === 'DONE') return { key: 'DONE', label: t('badge.step.DONE') }
  if (step.taskStatus === 'INFO_REQUESTED') return { key: 'INFO_REQUESTED', label: t('badge.step.INFO_REQUESTED') }
  const sla = detail?.sla
  if (sla?.overdue) return { key: 'OVERDUE', label: sla.overdueMinutes !== null ? t('badge.step.OVERDUE', { hours: hoursText(locale, sla.overdueMinutes) }) : t('badge.step.OVERDUE_PLAIN') }
  if (sla && sla.usedMinutes !== null && sla.targetMinutes !== null) {
    const left = Math.max(0, sla.targetMinutes - sla.usedMinutes)
    return { key: sla.usedMinutes * 2 >= sla.targetMinutes ? 'OPEN_HALF' : 'OPEN', label: t('badge.step.OPEN', { hours: hoursText(locale, left) }) }
  }
  return { key: 'OPEN', label: t('badge.step.OPEN_PLAIN') }
}

function historyText(t: DocumentT, locale: Locale, e: StepEventDto): string {
  const name = memberName(locale, e.member)
  const from = memberName(locale, e.from)
  if (e.what === 'DECIDED') return t(`steps.history.DECIDED_${e.decision ?? 'APPROVE'}`, { name })
  return t(`steps.history.${e.what}`, { name, from })
}

/**
 * The route as cards (AC3): each step's state, name, who has it, when it is due and the SLA used; once decided, the stamp —
 * name, position, time, channel and the DOA version and rule (a link to it only for readers who may open it, `doaLinks`)
 */
export function stepCards(
  t: DocumentT,
  tv: ViewT,
  tl: TimelineT,
  locale: Locale,
  route: RouteDto,
  details: readonly StepDetailDto[],
  options: { readonly doaLinks: boolean },
): StepCardView[] {
  const byNo = new Map(details.map((d) => [d.stepNo, d]))
  return route.steps.map((step) => {
    const detail = byNo.get(step.stepNo)
    const badge = stepBadge(t, locale, step, detail)
    const slotted = slottedCard(t, tv, locale, step)
    if (slotted) {
      const sla = step.status === 'ACTIVE' && !step.decision ? detail?.sla : null
      return {
        key: String(step.stepNo),
        badge: { look: STEP_BADGES[badge.key], label: badge.label },
        current: step.status === 'ACTIVE' && !step.decision,
        ...(sla?.overdue ? { overdue: true } : {}),
        people: [],
        ...slotted,
        ...(sla?.dueAt ? { due: t('steps.due', { time: when(locale, sla.dueAt) }) } : {}),
        history: (detail?.history ?? []).map((e) => ({ key: e.key, when: when(locale, e.at), text: historyText(t, locale, e), ...(e.note ? { note: e.note } : {}) })),
      }
    }
    // The step is named after the approver its rule gave it — not the co-assignee who decided an escalated step
    // (BR-SLA-04, NEW-46: their position is on the stamp) — or, before it starts, the approver the rule expects
    const ruleRole = step.ruleApprover === undefined ? step.role : (step.ruleApprover?.role ?? null)
    const role = ruleRole ? roleText(tv, locale, ruleRole) : expectedText(locale, step.expected)
    const active = step.status === 'ACTIVE' && !step.decision
    const open = step.open ?? []
    const people = active
      ? (open.length ? open : [{ approver: step.approver, onBehalfOf: step.onBehalfOf }]).map((o, i) => {
          const name = memberName(locale, o.approver)
          const shown = i === 0 ? name : tv('route.orApprover', { name })
          return o.onBehalfOf ? `${shown} · ${tv('actingFor', { name: memberName(locale, o.onBehalfOf) })}` : shown
        })
      : step.status === 'WAITING' && step.expected?.kind === 'MEMBER'
        ? [memberName(locale, step.expected.member)]
        : []
    const sla = active ? detail?.sla : null
    const decided = step.decision && step.decidedAt
    return {
      key: String(step.stepNo),
      title: role ? t('steps.title', { no: step.stepNo, role }) : t('steps.titlePlain', { no: step.stepNo }),
      badge: { look: STEP_BADGES[badge.key], label: badge.label },
      current: active,
      ...(sla?.overdue ? { overdue: true } : {}),
      people: people.filter(Boolean),
      // BR-SLA-04, NEW-46: the band above joined the step past its time, and whoever decides first decides
      ...(active && (step.escalation === 'CO_ASSIGNED' || open.length > 1)
        ? { notes: [...(step.escalation === 'CO_ASSIGNED' ? [tv('route.escalated')] : []), ...(open.length > 1 ? [tv('route.firstDecides')] : [])] }
        : {}),
      ...(sla?.dueAt ? { due: t('steps.due', { time: when(locale, sla.dueAt) }) } : {}),
      ...(sla && sla.usedMinutes !== null
        ? { sla: sla.targetMinutes !== null ? t('steps.sla', { used: hoursText(locale, sla.usedMinutes), target: hoursText(locale, sla.targetMinutes) }) : t('steps.slaUsed', { used: hoursText(locale, sla.usedMinutes) }) }
        : {}),
      ...(decided
        ? {
            stamp: {
              name: memberName(locale, step.approver),
              ...(roleText(tv, locale, step.role) ? { role: roleText(tv, locale, step.role) } : {}),
              ...(step.onBehalfOf ? { onBehalfOf: tv('actingFor', { name: memberName(locale, step.onBehalfOf) }) } : {}),
              when: when(locale, step.decidedAt!),
              ...(channelName(tl, detail?.channel ?? null) ? { channel: channelName(tl, detail?.channel ?? null)! } : {}),
              // A decision keeps the route's own rule, escalated or not (BR-SLA-04, INV-DOA-01)
              doaRef: doaRefText(tl, route.doa),
              ...(options.doaLinks ? { doaHref: doaHref(route.doa.versionId) } : {}),
              ...(step.escalation === 'CO_ASSIGNED' ? { escalated: tv('timeline.escalated') } : {}),
            },
            stampTone: step.decision === 'APPROVE' ? ('ok' as const) : step.decision === 'RETURN' ? ('warn' as const) : ('danger' as const),
          }
        : {}),
      history: (detail?.history ?? []).map((e) => ({ key: e.key, when: when(locale, e.at), text: historyText(t, locale, e), ...(e.note ? { note: e.note } : {}) })),
    }
  })
}

const SLOT_LOOK = { OPEN: 'waiting', QUESTION: 'question', APPROVE: 'done', RETURN: 'returned', REJECT: 'rejected', CLOSED: 'closed' } as const

/**
 * The card of the reviewers' step or of a committee (S6 · ADR-103): its title, how far it is and one stamp per slot —
 * every slot decides for itself, so no single person names the step and nobody "decides first" for the others
 */
function slottedCard(t: DocumentT, tv: ViewT, locale: Locale, step: RouteDto['steps'][number]): Pick<StepCardView, 'title' | 'progress' | 'slots'> | null {
  const slots = step.slots ?? []
  if ((step.stepType !== 'REVIEW' && step.stepType !== 'COMMITTEE') || slots.length === 0) return null
  const review = step.stepType === 'REVIEW'
  const passed = slots.filter((s) => s.decision === 'APPROVE').length
  const need = step.quorum === 'ANY' ? 1 : step.quorum === 'COUNT' ? (step.quorumCount ?? slots.length) : slots.length
  return {
    title: t(review ? 'steps.reviewTitle' : 'steps.committeeTitle', { no: step.stepNo }),
    progress: review ? tv('route.reviewProgress', { done: passed, total: slots.length }) : tv('route.committeeProgress', { done: passed, total: slots.length, need }),
    slots: slots.map((s) => {
      const holders = s.holders.filter((h) => h.status !== 'REASSIGNED')
      const shown = holders.length ? holders : s.holders
      const role = shown[0] ? roleText(tv, locale, shown[0].role) : ''
      const decider = s.decidedBy ? memberName(locale, s.decidedBy) : ''
      const by = s.decidedOnBehalfOf ? tv('route.decidedFor', { name: decider, principal: memberName(locale, s.decidedOnBehalfOf) }) : decider
      return {
        key: String(s.slotNo),
        who: shown.map((h, i) => (i === 0 ? memberName(locale, h.approver) : tv('route.orApprover', { name: memberName(locale, h.approver) }))).join(' '),
        ...(role ? { role } : {}),
        ...(review && s.ruleCodes.length ? { rules: tv('route.slotRules', { rules: s.ruleCodes.join(', ') }) } : {}),
        state: { kind: SLOT_LOOK[s.status], text: tv(`route.slotState.${s.status === 'APPROVE' && review ? 'PASS' : s.status}`) },
        ...(s.decidedAt && by ? { decided: `${by} · ${when(locale, s.decidedAt)}` } : {}),
      }
    }),
  }
}

/** Why the route goes where it goes, in the reader's language (the Thai record, or the sentence built from its parts) */
export const routeWhy = (tv: ViewT, tl: TimelineT, locale: Locale, route: RouteDto, subject: 'REQUEST' | 'PURCHASE_ORDER') => routeSentence(tv, tl, locale, route, subject)

const REQUEST_KIND: Partial<Record<TrackWhat, HistoryKind>> = {
  APPROVED: 'DECISION',
  RETURNED: 'DECISION',
  REJECTED: 'DECISION',
  REASSIGNED: 'DECISION',
  INFO_REQUESTED: 'QUESTION',
  INFO_PROVIDED: 'QUESTION',
}

const PO_KIND: Partial<Record<DocTrackWhat, HistoryKind>> = {
  APPROVED: 'DECISION',
  RETURNED: 'DECISION',
  REJECTED: 'DECISION',
  REASSIGNED: 'DECISION',
  SENT: 'GOODS',
  RESENT: 'GOODS',
  BOUNCED: 'GOODS',
  RECEIVED: 'GOODS',
  VARIANCE_RECORDED: 'GOODS',
  CLOSED: 'GOODS',
}

/**
 * The history table (AC5): what happened, from the Events behind the timeline — its done steps only, never what waits —
 * with the date, who (and for whom), the event and the channel. `items` are the timeline's own words for the same entries
 */
export function historyRows(t: DocumentT, items: readonly TimelineItem[], kinds: ReadonlyMap<string, HistoryKind>): HistoryRowView[] {
  return items
    .filter((item) => item.state === 'done')
    .map((item) => ({
      key: item.id,
      kind: kinds.get(item.id) ?? 'DOCUMENT',
      when: item.when ?? '',
      actor: [item.actor, item.role].filter(Boolean).join(' · '),
      ...(item.onBehalfOf ? { onBehalfOf: item.onBehalfOf } : {}),
      event: item.doaRef ? `${item.title} · ${item.doaRef}` : item.title,
      ...(item.note ? { note: item.note } : {}),
      channel: item.channel ?? t('history.noChannel'),
    }))
}

export const requestHistoryKinds = (track: readonly TrackEntryDto[]) => new Map(track.map((e) => [e.key, REQUEST_KIND[e.what] ?? 'DOCUMENT'] as const))
export const poHistoryKinds = (track: readonly DocTrackEntryDto[]) => new Map(track.map((e) => [e.key, PO_KIND[e.what] ?? 'DOCUMENT'] as const))

export interface CommentView {
  readonly key: string
  readonly kind: string
  readonly text: string
  readonly by: string
}

const COMMENT_KIND: Partial<Record<string, 'REASON' | 'QUESTION' | 'ANSWER'>> = {
  RETURNED: 'REASON',
  REJECTED: 'REASON',
  CANCELLED: 'REASON',
  RESENT: 'REASON',
  INFO_REQUESTED: 'QUESTION',
  INFO_PROVIDED: 'ANSWER',
}

/**
 * The comments of the right column: what people wrote on the document — the reasons of returns, rejections and
 * cancellations, the approvers' questions and the requester's answers — oldest first. Writing a comment of one's own is
 * not part of this round (NEW-78)
 */
export function commentViews(t: DocumentT, locale: Locale, track: ReadonlyArray<{ readonly key: string; readonly state: string; readonly what: string; readonly note: string | null; readonly actor: { readonly name: { readonly th: string; readonly en: string | null } } | null; readonly at: Date | null }>, system: string): CommentView[] {
  return track.flatMap((e) => {
    const kind = COMMENT_KIND[e.what]
    if (e.state !== 'done' || !kind || !e.note) return []
    const name = e.actor ? nameIn(locale, e.actor.name) : system
    return [{ key: e.key, kind: t(`comments.kind.${kind}`), text: e.note, by: t('comments.by', { name, time: e.at ? when(locale, e.at) : '' }) }]
  })
}

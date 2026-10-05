import type { getTranslations } from 'next-intl/server'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { formatSatang } from '@/core/money/format'
import type { ApproverRoleDto, ExpectedApproverDto, MemberRefDto, NameDto, RouteDto, RouteStepDto, StageDto, TrackEntryDto } from '@/server/queries/requests'
import { formatDateTime } from '@/ui/format'
import type { TimelineItem, TimelineOutcome } from '@/ui/timeline/timeline'

// Turns the read models of src/server/queries into translated, formatted strings for the S2-12 screens. Names come
// from the organization's data in the reader's language when it has one; money is BigInt satang formatted with
// thousands separators and 2 decimals (FR-PLT-002 AC3); dates are Buddhist-era in Thai time.

export type Locale = 'th' | 'en'
export type ViewT = Awaited<ReturnType<typeof getTranslations<'requestView'>>>
export type TimelineT = Awaited<ReturnType<typeof getTranslations<'timeline'>>>

export const localeOf = (value: string): Locale => (value === 'en' ? 'en' : 'th')

export const nameIn = (locale: Locale, name: NameDto | null | undefined): string => (name ? (locale === 'en' && name.en ? name.en : name.th) : '')
export const memberName = (locale: Locale, member: MemberRefDto | null | undefined): string => nameIn(locale, member?.name)

export const money = (satang: bigint): string => formatSatang(satang)
export const when = (locale: Locale, at: Date | string): string => formatDateTime(locale, at)
/** A calendar date "YYYY-MM-DD" as each language shows it */
export const day = (locale: Locale, date: string | Date): string => (locale === 'en' ? formatEnglishBeDate(date) : formatThaiDate(date))

/** "รองประธานสายงาน สายปฏิบัติการ", or the position alone when it is organization-wide */
export function roleText(t: ViewT, locale: Locale, role: ApproverRoleDto | null | undefined): string {
  if (!role) return ''
  switch (role.kind) {
    case 'POSITION': {
      const position = role.position ? nameIn(locale, role.position) : role.positionCode
      return role.orgWide || !role.department ? position : t('role.positionIn', { position, department: nameIn(locale, role.department) })
    }
    case 'NAMED':
      return t('role.named')
    case 'SIGNATORY':
      return t('role.signatory')
    default:
      return ''
  }
}

export function expectedText(locale: Locale, expected: ExpectedApproverDto | null | undefined): string {
  if (!expected) return ''
  return expected.kind === 'MEMBER' ? memberName(locale, expected.member) : expected.position ? nameIn(locale, expected.position) : expected.positionCode
}

/** Business time waited (FR-INT-008 AC1): hours with one decimal, minutes under an hour; integers only */
export function waitingText(t: ViewT, minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null
  if (minutes <= 0) return t('waiting.notStarted')
  if (minutes < 60) return t('waiting.minutes', { minutes })
  const tenths = Math.round(minutes / 6)
  const hours = tenths % 10 === 0 ? String(tenths / 10) : `${Math.floor(tenths / 10)}.${tenths % 10}`
  return t('waiting.hours', { hours })
}

export function dueText(t: ViewT, locale: Locale, dueAt: Date | null | undefined, overdue: boolean): string | null {
  if (!dueAt) return null
  return overdue ? t('waiting.overdue', { time: when(locale, dueAt) }) : t('waiting.due', { time: when(locale, dueAt) })
}

const FILE_KINDS = ['QUOTATION', 'DELIVERY_NOTE', 'PHOTO', 'JUSTIFICATION', 'INVOICE', 'PO_PDF', 'DPA', 'ETAX', 'REGISTRY_PROOF', 'OTHER'] as const
/** FileLink.kind as a message key; anything unknown reads as "other document" */
export const fileKind = (kind: string): (typeof FILE_KINDS)[number] => ((FILE_KINDS as readonly string[]).includes(kind) ? (kind as (typeof FILE_KINDS)[number]) : 'OTHER')

/** "DOA-DEMO ฉบับ 1 ข้อ PR-02" (FR-DOA-005 AC2) */
export const doaRefText = (tl: TimelineT, doa: { code: string; versionNo: number; ruleCode: string }): string => tl('doaRef', { code: doa.code, version: doa.versionNo, rule: doa.ruleCode })
export const doaHref = (versionId: string): string => `/admin/doa/${versionId}`

const CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const
const channelText = (tl: TimelineT, channel: string | null): string | undefined =>
  channel && (CHANNELS as readonly string[]).includes(channel) ? tl(`channel.${channel as (typeof CHANNELS)[number]}`) : undefined

const OUTCOME: Partial<Record<TrackEntryDto['what'], TimelineOutcome>> = { APPROVED: 'approved', REJECTED: 'rejected', RETURNED: 'returned', CANCELLED: 'cancelled' }
const STAMPED: ReadonlyArray<TrackEntryDto['what']> = ['APPROVED', 'RETURNED', 'REJECTED']
const TEAM: ReadonlyArray<TrackEntryDto['what']> = ['WAIT_PROCUREMENT', 'NEXT_PROCUREMENT', 'WAIT_DELIVERY', 'WAIT_QUEUE']

function noteLabel(t: ViewT, what: TrackEntryDto['what']): string | undefined {
  if (what === 'RETURNED' || what === 'REJECTED' || what === 'CANCELLED') return t('timeline.noteReason')
  if (what === 'INFO_REQUESTED' || what === 'WAIT_ANSWER') return t('timeline.noteQuestion')
  if (what === 'INFO_PROVIDED') return t('timeline.noteAnswer')
  return undefined
}

/**
 * The tracking timeline as stamps (§9.9): who, position, when, channel and the DOA rule of every decision. The rule links
 * to its version only for readers who may open it (`doaLinks`, see canOpenDoaVersion); others read it as text.
 */
export function timelineItems(
  t: ViewT,
  tl: TimelineT,
  locale: Locale,
  track: readonly TrackEntryDto[],
  options: { readonly stepCount?: number; readonly doaLinks?: boolean } = {},
): TimelineItem[] {
  const many = (options.stepCount ?? 1) > 1
  return track.map((entry) => {
    const outcome = entry.state === 'done' ? (OUTCOME[entry.what] ?? 'neutral') : undefined
    let title: string
    if (entry.what === 'SUBMITTED' && entry.number) title = t('timeline.submittedNumber', { number: entry.number })
    else if (entry.what === 'WAIT_APPROVAL' && many && entry.stepNo) title = t('timeline.waitStep', { no: entry.stepNo })
    else if (entry.what === 'NEXT_APPROVAL' && entry.stepNo) title = t('timeline.nextStep', { no: entry.stepNo })
    else if (entry.what === 'REASSIGNED' && entry.other) title = t('timeline.reassignedTo', { name: memberName(locale, entry.other) })
    else title = t(`timeline.what.${entry.what}`)

    const actor = entry.actor
      ? memberName(locale, entry.actor)
      : entry.what === 'NEXT_APPROVAL'
        ? expectedText(locale, entry.expected)
        : TEAM.includes(entry.what)
          ? t('procurement')
          : entry.state === 'done'
            ? t('system')
            : ''
    const role = entry.what === 'WAIT_ANSWER' && entry.other ? t('timeline.askedBy', { name: memberName(locale, entry.other) }) : roleText(t, locale, entry.role)
    // Muted lines under the actor: whom a delegate acted for (BR-DLG-04), and the escalated flag of a decision on a step
    // the band above joined past its time (BR-SLA-04: the route's own DOA reference with the flag)
    const aside = [entry.onBehalfOf ? t('actingFor', { name: memberName(locale, entry.onBehalfOf) }) : null, entry.escalated ? t('timeline.escalated') : null].filter((s): s is string => Boolean(s))
    const statusLabel =
      entry.state === 'current'
        ? t('timeline.statusLabel.current')
        : entry.state === 'upcoming'
          ? t('timeline.statusLabel.upcoming')
          : outcome && outcome !== 'neutral'
            ? t(`timeline.statusLabel.${outcome}`)
            : t('timeline.statusLabel.done')
    const item: TimelineItem = {
      id: entry.key,
      title,
      actor,
      state: entry.state,
      statusLabel,
      ...(role ? { role } : {}),
      ...(entry.state === 'done' && entry.at ? { when: when(locale, entry.at) } : {}),
      ...(entry.state === 'done' && channelText(tl, entry.channel) ? { channel: channelText(tl, entry.channel)! } : {}),
      ...(entry.doa ? { doaRef: doaRefText(tl, entry.doa), ...(options.doaLinks ? { doaHref: doaHref(entry.doa.versionId) } : {}) } : {}),
      ...(aside.length ? { onBehalfOf: aside.join(' · ') } : {}),
      ...(entry.state === 'current' && waitingText(t, entry.waitingMinutes) ? { waiting: waitingText(t, entry.waitingMinutes)! } : {}),
      ...(entry.state === 'current' && entry.dueAt ? { due: dueText(t, locale, entry.dueAt, entry.overdue)!, overdue: entry.overdue } : {}),
      ...(entry.note ? { note: entry.note, ...(noteLabel(t, entry.what) ? { noteLabel: noteLabel(t, entry.what)! } : {}) } : {}),
      ...(outcome ? { outcome } : {}),
      ...(STAMPED.includes(entry.what) ? { stamp: true } : {}),
    }
    return item
  })
}

/** "name (position)" of an approver a step waits for */
function approverText(t: ViewT, locale: Locale, a: { readonly assignee: MemberRefDto; readonly onBehalfOf: MemberRefDto | null; readonly role: ApproverRoleDto }): string {
  const role = roleText(t, locale, a.role)
  const who = memberName(locale, a.assignee)
  // A delegate holds the task: the position is the delegator's, so the line says whom they act for (BR-DLG-04)
  if (a.onBehalfOf) {
    const principal = memberName(locale, a.onBehalfOf)
    return `${who} (${role ? t('stage.actingForRole', { name: principal, role }) : t('stage.actingFor', { name: principal })})`
  }
  return role ? `${who} (${role})` : who
}

/** Where the request is now, in one line (lists, home, the header of the request page) */
export function stageText(t: ViewT, locale: Locale, stage: StageDto, mine: boolean): string {
  switch (stage.kind) {
    case 'APPROVER': {
      // An escalated step waits for its co-assignee too, whoever decides first: "A (…) หรือ B (…)" (BR-SLA-04, NEW-46)
      const approvers = stage.approvers?.length ? stage.approvers : [stage]
      return t('stage.APPROVER', { name: new Intl.ListFormat(locale, { type: 'disjunction' }).format(approvers.map((a) => approverText(t, locale, a))) })
    }
    case 'ANSWER':
      return t(mine ? 'stage.ANSWER_MINE' : 'stage.ANSWER')
    case 'REQUESTER_EDIT':
      return t(mine ? 'stage.REQUESTER_EDIT_MINE' : 'stage.REQUESTER_EDIT')
    default:
      return t(`stage.${stage.kind}`)
  }
}

/** Whom the route's rule gave a step: "name (position)", and for a delegate whom they act for (the Thai record's "(… รักษาการแทน …)") */
function ruleApproverText(t: ViewT, locale: Locale, step: RouteStepDto): string {
  // A step made elsewhere (a preview of the engine's route) has its rule's approver in `approver`
  const named = step.ruleApprover === undefined ? (step.approver || step.role ? { approver: step.approver, onBehalfOf: step.onBehalfOf, role: step.role } : null) : step.ruleApprover
  // Not started yet: the approver its rule expects
  if (!named) return expectedText(locale, step.expected)
  const who = memberName(locale, named.approver)
  const role = roleText(t, locale, named.role)
  if (who && named.onBehalfOf) {
    const principal = memberName(locale, named.onBehalfOf)
    return `${who} (${role ? t('stage.actingForRole', { name: principal, role }) : t('stage.actingFor', { name: principal })})`
  }
  return role && who ? `${who} (${role})` : who || role
}

/**
 * The English sentence of a route (the Thai record is RouteDto.explanationTh, core/doa/explain.ts), naming whom the
 * rule gave each step as the Thai record does (BR-DOA-10) — never whoever decided an escalated step in their place
 * (BR-SLA-04, NEW-46: the co-assignee who decided first is the step's `approver`)
 */
export function routeSentence(t: ViewT, tl: TimelineT, locale: Locale, route: RouteDto, subjectType: 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE' | 'DOA_VERSION' | 'ORG_AUTHORITY_CHANGE'): string {
  if (locale === 'th') return route.explanationTh
  const parts = [`${doaRefText(tl, route.doa)}:`]
  const document = t(`route.explain.document.${subjectType}`)
  parts.push(route.basisSatang !== null ? t('route.explain.subject', { document, amount: money(route.basisSatang), basis: t(`route.explain.basis.${route.amountBasis}`) }) : document)
  const band = route.band
  if (band) {
    const lower = band.lowerSatang !== null && band.lowerSatang > 0n ? money(band.lowerSatang) : null
    const upper = band.upperSatang !== null ? money(band.upperSatang) : null
    if (lower && upper) parts.push(t('route.explain.bandBetween', { lower, upper }))
    else if (lower) parts.push(t('route.explain.bandAbove', { lower }))
    else if (upper) parts.push(t('route.explain.bandUpTo', { upper }))
  }
  if (route.escalatedFromRuleCode) parts.push(`(${t('route.explain.escalated', { from: route.escalatedFromRuleCode, rule: route.doa.ruleCode })})`)
  const sentence = parts.join(' ')
  const approvers = route.steps.map((s) => ruleApproverText(t, locale, s)).filter(Boolean)
  // "…, goes to …": a comma ends the amount and its band before the approvers
  return approvers.length ? `${sentence}, ${t('route.explain.to', { approvers: approvers.join(', ') })}` : sentence
}

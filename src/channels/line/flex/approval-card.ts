import { cardLabel, doaReference, priceBadgeText, subjectKind } from './labels'
import { DANGER, heading, INK, PRIMARY, row, SURFACE, vertical, WARN } from './style'
import { ACTION_LABEL_MAX_LENGTH, bahtOf, CARD_LABEL_MAX_LENGTH, CARD_NAME_MAX_LENGTH, clip, dateTimeOf } from './text'
import type { CardLocale, FlexAction, FlexButton, FlexComponent, FlexMessage } from './types'

// The approval card (spec §9.3, FR-LINE-002 AC1, BR-LINE-06, BR-NOTI-01): a summary only — the document's number, its
// type, the requester and department, the amount on the DOA's basis, the budget status, the due time, the DOA version
// and rule ("DOA-DEMO ฉบับ 1 ข้อ PR-02") and a badge for an acting or an escalated task. No line items, prices, files or
// other people. Buttons (§9.3):
//  - "อนุมัติ": a postback `v=1&a=approve&k=<tokenId>` (BR-TOK-02), only when the task may be decided in the chat — below
//    the version's stepUpThreshold and not a policy task — and a LINE ActionToken is live for the reader (BR-TOK-05);
//  - "อนุมัติ (ยืนยัน PIN)": the LIFF page /liff/tasks/<taskId>?action=approve when a step-up is needed; without a token
//    the same page opens with the plain "อนุมัติ" label;
//  - "ตีกลับ / ไม่อนุมัติ" and "ดูรายละเอียด": always, on the LIFF page (a reason is typed there).
// A reviewer's task (S6 · BR-WF-09) says so in its header with the workflow rules it answers for, and its buttons are
// "ผ่าน" (the same postback; a reviewer needs no PIN) and "ตีกลับ" on the LIFF page: a reviewer never rejects.
// Pure: the caller passes what to show; the card never reads the database or the clock.

const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ApprovalCardData {
  readonly locale: CardLocale
  readonly subjectType: string
  /** The request type in the reader's language; null shows the kind of document */
  readonly typeName: string | null
  /** The document's number, or its title before it has one */
  readonly label: string
  /** The requester, the only person a LINE message may name (BR-NOTI-01); null for documents without one */
  readonly requester: { readonly name: string; readonly department: string | null } | null
  /** The amount the DOA counted (ApprovalRoute.amountSatang); null for a subject without one */
  readonly amountSatang: bigint | null
  readonly amountBasis: 'NET' | 'GROSS' | null
  /** RESERVED: the request's budget is reserved (จองแล้ว) · ENOUGH: there is enough (พอ) · null: not shown */
  readonly budget: 'RESERVED' | 'ENOUGH' | null
  readonly dueAt: Date | null
  readonly overdue: boolean
  readonly doa: { readonly code: string; readonly versionNo: number; readonly ruleCode: string }
  /** A delegate holds the task (BR-DLG-04) */
  readonly acting: boolean
  /** The task was escalated past its time (BR-SLA-04) */
  readonly escalated: boolean
  /** stepUpNeeded() of src/core/pin: the amount is at or above stepUpThreshold, or a policy task (BR-TOK-05) */
  readonly stepUp: boolean
  /** The reader's live LINE ActionToken of this task; null when none (the approve button then opens LIFF) */
  readonly tokenId: string | null
  /** A reviewer's task: the workflow rules it answers for (S6); null for every other task */
  readonly review?: { readonly ruleCodes: readonly string[] } | null
  /** S6-11 (BR-PRC-05): the request's one price badge — counts and percents only; null or left out when no line is HIGH or LOW */
  readonly priceBadge?: { readonly high: { readonly lines: number; readonly maxPct: number } | null; readonly low: { readonly lines: number; readonly minPct: number } | null } | null
  readonly links: {
    /** /liff/tasks/<taskId>?action=approve */
    readonly approve: string
    /** The LIFF page where a return or a rejection is decided with its reason */
    readonly decline: string
    /** /liff/tasks/<taskId> */
    readonly details: string
  }
}

/** The postback data of the approve button: exactly v, a and k (BR-TOK-02) */
export const approvePostbackData = (tokenId: string) => `v=1&a=approve&k=${tokenId}`

/** Whether the card carries the in-chat approve button: never for a step-up, and only with a token (BR-TOK-05) */
export function approvesInChat(data: Pick<ApprovalCardData, 'stepUp' | 'tokenId'>): boolean {
  return !data.stepUp && data.tokenId !== null && TOKEN_ID.test(data.tokenId)
}

const label = (text: string) => clip(text, ACTION_LABEL_MAX_LENGTH)

function approveAction(data: ApprovalCardData, documentLabel: string): FlexAction {
  const t = data.locale
  if (approvesInChat(data)) {
    const verb = cardLabel(data.review ? 'pass' : 'approve', t)
    return { type: 'postback', label: label(verb), data: approvePostbackData(data.tokenId!), displayText: `${verb} ${documentLabel}` }
  }
  return { type: 'uri', label: label(cardLabel(data.review ? 'pass' : data.stepUp ? 'approveWithPin' : 'approve', t)), uri: data.links.approve }
}

export function approvalCard(data: ApprovalCardData): FlexMessage {
  const t = data.locale
  const documentLabel = clip(data.label, CARD_LABEL_MAX_LENGTH)
  const kind = clip(data.typeName ?? subjectKind(data.subjectType, t), CARD_NAME_MAX_LENGTH)

  const badges: FlexComponent[] = [
    ...(data.acting ? [{ type: 'text' as const, text: cardLabel('acting', t), size: 'md' as const, color: WARN, wrap: true }] : []),
    ...(data.escalated ? [{ type: 'text' as const, text: cardLabel('escalated', t), size: 'md' as const, color: DANGER, wrap: true }] : []),
  ]

  const rows: FlexComponent[] = [row(cardLabel('number', t), documentLabel), row(cardLabel('type', t), kind)]
  if (data.requester) {
    const name = clip(data.requester.name, CARD_NAME_MAX_LENGTH)
    const department = data.requester.department ? clip(data.requester.department, CARD_NAME_MAX_LENGTH) : null
    rows.push(row(cardLabel('requester', t), department ? `${name} · ${department}` : name))
  }
  if (data.amountSatang !== null) {
    const basis = data.amountBasis === 'NET' ? cardLabel('basisNet', t) : data.amountBasis === 'GROSS' ? cardLabel('basisGross', t) : null
    rows.push(row(cardLabel('amount', t), basis ? `${bahtOf(data.amountSatang, t)} (${basis})` : bahtOf(data.amountSatang, t)))
  }
  if (data.budget) rows.push(row(cardLabel('budget', t), cardLabel(data.budget === 'RESERVED' ? 'budgetReserved' : 'budgetEnough', t)))
  if (data.dueAt) {
    const due = dateTimeOf(data.dueAt, t)
    rows.push(data.overdue ? row(cardLabel('due', t), `${due} · ${cardLabel('overdue', t)}`, DANGER) : row(cardLabel('due', t), due))
  }
  if (data.priceBadge && (data.priceBadge.high || data.priceBadge.low)) rows.push(row(cardLabel('price', t), priceBadgeText(data.priceBadge, t), WARN))
  if (data.review?.ruleCodes.length) rows.push(row(cardLabel('reviewRules', t), clip(data.review.ruleCodes.join(', '), CARD_NAME_MAX_LENGTH)))
  rows.push(row(cardLabel('doa', t), doaReference(data.doa, t)))
  if (data.stepUp) rows.push({ type: 'text', text: cardLabel('pinNeeded', t), size: 'md', color: WARN, wrap: true, margin: 'md' })

  const buttons: FlexButton[] = [
    { type: 'button', style: 'primary', color: PRIMARY, height: 'md', action: approveAction(data, documentLabel) },
    { type: 'button', style: 'secondary', height: 'md', action: { type: 'uri', label: label(cardLabel(data.review ? 'returnOnly' : 'decline', t)), uri: data.links.decline } },
    { type: 'button', style: 'link', height: 'md', color: PRIMARY, action: { type: 'uri', label: label(cardLabel('details', t)), uri: data.links.details } },
  ]

  return {
    type: 'flex',
    altText: `${cardLabel('altText', t)}: ${kind} ${documentLabel}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: vertical([heading(cardLabel(data.review ? 'reviewHeader' : 'header', t), INK), ...badges], { paddingAll: '16px', backgroundColor: SURFACE, spacing: 'sm' }),
      body: vertical(rows, { spacing: 'md', paddingAll: '16px' }),
      footer: vertical(buttons, { spacing: 'md', paddingAll: '16px' }),
    },
  }
}

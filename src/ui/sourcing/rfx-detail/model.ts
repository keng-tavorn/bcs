import { MS_PER_HOUR } from '@/lib/constants'
import type { BadgeLook } from '../../document/badge-looks'

// The shapes the RFx page (S10-12 · /sourcing/[id]) passes between its server actions and its parts, and the pure
// helpers they share. The page maps the service's DTO to these (the screens do not import services).

export type Locale = 'th' | 'en'

export interface NameText {
  readonly th: string
  readonly en: string | null
}

export const nameIn = (locale: Locale, name: NameText | null | undefined): string => (name ? (locale === 'en' && name.en ? name.en : name.th) : '')

/** What a command of the page answers: done, or the code (and reason) of the refusal, safe to show */
export type RfxActionOutcome = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason?: string }
export type RfxExportOutcome = { readonly ok: true; readonly fileId: string } | { readonly ok: false; readonly code: string; readonly reason?: string }

/** The refusals the page names in words (sourcing.detail.errors.*); anything else is OTHER */
export const RFX_ERROR_KEYS = [
  'UNAUTHENTICATED',
  'MODULE_DISABLED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT_VERSION',
  'INVALID_STATE_TRANSITION',
  'VALIDATION_FAILED',
  'PAST_CLOSE',
  'AWARD_OPEN',
  'NOT_RFI',
  'CLOSE_NOT_LATER',
  'NO_CHANGE',
  'INVITES_WAITING',
  'ASKER_ONLY_REASON',
  'SEALED',
  'OTHER',
] as const
export type RfxErrorKey = (typeof RFX_ERROR_KEYS)[number]

/** The key of a refusal: its reason when the page names it, else its code, else OTHER */
export function errorKey(outcome: { readonly code: string; readonly reason?: string }): RfxErrorKey {
  const known = (v: string | undefined): v is RfxErrorKey => v !== undefined && (RFX_ERROR_KEYS as readonly string[]).includes(v)
  if (known(outcome.reason)) return outcome.reason
  return known(outcome.code) ? outcome.code : 'OTHER'
}

/** A value as one of the keys of a message group; an unknown value falls back */
export function keyIn<T extends string>(keys: readonly T[], value: string, fallback: T): T {
  return (keys as readonly string[]).includes(value) ? (value as T) : fallback
}

export const RFX_STATUS_KEYS = ['DRAFT', 'OPEN', 'CLOSED', 'EVALUATING', 'AWARDED', 'CONCLUDED', 'CANCELLED'] as const
/** One table with the list's (../rfx-looks.ts) */
export { RFX_STATUS_LOOK } from '../rfx-looks'

export const INVITE_STATUS_KEYS = ['INVITED', 'VIEWED', 'DECLINED', 'BID_SUBMITTED', 'WITHDRAWN', 'EXPIRED', 'REMOVED'] as const
export { INVITE_STATUS_LOOK } from '../rfx-looks'

export const QUESTION_STATUS_KEYS = ['OPEN', 'ANSWERED', 'WITHDRAWN'] as const
export const QUESTION_STATUS_LOOK: Readonly<Record<(typeof QUESTION_STATUS_KEYS)[number], BadgeLook>> = {
  OPEN: { tone: 'warn', icon: 'MessageCircleQuestion' },
  ANSWERED: { tone: 'ok', icon: 'CircleCheck' },
  WITHDRAWN: { tone: 'neutral', icon: 'Ban' },
}

export const SCORECARD_STATUS_KEYS = ['DRAFT', 'LOCKED', 'REVEALED'] as const
export const SCORECARD_STATUS_LOOK: Readonly<Record<(typeof SCORECARD_STATUS_KEYS)[number], BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  LOCKED: { tone: 'warn', icon: 'Hourglass' },
  REVEALED: { tone: 'ok', icon: 'CircleCheck' },
}

export const EVALUATOR_STATUS_KEYS = ['ASSIGNED', 'SUBMITTED', 'RECUSED'] as const

export const AWARD_STATUS_KEYS = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED'] as const

export const PRICE_FLAG_KEYS = ['ABOVE_AGREEMENT', 'HIGH', 'LOW'] as const
export const BID_TAG_KEYS = ['VAT_INCLUDED', 'NOT_VAT_REGISTERED', 'FOREIGN', 'INCUMBENT', 'ON_BEHALF', 'BEFORE_REVISION'] as const
export const REF_SOURCE_KEYS = ['AGREEMENT', 'AGREEMENT_OTHER', 'CATALOG', 'HISTORY', 'MANUAL', 'NONE'] as const

/** The timeline's event types the page names; anything else reads as a change */
export const EVENT_KEYS = [
  'rfx.created',
  'rfx.updated',
  'rfx.unsealed',
  'rfx.lines_changed',
  'rfx.opened',
  'rfx.amended',
  'rfx.extended',
  'rfx.reminded',
  'rfx.closed',
  'rfx.evaluating',
  'rfx.awarded',
  'rfx.concluded',
  'rfx.cancelled',
  'rfx.reopened',
  'rfx.question_asked',
  'rfx.question_answered',
  'other',
] as const
/** A message key cannot hold a dot: rfx.opened → rfx_opened */
type DotToUnderscore<S extends string> = S extends `${infer A}.${infer B}` ? `${A}_${B}` : S
export type EventMessageKey = DotToUnderscore<(typeof EVENT_KEYS)[number]>
export const eventKey = (type: string): EventMessageKey => keyIn(EVENT_KEYS, type, 'other').replace('.', '_') as EventMessageKey

const BANGKOK_OFFSET_MS = 7 * MS_PER_HOUR

/** An instant as the value of an <input type="datetime-local"> in Bangkok time (yyyy-mm-ddThh:mm) */
export function toBangkokInput(isoText: string | null): string {
  if (!isoText) return ''
  const t = Date.parse(isoText)
  if (Number.isNaN(t)) return ''
  return new Date(t + BANGKOK_OFFSET_MS).toISOString().slice(0, 16)
}

/** The value of an <input type="datetime-local"> read as Bangkok time, as ISO text with its offset; null when malformed */
export function fromBangkokInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const text = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+07:00`
  const t = Date.parse(text)
  // a date that does not exist (31 Feb) rolls over in Date: refuse it rather than move it
  return Number.isNaN(t) || toBangkokInput(new Date(t).toISOString()) !== value.trim() ? null : text
}

/** The page's data as the service gives it (the DTO of rfxDetail, read structurally) */
export interface RfxDetailView {
  readonly reading: 'PRICES' | 'STATE'
  readonly rfx: {
    readonly id: string
    readonly number: string | null
    readonly kind: string
    readonly status: string
    readonly title: string
    readonly titleEn: string | null
    readonly description: string
    readonly descriptionEn: string | null
    readonly categoryCode: string
    readonly sourceKind: string
    readonly sealed: boolean
    readonly allowPartialBids: boolean
    readonly allowVatInclusiveBids: boolean
    readonly bidValidityDays: number
    readonly minInvites: number
    readonly revisionNo: number
    readonly version: number
    readonly createdAt: string
    readonly openedAt: string | null
    readonly closesAt: string | null
    readonly questionCutoffAt: string | null
    readonly closedAt: string | null
    readonly cancelledAt: string | null
    readonly cancelReason: string | null
    readonly conclusionNote: string | null
    readonly createdBy: NameText | null
    readonly requestingDepartment: NameText | null
    readonly beforeClose: boolean
  }
  readonly lines: ReadonlyArray<{
    readonly id: string
    readonly lineNo: number
    readonly description: string
    readonly descriptionEn: string | null
    readonly quantity: string
    readonly uom: string
    readonly uomEn: string | null
    readonly deliverySite: { readonly code: string; readonly name: string } | null
    readonly requiredDeliveryOn: string | null
    readonly note: string | null
    readonly reference: { readonly unitPrice: string; readonly source: string | null } | null
    readonly sourceCount: number
  }>
  readonly timeline: ReadonlyArray<{ readonly id: string; readonly type: string; readonly occurredAt: string; readonly actor: { readonly kind: 'MEMBER'; readonly name: NameText } | { readonly kind: 'SYSTEM' } | { readonly kind: 'SUPPLIER' } }>
  readonly invites: ReadonlyArray<{
    readonly id: string
    readonly status: string
    readonly name: string
    readonly supplierCode: string | null
    readonly application: boolean
    readonly invitedAt: string
    readonly viewedAt: string | null
    readonly declinedAt: string | null
    readonly declineReason: string | null
    readonly removedAt: string | null
    readonly removeReason: string | null
    readonly needsReconfirm: boolean
    readonly snapshot: { readonly isVatRegistered: boolean | null; readonly isForeign: boolean | null; readonly registryFlag: string | null; readonly requiredDocumentsOk: boolean | null }
    readonly risk: { readonly tier: string | null; readonly status: string | null; readonly blocked: boolean } | null
  }>
  readonly questions: ReadonlyArray<{
    readonly id: string
    readonly status: string
    readonly question: string
    readonly askedAt: string
    readonly askerName: string
    readonly answer: string | null
    readonly answeredAt: string | null
    readonly answeredBy: NameText | null
    readonly visibility: string
  }>
  readonly amendments: ReadonlyArray<{
    readonly revisionNo: number
    readonly summary: string
    readonly summaryEn: string | null
    readonly changedFields: readonly string[]
    readonly previousClosesAt: string | null
    readonly newClosesAt: string | null
    readonly createdAt: string
    readonly createdBy: NameText | null
  }>
  readonly scores: {
    readonly status: string
    readonly minEvaluators: number
    readonly criteria: ReadonlyArray<{ readonly code: string; readonly name: NameText; readonly kind: string; readonly weightBp: number }>
    readonly evaluators: ReadonlyArray<{ readonly memberId: string; readonly name: NameText; readonly status: string; readonly submittedAt: string | null }>
    readonly ranking: ReadonlyArray<{ readonly bidId: string; readonly supplierName: string; readonly rank: number; readonly priceBp: number; readonly criteria: Readonly<Record<string, number>>; readonly totalBp: number }> | null
  } | null
  readonly awards: ReadonlyArray<{
    readonly id: string
    readonly number: string | null
    readonly status: string
    readonly isSplit: boolean
    readonly net: string
    readonly vat: string
    readonly gross: string
    readonly poStatus: string
    readonly submittedAt: string | null
    readonly decidedAt: string | null
    readonly cancelReason: string | null
    readonly purchaseOrders: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly status: string; readonly supplierName: string; readonly gross: string }>
    readonly priceAgreements: number
  }>
  readonly modules: { readonly risk: boolean }
  readonly can: {
    readonly manage: boolean
    readonly award: boolean
    readonly score: boolean
    readonly cancel: boolean
    readonly closeEarly: boolean
    readonly conclude: boolean
    readonly amend: boolean
    readonly extend: boolean
    readonly answer: boolean
    readonly invite: boolean
  }
}

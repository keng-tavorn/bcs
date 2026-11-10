import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { BadgeLook } from '../document/badge-looks'
import { validDay } from '../catalog/model'

// What /suppliers/preferred shows and sends (S10-13 · BR-RFX-14 · docs/sub-specs/S10.md "หน้าจอ"): the rows as the page
// receives them (screens may not import services, so these mirror src/server/services/sourcing/preferred-view.ts and
// the page passes its DTOs in, which TypeScript checks), the badges of a row's standing and risk, the checks the forms
// run as procurement types (the service checks every one again), and a refusal turned into the key of its words — never
// the raw message (§9.9 rule 7, §14.2). Pure: days are YYYY-MM-DD text.

export type PreferredRowStatus = 'IN_EFFECT' | 'ENDING_SOON' | 'UPCOMING' | 'ENDED' | 'EXPIRED'

export interface PreferredRowView {
  readonly id: string
  readonly categoryCode: string
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: { readonly th: string; readonly en: string | null }
  readonly supplierActive: boolean
  readonly source: 'SOURCING' | 'MANUAL'
  readonly award: { readonly number: string | null; readonly rfxEventId: string } | null
  readonly note: string | null
  /** Included */
  readonly validFrom: string
  /** Included: the last day it applies */
  readonly lastDay: string
  readonly status: PreferredRowStatus
  readonly daysLeft: number | null
  readonly ended: { readonly at: string; readonly reason: string | null } | null
  readonly risk: { readonly tier: string | null; readonly status: string | null; readonly registryFlag: string } | null
  readonly riskExempt: boolean
  readonly canEnd: boolean
}

export interface PreferredSupplierChoice {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
}

/** What "ตั้งผู้ขายที่แนะนำ" sends: the last day included and blank when the organization's default period applies */
export interface NewPreferredInput {
  readonly categoryCode: string
  readonly supplierId: string
  readonly validFrom: string
  readonly lastDay: string
  readonly note: string
}

export interface EndPreferredInput {
  readonly preferredSupplierId: string
  readonly reason: string
}

/** The shortest reason the commands take (preferred.ts) */
export const PREFERRED_REASON_MIN = 3
/** The longest reason the commands take (the same limit as every reason of the services) */
export const PREFERRED_REASON_MAX = REASON_MAX_LENGTH

// ---------- badges (§9.10: a light colour with an icon and the word, never colour alone) ----------

export const PREFERRED_STATUS_LOOK: Readonly<Record<PreferredRowStatus, BadgeLook>> = {
  IN_EFFECT: { tone: 'ok', icon: 'CircleCheck' },
  ENDING_SOON: { tone: 'warn', icon: 'Hourglass' },
  UPCOMING: { tone: 'info', icon: 'Clock' },
  ENDED: { tone: 'neutral', icon: 'Ban' },
  EXPIRED: { tone: 'neutral', icon: 'Lock' },
}

/** The supplier's tier with RISK on: a fact, not a warning */
export const RISK_TIER_LOOK: BadgeLook = { tone: 'neutral', icon: 'Gauge' }
/** BR-RFX-14: recommended but at risk (overdue or due for reassessment, or flagged by the registry) */
export const AT_RISK_LOOK: BadgeLook = { tone: 'danger', icon: 'Gauge' }
/** A supplier no longer in use: the request form does not fill it, whatever the period */
export const INACTIVE_SUPPLIER_LOOK: BadgeLook = { tone: 'neutral', icon: 'Ban' }

/** Codes the page has words for; any other is shown as it comes */
export const RISK_TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const
export const RISK_STATUSES = ['NOT_ASSESSED', 'IN_PROGRESS', 'CURRENT', 'EXPIRING', 'OVERDUE', 'REASSESS_REQUIRED'] as const
export const REGISTRY_FLAGS = ['CEASED', 'VAT_CANCELLED', 'NOT_FOUND'] as const
export const isOneOf = <T extends string>(list: readonly T[], v: string | null | undefined): v is T => v !== null && v !== undefined && (list as readonly string[]).includes(v)

/** The parts of a row's risk that make it "at risk" (the ones BR-RFX-14 names), as codes to put into words */
export function atRiskCauses(row: Pick<PreferredRowView, 'risk' | 'riskExempt'>): { readonly status: 'OVERDUE' | 'REASSESS_REQUIRED' | null; readonly flag: 'CEASED' | 'VAT_CANCELLED' | null } {
  if (!row.riskExempt || !row.risk) return { status: null, flag: null }
  const status = row.risk.status === 'OVERDUE' || row.risk.status === 'REASSESS_REQUIRED' ? row.risk.status : null
  const flag = row.risk.registryFlag === 'CEASED' || row.risk.registryFlag === 'VAT_CANCELLED' ? row.risk.registryFlag : null
  return { status, flag }
}

// ---------- the forms' own checks ----------

export type NewPreferredField = 'categoryCode' | 'supplierId' | 'validFrom' | 'lastDay' | 'note'
export type NewPreferredFieldError = 'CATEGORY' | 'SUPPLIER' | 'DATE' | 'PERIOD_PAST' | 'PERIOD' | 'REASON'

/** What the set form can already tell is wrong: a category, a supplier, a first day from today, a last day not before it, a reason */
export function newPreferredErrors(v: NewPreferredInput, today: string): Partial<Record<NewPreferredField, NewPreferredFieldError>> {
  const errors: Partial<Record<NewPreferredField, NewPreferredFieldError>> = {}
  if (!v.categoryCode) errors.categoryCode = 'CATEGORY'
  if (!v.supplierId) errors.supplierId = 'SUPPLIER'
  if (!validDay(v.validFrom)) errors.validFrom = 'DATE'
  else if (v.validFrom < today) errors.validFrom = 'PERIOD_PAST'
  if (v.lastDay) {
    if (!validDay(v.lastDay)) errors.lastDay = 'DATE'
    else if (validDay(v.validFrom) && v.lastDay < v.validFrom) errors.lastDay = 'PERIOD'
  }
  if (v.note.trim().length < PREFERRED_REASON_MIN) errors.note = 'REASON'
  return errors
}

export const endReasonReady = (reason: string): boolean => reason.trim().length >= PREFERRED_REASON_MIN

// ---------- a refusal from the server ----------

export interface PreferredFailure {
  readonly ok: false
  readonly code: string
  readonly field?: string
  readonly reason?: string
  /** PREFERRED_OVERLAP: the end (not included) of the row it overlaps */
  readonly validTo?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type PreferredOutcome<T = object> = ({ readonly ok: true } & T) | PreferredFailure

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Picks the screen-safe parts of a service error */
export function toPreferredFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): PreferredFailure {
  const d = error.details ?? {}
  const out: Record<string, unknown> = { ok: false, code: error.code }
  const copy = { field: str(d.field), reason: str(d.reason), validTo: str(d.validTo), requestId: str(d.requestId) }
  for (const [k, v] of Object.entries(copy)) if (v !== undefined) out[k] = v
  return out as unknown as PreferredFailure
}

/** Message keys under preferredSuppliers.errors */
export const PREFERRED_ERROR_KEYS = [
  'CATEGORY',
  'CATEGORY_UNKNOWN',
  'SUPPLIER',
  'SUPPLIER_UNKNOWN',
  'DATE',
  'PERIOD_PAST',
  'PERIOD',
  'REASON',
  'OVERLAP',
  'ALREADY_ENDED',
  'EXPIRED',
  'MODULE_DISABLED',
  'FORBIDDEN',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'BUSY',
  'NO_ANSWER',
  'INTERNAL',
  'INPUT',
  'FAILED',
] as const
export type PreferredErrorKey = (typeof PREFERRED_ERROR_KEYS)[number]

const BY_FIELD: Readonly<Record<string, PreferredErrorKey>> = {
  categoryCode: 'CATEGORY',
  supplierId: 'SUPPLIER',
  validFrom: 'DATE',
  validTo: 'DATE',
  lastDay: 'DATE',
  note: 'REASON',
  reason: 'REASON',
}

/** Message key under preferredSuppliers.errors for a failed command */
export function preferredErrorKey(f: PreferredFailure): PreferredErrorKey {
  switch (f.code) {
    case 'PREFERRED_OVERLAP':
      return 'OVERLAP'
    case 'INVALID_STATE_TRANSITION':
      return f.reason === 'EXPIRED' ? 'EXPIRED' : 'ALREADY_ENDED'
    case 'VALIDATION_FAILED':
      if (f.reason === 'UNKNOWN' && f.field === 'supplierId') return 'SUPPLIER_UNKNOWN'
      if (f.reason === 'UNKNOWN' && f.field === 'categoryCode') return 'CATEGORY_UNKNOWN'
      if (f.reason === 'PERIOD_PAST') return 'PERIOD_PAST'
      if (f.reason === 'PERIOD') return 'PERIOD'
      return BY_FIELD[f.field ?? ''] ?? 'INPUT'
    case 'MODULE_DISABLED':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
    case 'NO_ANSWER':
      return f.code
    case 'RATE_LIMITED':
    case 'IDEMPOTENCY_CONFLICT':
      return 'BUSY'
    default:
      return 'FAILED'
  }
}

/** The set form's field a refusal is about, to say it beside that field ('lastDay' for the period's end); null: the form as a whole */
export function preferredErrorField(f: PreferredFailure): NewPreferredField | null {
  if (f.code !== 'VALIDATION_FAILED') return null
  switch (f.field) {
    case 'categoryCode':
    case 'supplierId':
    case 'validFrom':
    case 'note':
      return f.field
    case 'validTo':
    case 'lastDay':
      return 'lastDay'
    default:
      return null
  }
}

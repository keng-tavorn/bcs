import { BANGKOK_OFFSET_MS, BASIS_POINTS_WHOLE } from '@/lib/constants'

// The shapes the internal sourcing screens (S10-12 · /sourcing/new · /sourcing/[id]/edit · the pool's "เปิด RFx") pass
// between their server actions and their forms, and the words a refusal is shown in. A refusal carries its code and
// the screen-safe details only (§14.2).

export type RfxOutcome =
  | { readonly ok: true; readonly rfxEventId?: string }
  | {
      readonly ok: false
      readonly code: string
      /** VALIDATION_FAILED and INVALID_STATE_TRANSITION: the reason the screen can say */
      readonly reason?: string
      /** CLOSE_TOO_SOON: the earliest close the RFx may have */
      readonly earliest?: string
    }

/** The steps of /sourcing/[id]/edit, in order (docs/sub-specs/S10.md "หน้าจอ") */
export const SETUP_STEPS = ['general', 'lines', 'suppliers', 'scorecard', 'schedule', 'review'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export const isSetupStep = (v: unknown): v is SetupStep => typeof v === 'string' && (SETUP_STEPS as readonly string[]).includes(v)

/** The refusals the setup screens have their own words for (sourcing.setup.errors.*); anything else is OTHER */
export const SETUP_ERROR_KEYS = [
  'MODULE_DISABLED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'CONFLICT_VERSION',
  'UNAUTHENTICATED',
  'SOD_VIOLATION',
  'SCORECARD_INCOMPLETE',
  'WEIGHTS_SUM',
  'PRICE_IS_COMPUTED',
  'ALREADY_INVITED',
  'SUPPLIER_FLAGGED',
  'TAX_RATE_NOT_CONFIGURED',
  'INVALID_STATE_TRANSITION',
  'LINE_IN_RFX',
  'LINE_NOT_IN_POOL',
  'LINE_HAS_SUPPLIER',
  'PRICE_INCLUDES_VAT',
  'MIXED_CATEGORY',
  'NO_DEPARTMENT',
  'VAT_INCLUSIVE_NOT_ALLOWED',
  'UNSEAL_REASON',
  'SUPPLIER_INACTIVE',
  'PORTAL_NOT_ENABLED',
  'APPLICATION_NOT_OPEN',
  'NO_CONTACT',
  'ONE_OWNER',
  'RFI_HAS_NO_SCORECARD',
  'DUPLICATE_CODE',
  'MEMBER',
  'NO_LINES',
  'NO_INVITES',
  'FEWER_INVITES_REASON',
  'CLOSE_TOO_SOON',
  'PAST_CLOSE',
  'LAST_LINE',
  'AI_REVIEW_PENDING',
  'RFI_KIND_FIXED',
  'AI_FAILED',
  'AI_AGENT_DISABLED',
  'AI_CREDITS_EXHAUSTED',
  'AI_NOT_EVALUATED',
  'RATE_LIMITED',
  'OTHER',
] as const
export type SetupErrorKey = (typeof SETUP_ERROR_KEYS)[number]

/** The words of a refusal: its reason when the screen knows it, else its code, else OTHER */
export function setupErrorKey(outcome: Extract<RfxOutcome, { ok: false }>): SetupErrorKey {
  const known = (v: string | undefined): v is SetupErrorKey => v !== undefined && (SETUP_ERROR_KEYS as readonly string[]).includes(v)
  if (known(outcome.reason)) return outcome.reason
  if (known(outcome.code)) return outcome.code
  return 'OTHER'
}

/** Weights are kept in basis points and shown in per cent with up to two decimals ("60", "12.5") */
export const percentOf = (bp: number): string => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, ''))

/** A per cent typed on the screen to basis points, or null when it is not a number from 0 to 100 with two decimals at most */
export function bpOf(percent: string): number | null {
  const text = percent.trim()
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return bp <= BASIS_POINTS_WHOLE ? bp : null
}

/** The value of a datetime-local field (Asia/Bangkok wall time) as an ISO instant, or null */
export function bangkokInstant(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null
  const at = new Date(`${local}:00+07:00`)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** An instant as the value of a datetime-local field in Asia/Bangkok wall time */
export function bangkokLocal(iso: string): string {
  const at = new Date(new Date(iso).getTime() + BANGKOK_OFFSET_MS)
  return at.toISOString().slice(0, 16)
}

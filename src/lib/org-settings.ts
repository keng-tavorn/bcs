import { z } from 'zod'
import { AI_CREDIT_DEFAULTS } from './ai-config'
import { BP_WHOLE } from './constants'
import AP_DEFAULTS from './ap-defaults.json'
import { BASIS_POINTS_WHOLE } from './constants'

// Organization.settings (spec §6.2, Appendix A "ค่าตั้งต้นขององค์กร"): every save must pass this schema
// (FR-PLT-001 AC2). Defaults for the demo org live in prisma/seed/org-settings.demo.yaml; each comment names
// the open question whose default the value follows (§18.3).

const percent = z.number().min(0).max(100)
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm')
const weekday = z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])
// BR-NUM-03 reset periods; the pattern tokens are checked by core/numbering (BR-NUM-02) when it lands in S2-04
const numberingRule = z.object({ pattern: z.string().min(1), reset: z.enum(['YEARLY', 'MONTHLY', 'NEVER']) }).strict()
const basisPoints = z.number().int().min(0).max(BASIS_POINTS_WHOLE)
/** Money in settings is a baht string with 2 decimals (BR-MONEY-01) */
const bahtAmount = z.string().regex(/^\d{1,13}\.\d{2}$/, 'baht with 2 decimals, e.g. "1000.00"')
/** What an Express column may hold (BR-EXP-01, BR-EXP-04): one value of the invoice, its supplier or its PO */
export const EXPRESS_FIELDS = [
  'invoiceNo',
  'invoiceDate',
  'supplierCode',
  'supplierName',
  'supplierTaxId',
  'supplierBranch',
  'expressVendorCode',
  'poNumber',
  'net',
  'vat',
  'gross',
  'budgetLineCode',
  'costCenterCode',
  'accountCode',
] as const
export type ExpressField = (typeof EXPRESS_FIELDS)[number]

export const OrgSettingsSchema = z
  .object({
    locale: z.enum(['th', 'en']),
    timezone: z.string().min(1),
    businessCalendar: z
      .object({ workdays: z.array(weekday).min(1), start: clockTime, end: clockTime })
      .strict()
      .refine((c) => c.start < c.end, { message: 'start must be before end', path: ['end'] }),
    budgetBasis: z.enum(['NET', 'GROSS']), // OQ-03
    receiving: z.object({ overTolerancePct: percent }).strict(), // OQ-20
    consolidation: z.object({ cron: z.string().min(1) }).strict(), // OQ-13
    priceAlertPct: percent,
    digest: z.object({ enabled: z.boolean(), budgetLowPct: percent }).strict(),
    email: z.object({ fromAddress: z.email(), actionLinksRequireLogin: z.boolean() }).strict(), // OQ-22
    sso: z.object({ trustIdpMfa: z.boolean(), allowedDomains: z.array(z.string().min(1)) }).strict(),
    // OQ-12. One key per line, sorted: each lane adds its own document's key on a line of its own (P1-07), e.g. BT OB (S6)
    // S8 AP (invoice) and WHT_CERT (50 ทวิ) are optional: missing reads as the default of OQ-12
    numbering: z
      .object({
        AP: numberingRule.optional(),
        BAC: numberingRule.optional(),
        GR: numberingRule,
        PAY: numberingRule.optional(),
        PO: numberingRule,
        PR: numberingRule,
        RQ: numberingRule,
        WHT_CERT: numberingRule.optional(),
      })
      .strict(),
    express: z
      .object({
        fileType: z.enum(['xlsx', 'csv']),
        encoding: z.enum(['UTF-8-BOM', 'WINDOWS-874']),
        dateFormat: z.enum(['BE', 'CE']),
        // The columns of the file in order: the header the accounting program expects and the value it takes
        mapping: z.array(z.object({ header: z.string().trim().min(1).max(100), field: z.enum(EXPRESS_FIELDS) }).strict()),
      })
      .strict(), // OQ-10, BR-EXP-01
    retention: z.object({ documentYears: z.number().int().min(1), accessLogYears: z.number().int().min(1) }).strict(), // OQ-30
    features: z.object({ parallelApproval: z.boolean(), lineChannel: z.boolean() }).strict(),
    // Optional, so an organization saved before it (staging) needs no new seed: missing reads as the default (OQ-38)
    procurement: z.object({ queueTargetBusinessMinutes: z.number().int().min(1).optional() }).strict().optional(),
    // S13: AI credits of the organization, set by the BCS team only (BR-AI-23); missing reads as the defaults of OQ-143
    ai: z.object({ monthlyCredits: z.number().int().min(1), alertAtBp: z.number().int().min(1).max(BP_WHOLE) }).strict().optional(),
    // S8 (BR-MATCH-13): set by seed only, no page or command edits them in phase 1 (not in SECTION_CAPABILITY);
    // a key that is missing reads as the default of its OQ (apPolicyOf below)
    matching: z
      .object({
        priceTolBp: basisPoints.optional(),
        priceTolAmount: bahtAmount.optional(),
        qtyTolBp: basisPoints.optional(),
        vatTolAmount: bahtAmount.optional(),
      })
      .strict()
      .optional(), // OQ-121
    wht: z
      .object({
        minimumBase: bahtAmount.optional(),
        // Phase 1 withholds at payment only (BR-WHT-05)
        timing: z.literal('AT_PAYMENT').optional(),
      })
      .strict()
      .optional(), // OQ-122
    ap: z
      .object({
        defaultTermDays: z.number().int().min(0).optional(), // OQ-129
        inboxAddress: z.email().optional(), // OQ-124
      })
      .strict()
      .optional(),
    // S9 (BR-PAY-02 BR-PAY-06 BR-PAY-13): set by seed only in phase 1, as matching; missing keys read as the OQ defaults
    // of paymentSettingsOf below
    payment: z
      .object({
        runWeekdays: z.array(weekday).min(1).optional(), // OQ-130
        holidayShift: z.enum(['PREVIOUS', 'NEXT']).optional(), // OQ-130
        recentBankChangeDays: z.number().int().min(0).max(365).optional(), // OQ-132
        adviceEmail: z.boolean().optional(), // OQ-134
      })
      .strict()
      .optional(),
  })
  .strict()

export type OrgSettings = z.infer<typeof OrgSettingsSchema>

/** How soon procurement sends a PO for approval after its request is approved, in business minutes (§11.5) */
export const DEFAULT_QUEUE_TARGET_MINUTES = 960 // TODO(OQ-38)

/** settings.procurement.queueTargetBusinessMinutes of stored settings, or the default of OQ-38 when it is not set */
export function queueTargetMinutesOf(settings: unknown): number {
  const procurement = settings !== null && typeof settings === 'object' ? (settings as { procurement?: unknown }).procurement : undefined
  const parsed = OrgSettingsSchema.shape.procurement.safeParse(procurement)
  return (parsed.success ? parsed.data?.queueTargetBusinessMinutes : undefined) ?? DEFAULT_QUEUE_TARGET_MINUTES
}

/** settings.ai of stored settings, or the defaults of OQ-143 (20,000 credits a month, alert at 80%) */
export function aiCreditSettingsOf(settings: unknown): { monthlyCredits: number; alertAtBp: number } {
  const ai = settings !== null && typeof settings === 'object' ? (settings as { ai?: unknown }).ai : undefined
  const parsed = OrgSettingsSchema.shape.ai.safeParse(ai)
  return (parsed.success ? parsed.data : undefined) ?? { ...AI_CREDIT_DEFAULTS }
}

/** The S8 thresholds and terms of an organization (BR-MATCH-13): money in satang, rates in basis points */
export interface ApPolicy {
  readonly priceTolBp: number
  readonly priceTolSatang: bigint
  readonly qtyTolBp: number
  readonly vatTolSatang: bigint
  readonly whtMinimumBaseSatang: bigint
  readonly whtTiming: 'AT_PAYMENT'
  readonly defaultTermDays: number
}

// The defaults of the open questions when settings leave a key out (BR-MATCH-13), kept as data in ap-defaults.json
// (P-2: no money in code); seed sets the real values from the Settings sheet. TODO(OQ-121) TODO(OQ-122) TODO(OQ-129)
const DEFAULT_MATCHING = AP_DEFAULTS.matching
const DEFAULT_WHT = AP_DEFAULTS.wht as { minimumBase: string; timing: 'AT_PAYMENT' }
const DEFAULT_TERM_DAYS = AP_DEFAULTS.ap.defaultTermDays

const bahtToSatang = (baht: string) => BigInt(baht.replace('.', ''))

/** settings.matching settings.wht settings.ap of stored settings, each missing key read as its OQ default */
export function apPolicyOf(settings: unknown): ApPolicy {
  const s = settings !== null && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  const matching = OrgSettingsSchema.shape.matching.safeParse(s.matching)
  const wht = OrgSettingsSchema.shape.wht.safeParse(s.wht)
  const ap = OrgSettingsSchema.shape.ap.safeParse(s.ap)
  const m = { ...DEFAULT_MATCHING, ...(matching.success ? matching.data : {}) }
  const w = { ...DEFAULT_WHT, ...(wht.success ? wht.data : {}) }
  return {
    priceTolBp: m.priceTolBp,
    priceTolSatang: bahtToSatang(m.priceTolAmount),
    qtyTolBp: m.qtyTolBp,
    vatTolSatang: bahtToSatang(m.vatTolAmount),
    whtMinimumBaseSatang: bahtToSatang(w.minimumBase),
    whtTiming: w.timing,
    defaultTermDays: (ap.success ? ap.data?.defaultTermDays : undefined) ?? DEFAULT_TERM_DAYS,
  }
}

/** The S9 settings of an organization: the payment run's weekdays and holiday shift, the bank-change window, advice e-mails */
export interface PaymentSettings {
  readonly runWeekdays: readonly z.infer<typeof weekday>[]
  readonly holidayShift: 'PREVIOUS' | 'NEXT'
  readonly recentBankChangeDays: number
  readonly adviceEmail: boolean
}

// The defaults of the open questions when settings leave a key out: Fridays, the working day before a holiday, 30 days,
// advice e-mails on. TODO(OQ-130) TODO(OQ-132) TODO(OQ-134)
const DEFAULT_PAYMENT: PaymentSettings = { runWeekdays: ['FRI'], holidayShift: 'PREVIOUS', recentBankChangeDays: 30, adviceEmail: true }

/** settings.payment of stored settings, each missing key read as its OQ default */
export function paymentSettingsOf(settings: unknown): PaymentSettings {
  const payment = settings !== null && typeof settings === 'object' ? (settings as { payment?: unknown }).payment : undefined
  const parsed = OrgSettingsSchema.shape.payment.safeParse(payment)
  return { ...DEFAULT_PAYMENT, ...(parsed.success ? parsed.data : {}) }
}

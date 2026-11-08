import { z } from 'zod'
import { AI_CREDIT_DEFAULTS } from './ai-config'
import { BcsGoSettingsSchema, ChatIntakeSettingsSchema } from './s17-settings'
import { BP_WHOLE } from './constants'
import AP_DEFAULTS from './ap-defaults.json'
import {
  BASIS_POINTS_WHOLE,
  BUDGET_ALERT_DEFAULT_BP,
  BUDGET_ALERT_MAX_BP,
  SETTINGS_MAX_DAYS,
  SETTINGS_MAX_MINUTES,
  SOURCING_DEFAULT_WEIGHTS_BP,
  SOURCING_MIN_INVITES_THRESHOLD_GROSS,
  SOURCING_PRICE_ANOMALY_BP,
} from './constants'

// Organization.settings (spec §6.2, Appendix A "ค่าตั้งต้นขององค์กร"): every save must pass this schema
// (FR-PLT-001 AC2). Defaults for the demo org live in prisma/seed/org-settings.demo.yaml; each comment names
// the open question whose default the value follows (§18.3).

const percent = z.number().min(0).max(100)
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm')
const weekday = z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])
// BR-NUM-03 reset periods; the pattern tokens are checked by core/numbering (BR-NUM-02) when it lands in S2-04
const numberingRule = z.object({ pattern: z.string().min(1), reset: z.enum(['YEARLY', 'MONTHLY', 'NEVER']) }).strict()
const positiveDays = z.number().int().min(1).max(SETTINGS_MAX_DAYS)
// A share of the current budget in basis points (BR-BUD-17): 8000 = 80 %
const alertBasisPoints = z.number().int().min(1).max(BUDGET_ALERT_MAX_BP)
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

// S7 (BR-PORTAL-01 to 04 · BR-SUP-12 · BR-SUP-17 · BR-PORTAL-09): set by seed (Settings sheet, S7-13); the defaults are
// those of the open questions, in supplierSettingsOf
const SupplierSettingsSchema = z
  .object({
    otpChannel: z.enum(['EMAIL', 'SMS']).optional(),
    inviteLinkDays: positiveDays.optional(),
    loginLinkMinutes: z.number().int().min(1).max(SETTINGS_MAX_MINUTES).optional(),
    otpMinutes: z.number().int().min(1).max(60).optional(),
    otpMaxAttempts: z.number().int().min(1).max(10).optional(),
    otpLockMinutes: z.number().int().min(1).max(SETTINGS_MAX_MINUTES).optional(),
    sessionIdleMinutes: z.number().int().min(1).max(SETTINGS_MAX_MINUTES).optional(),
    sessionMaxHours: z.number().int().min(1).max(168).optional(),
    applicationReminderBusinessDays: positiveDays.optional(),
    applicationEscalateBusinessDays: positiveDays.optional(),
    applicationExpireDays: positiveDays.optional(),
    selfRegistration: z.boolean().optional(),
    aiAssist: z.boolean().optional(),
    portalInvoice: z.boolean().optional(),
    closedApplicationFileRetentionDays: positiveDays.optional(),
    contactRetentionDays: positiveDays.optional(),
    newContactBankHoldBusinessDays: z.number().int().min(0).max(SETTINGS_MAX_DAYS).optional(),
  })
  .strict()

// S10 (docs/sub-specs/S10.md "Entity และ migration"): set by seed (Settings sheet, S10-14); the defaults are those of the
// open questions, in sourcingSettingsOf
const sourcingKindDays = z.object({ RFQ: positiveDays.optional(), RFP: positiveDays.optional(), RFI: positiveDays.optional() }).strict()
/** The default weights of a scorecard: criterion code → basis points, one PRICE criterion, Σ = 10000 (BR-RFX-09) */
const sourcingWeightsBp = z
  .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'a criterion code of up to 20 capital letters, digits or _'), basisPoints)
  .refine((weights) => 'PRICE' in weights, 'a PRICE criterion')
  .refine((weights) => Object.values(weights).reduce((sum, bp) => sum + bp, 0) === BASIS_POINTS_WHOLE, 'the weights add up to 10000')
const SourcingSettingsSchema = z
  .object({
    minOpenBusinessDays: sourcingKindDays.optional(),
    questionCutoffBusinessDays: z.number().int().min(0).max(SETTINGS_MAX_DAYS).optional(),
    bidValidityDays: positiveDays.optional(),
    sealedBids: z.boolean().optional(),
    allowVatInclusiveBids: z.boolean().optional(),
    /** The amount with VAT above which an RFx invites at least minInvitesAboveThreshold suppliers (BR-RFX-01) */
    minInvitesThresholdGross: bahtAmount.optional(),
    minInvitesAboveThreshold: z.number().int().min(1).max(50).optional(),
    minEvaluators: z.number().int().min(1).max(20).optional(),
    priceAnomalyBp: basisPoints.optional(),
    preferredSupplierDays: positiveDays.optional(),
    agreementFromAwardDays: positiveDays.optional(),
    aiAssist: z.boolean().optional(),
    defaultWeightsBp: z.object({ RFQ: sourcingWeightsBp.optional(), RFP: sourcingWeightsBp.optional() }).strict().optional(),
  })
  .strict()

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
    // A key added in phase 1 is optional (an organization saved before it parses as it is): S6 BT OB read their default
    // from s6SettingsOf; S8 AP (invoice) and WHT_CERT (50 ทวิ) read the default of OQ-12
    numbering: z
      .object({
        AP: numberingRule.optional(),
        AWD: numberingRule.optional(),
        BAC: numberingRule.optional(),
        BT: numberingRule.optional(),
        GR: numberingRule,
        OB: numberingRule.optional(),
        PAY: numberingRule.optional(),
        PO: numberingRule,
        PR: numberingRule,
        RFX: numberingRule.optional(),
        RQ: numberingRule,
        SUP: numberingRule.optional(),
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
    // S6: every key optional, missing reads as the default of s6SettingsOf (an organization saved before S6 parses as it is)
    duplicateCheck: z.object({ windowDays: positiveDays.optional() }).strict().optional(),
    priceRef: z.object({ windowDays: positiveDays.optional(), minSamples: z.number().int().min(1).optional() }).strict().optional(),
    budget: z
      .object({
        alertThresholdsBp: z.array(alertBasisPoints).min(1).optional(),
        forecastMinElapsedDays: positiveDays.optional(),
        overrunLapseDays: positiveDays.optional(),
      })
      .strict()
      .optional(),
    renewal: z.object({ milestoneDays: z.array(positiveDays).min(1).optional() }).strict().optional(),
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
    // S17: the LINE chat and the BCS Go app (./s17-settings: every key optional, missing reads as its default, so an
    // organization saved before S17 parses as it is and keeps asking through the chat switched off)
    chatIntake: ChatIntakeSettingsSchema.optional(),
    bcsGo: BcsGoSettingsSchema.optional(),
    // S7: suppliers and the supplier portal (docs/sub-specs/S7.md); every key optional, missing reads as the default of
    // supplierSettingsOf below, so an organization saved before S7 parses as it is
    supplier: SupplierSettingsSchema.optional(),
    // S10: sourcing (docs/sub-specs/S10.md); every key optional, missing reads as the default of sourcingSettingsOf
    sourcing: SourcingSettingsSchema.optional(),
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

/** The S6 settings with the default of each key that is not set (docs/sub-specs/S6.md "Entity และ migration") */
export interface S6Settings {
  /** BR-DUP-02: how many days back a submit looks for duplicates and splits */
  readonly duplicateWindowDays: number
  /** BR-PRC-01, BR-PRC-02: how many days of approved PO lines the price reference reads, and how many make it OK */
  readonly priceRefWindowDays: number
  readonly priceRefMinSamples: number
  /** BR-BUD-17: alert when used ≥ each threshold, and forecast only after this many days of the fiscal year */
  readonly budgetAlertThresholdsBp: readonly number[]
  readonly budgetForecastMinElapsedDays: number
  /** BR-BUD-15: an approved overrun lapses this many days after its approval */
  readonly overrunLapseDays: number
  /** BR-FORM-08: renewal reminders this many days before serviceEndDate */
  readonly renewalMilestoneDays: readonly number[]
  readonly numberingBT: z.infer<typeof numberingRule>
  readonly numberingOB: z.infer<typeof numberingRule>
}

export const S6_DEFAULTS: S6Settings = {
  duplicateWindowDays: 7, // TODO(OQ-103)
  priceRefWindowDays: 365,
  priceRefMinSamples: 3,
  budgetAlertThresholdsBp: BUDGET_ALERT_DEFAULT_BP, // TODO(OQ-113)
  budgetForecastMinElapsedDays: 30, // TODO(OQ-113)
  overrunLapseDays: 14, // TODO(OQ-104)
  renewalMilestoneDays: [60, 30],
  numberingBT: { pattern: 'BT-{BE}-{SEQ5}', reset: 'YEARLY' }, // TODO(OQ-12)
  numberingOB: { pattern: 'OB-{BE}-{SEQ5}', reset: 'YEARLY' }, // TODO(OQ-12)
}

/**
 * The S6 keys of stored settings, each one falling back to S6_DEFAULTS when it is missing. Stored settings that do
 * not parse as a whole still give the defaults of the keys that do not parse, never a guess from a broken value.
 */
export function s6SettingsOf(settings: unknown): S6Settings {
  const s = settings !== null && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  const shape = OrgSettingsSchema.shape
  const part = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }
  const duplicateCheck = part(shape.duplicateCheck, s.duplicateCheck)
  const priceRef = part(shape.priceRef, s.priceRef)
  const budget = part(shape.budget, s.budget)
  const renewal = part(shape.renewal, s.renewal)
  const numbering = s.numbering !== null && typeof s.numbering === 'object' ? (s.numbering as Record<string, unknown>) : {}
  const d = S6_DEFAULTS
  return {
    duplicateWindowDays: duplicateCheck?.windowDays ?? d.duplicateWindowDays,
    priceRefWindowDays: priceRef?.windowDays ?? d.priceRefWindowDays,
    priceRefMinSamples: priceRef?.minSamples ?? d.priceRefMinSamples,
    budgetAlertThresholdsBp: budget?.alertThresholdsBp ?? d.budgetAlertThresholdsBp,
    budgetForecastMinElapsedDays: budget?.forecastMinElapsedDays ?? d.budgetForecastMinElapsedDays,
    overrunLapseDays: budget?.overrunLapseDays ?? d.overrunLapseDays,
    renewalMilestoneDays: renewal?.milestoneDays ?? d.renewalMilestoneDays,
    numberingBT: part(numberingRule, numbering.BT) ?? d.numberingBT,
    numberingOB: part(numberingRule, numbering.OB) ?? d.numberingOB,
  }
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

/** The S7 settings of an organization: the portal's links, codes and sessions, the application's SLA, retention */
export type SupplierSettings = Required<z.infer<typeof SupplierSettingsSchema>>

const DEFAULT_SUPPLIER: SupplierSettings = {
  otpChannel: 'EMAIL', // TODO(OQ-181)
  inviteLinkDays: 7,
  loginLinkMinutes: 15,
  otpMinutes: 10,
  otpMaxAttempts: 5,
  otpLockMinutes: 15,
  sessionIdleMinutes: 30,
  sessionMaxHours: 24,
  applicationReminderBusinessDays: 3, // TODO(OQ-184)
  applicationEscalateBusinessDays: 10, // TODO(OQ-184)
  applicationExpireDays: 30, // TODO(OQ-184)
  selfRegistration: false, // TODO(OQ-185)
  aiAssist: true, // TODO(OQ-186)
  portalInvoice: true, // TODO(OQ-187)
  closedApplicationFileRetentionDays: 365, // TODO(OQ-188)
  contactRetentionDays: 365, // TODO(OQ-188)
  newContactBankHoldBusinessDays: 2, // TODO(OQ-192)
}

/** settings.supplier of stored settings, each missing key read as its default */
export function supplierSettingsOf(settings: unknown): SupplierSettings {
  const supplier = settings !== null && typeof settings === 'object' ? (settings as { supplier?: unknown }).supplier : undefined
  const parsed = OrgSettingsSchema.shape.supplier.safeParse(supplier)
  return { ...DEFAULT_SUPPLIER, ...(parsed.success ? parsed.data : {}) }
}

/** The S10 settings of an organization: how long an RFx stays open, who is invited and scores, and what an award leaves */
export interface SourcingSettings {
  readonly minOpenBusinessDays: { readonly RFQ: number; readonly RFP: number; readonly RFI: number }
  readonly questionCutoffBusinessDays: number
  readonly bidValidityDays: number
  readonly sealedBids: boolean
  readonly allowVatInclusiveBids: boolean
  readonly minInvitesThresholdGross: string
  readonly minInvitesAboveThreshold: number
  readonly minEvaluators: number
  readonly priceAnomalyBp: number
  readonly preferredSupplierDays: number
  readonly agreementFromAwardDays: number
  readonly aiAssist: boolean
  readonly defaultWeightsBp: { readonly RFQ: Readonly<Record<string, number>>; readonly RFP: Readonly<Record<string, number>> }
}

const DEFAULT_SOURCING: SourcingSettings = {
  minOpenBusinessDays: { RFQ: 3, RFP: 10, RFI: 5 },
  questionCutoffBusinessDays: 2,
  bidValidityDays: 30,
  sealedBids: true, // TODO(OQ-201)
  allowVatInclusiveBids: false, // TODO(OQ-212)
  // the same amount as quoteThresholdGross of the Settings sheet (the sheet's key is not in this schema)
  minInvitesThresholdGross: SOURCING_MIN_INVITES_THRESHOLD_GROSS, // TODO(OQ-08)
  minInvitesAboveThreshold: 3,
  minEvaluators: 2, // TODO(OQ-206)
  priceAnomalyBp: SOURCING_PRICE_ANOMALY_BP, // TODO(OQ-208)
  preferredSupplierDays: 365, // TODO(OQ-210)
  agreementFromAwardDays: 365, // TODO(OQ-210)
  aiAssist: true, // TODO(OQ-209)
  defaultWeightsBp: SOURCING_DEFAULT_WEIGHTS_BP, // TODO(OQ-206)
}

/** settings.sourcing of stored settings, each missing key read as its default (the days per kind and weights per kind too) */
export function sourcingSettingsOf(settings: unknown): SourcingSettings {
  const sourcing = settings !== null && typeof settings === 'object' ? (settings as { sourcing?: unknown }).sourcing : undefined
  const parsed = OrgSettingsSchema.shape.sourcing.safeParse(sourcing)
  const set = (parsed.success ? parsed.data : undefined) ?? {}
  const { minOpenBusinessDays, defaultWeightsBp, ...flat } = set
  return {
    ...DEFAULT_SOURCING,
    ...flat,
    minOpenBusinessDays: { ...DEFAULT_SOURCING.minOpenBusinessDays, ...minOpenBusinessDays },
    defaultWeightsBp: { ...DEFAULT_SOURCING.defaultWeightsBp, ...defaultWeightsBp },
  }
}

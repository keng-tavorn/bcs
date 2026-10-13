import { z } from 'zod'
import { AI_CREDIT_DEFAULTS } from './ai-config'
import { BP_WHOLE } from './constants'

// Organization.settings (spec §6.2, Appendix A "ค่าตั้งต้นขององค์กร"): every save must pass this schema
// (FR-PLT-001 AC2). Defaults for the demo org live in prisma/seed/org-settings.demo.yaml; each comment names
// the open question whose default the value follows (§18.3).

const percent = z.number().min(0).max(100)
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm')
const weekday = z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])
// BR-NUM-03 reset periods; the pattern tokens are checked by core/numbering (BR-NUM-02) when it lands in S2-04
const numberingRule = z.object({ pattern: z.string().min(1), reset: z.enum(['YEARLY', 'MONTHLY', 'NEVER']) }).strict()
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
    numbering: z
      .object({
        GR: numberingRule,
        PO: numberingRule,
        PR: numberingRule,
        RQ: numberingRule,
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

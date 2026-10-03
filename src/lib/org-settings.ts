import { z } from 'zod'

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
    numbering: z.object({ PR: numberingRule, PO: numberingRule, GR: numberingRule, RQ: numberingRule }).strict(), // OQ-12
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
  })
  .strict()

export type OrgSettings = z.infer<typeof OrgSettingsSchema>

import { z } from 'zod'
import { BASIS_POINTS_WHOLE } from '@/lib/constants'
import type { InputWorkbook } from './workbook'

// Sourcing of the phase-1 organization (S10-14 · docs/sub-specs/S10.md "การอ่านชีตของไฟล์ระยะ 1"): the four sheets of S10,
// read the way scripts/validate_inputs.py reads them. They are played with the real commands by
// src/server/services/demo-seed/sourcing.ts. The demo workbook has none of them. Every problem names the sheet and row
// for the person to fix scripts/inputs_p1/p1_sourcing.py (the workbook is never edited by hand).

const text = z.string().trim().min(1)
const optional = z.string().trim().nullable()
const whole = z.string().regex(/^\d+$/, 'a whole number').transform(Number)
const wholeOrNull = whole.nullable()
const yesNo = z.enum(['Y', 'N']).transform((v) => v === 'Y')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time HH:MM')
const code = z.string().trim().min(1).max(40)
const list = (separator: string) =>
  z
    .string()
    .nullable()
    .transform((v) => (v ? v.split(separator).map((x) => x.trim()).filter(Boolean) : []))
/** Baht as the sheet holds it ("23150" or "2537.5" from a number cell), as baht with 2 decimals */
const baht = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, 'an amount in baht')
  .transform((v) => {
    const [whole, frac = ''] = v.split('.')
    return `${whole}.${frac.padEnd(2, '0')}`
  })
const json = <T,>(schema: z.ZodType<T>) =>
  z
    .string()
    .nullable()
    .transform((v, ctx) => {
      if (v === null) return null
      try {
        const parsed = schema.safeParse(JSON.parse(v))
        if (parsed.success) return parsed.data
        ctx.addIssue({ code: 'custom', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not JSON' })
      }
      return z.NEVER
    })

const SupplierRow = z.object({
  ref: text,
  nameEn: text,
  nameTh: optional,
  country: z.string().regex(/^[A-Z]{2}$/),
  payeeType: z.literal('FOREIGN'),
  taxId: z.null({ message: 'a foreign supplier has no Thai tax id (BR-SUP-02)' }),
  category: optional,
  contactName: text,
  contactEmail: text.toLowerCase(),
  contactLocale: z.enum(['th', 'en']),
  invitedBy: text,
  routedBy: text,
  verifiedBy: text,
  invitedDaysAgo: whole,
  expectedApprover: text,
  expectedG7Days: z.coerce.number().positive(),
})

const NeedLine = z.strictObject({
  description: text,
  descriptionEn: z.string().trim().min(1).nullable(),
  catalogItemCode: z.string().trim().min(1).nullable(),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
  uom: text,
  uomEn: z.string().trim().min(1).nullable(),
  refUnitPrice: z.string().regex(/^\d{1,13}\.\d{2}$/).nullable(),
})
const Weight = z.strictObject({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/), nameTh: text, weightBp: z.int().min(0).max(BASIS_POINTS_WHOLE) })
const Question = z.strictObject({ supplier: code, afterBusinessDays: z.int().min(0), question: text, answer: text })

const ScenarioRow = z.object({
  ref: text,
  expectedNumber: z.string().regex(/^[A-Z]+-\d{4}-\d{5}$/),
  kind: z.enum(['RFQ', 'RFP', 'RFI']),
  title: text,
  titleEn: optional,
  description: text,
  /** S10-17 (BR-FORM-11): with titleEn the RFx is in Thai and English and needs its English description too */
  descriptionEn: optional,
  categoryCode: code,
  sourceKind: z.enum(['REQUEST_LINES', 'NEED']),
  historyRefs: list(';'),
  needLines: json(z.array(NeedLine).min(1)),
  /** S10-17 (BR-FORM-11): the English of the pool lines of a TH_EN RFx, in the order of historyRefs */
  linesEn: json(z.array(z.strictObject({ descriptionEn: text, uomEn: text })).min(1)),
  creator: text,
  evaluators: list(';'),
  weightsJson: json(z.array(Weight).min(1)),
  invitedSuppliers: list(';'),
  openBusinessDaysAgo: whole,
  openTime: hhmm,
  closeAfterBusinessDays: whole,
  closeTime: hhmm,
  questionsJson: json(z.array(Question)),
  awardAfterBusinessDays: wholeOrNull,
  awardTime: hhmm.nullable(),
  decideAfterBusinessDays: wholeOrNull,
  decideTime: hhmm.nullable(),
  awardReason: optional,
  conclusionNote: optional,
  allowVatInclusiveBids: yesNo,
  demoLive: yesNo,
  expectedStatus: z.enum(['OPEN', 'AWARDED', 'CONCLUDED']),
  expectedWinner: optional,
  expectedRule: optional,
  expectedApprover: optional,
})

const BidRow = z.object({
  rfxRef: text,
  supplier: code,
  lineNo: whole,
  unitPrice: baht,
  includesVat: yesNo,
  offered: yesNo,
  submitAfterBusinessDays: whole,
  submitTime: hhmm,
  deliveryDays: wholeOrNull,
  note: optional,
})

const ScoreRow = z.object({ rfxRef: text, evaluator: text, supplier: code, criterion: code, score: whole.pipe(z.int().max(100)) })

export type SourcingSupplierRow = z.infer<typeof SupplierRow>
export type SourcingScenarioRow = z.infer<typeof ScenarioRow>
export type SourcingBidRow = z.infer<typeof BidRow>
export type SourcingScoreRow = z.infer<typeof ScoreRow>

export interface SourcingSheets {
  readonly suppliers: readonly SourcingSupplierRow[]
  readonly scenarios: readonly SourcingScenarioRow[]
  readonly bids: readonly SourcingBidRow[]
  readonly scores: readonly SourcingScoreRow[]
}

function rows<T>(workbook: InputWorkbook, sheet: string, schema: z.ZodType<T>): T[] {
  return workbook.table(sheet).map(({ row, values }) => {
    const parsed = schema.safeParse(values)
    if (!parsed.success) throw new Error(`ชีต ${sheet} แถว ${row}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')} · แก้ scripts/inputs_p1/p1_sourcing.py แล้วสร้างไฟล์ใหม่`)
    return parsed.data
  })
}

/** The four sheets of S10, or null when the workbook has none (the demo workbook) */
export function parseSourcing(workbook: InputWorkbook): SourcingSheets | null {
  if (!workbook.hasSheet('RFx_Scenarios')) return null
  return {
    suppliers: workbook.hasSheet('RFx_Suppliers') ? rows(workbook, 'RFx_Suppliers', SupplierRow) : [],
    scenarios: rows(workbook, 'RFx_Scenarios', ScenarioRow),
    bids: rows(workbook, 'RFx_Bids', BidRow),
    scores: rows(workbook, 'RFx_Scores', ScoreRow),
  }
}

import { z } from 'zod'
import { BASIS_POINTS_WHOLE, RETENTION_HOLD_MAX_DAYS } from '@/lib/constants'
import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import type { InputWorkbook } from './workbook'

// What S8 reads from the phase-1 workbook (docs/sub-specs/S8.md "การอ่านชีตของไฟล์ระยะ 1", S8-12): each supplier's
// payee type, default income type, credit days, e-Tax issuing and registry status (sheet SupplierPayment · the bank
// columns are S9's), the income types to withhold on, not yet confirmed by the customer's accountant (WHT_Types),
// the retention each request type starts a PO with (RequestTypes), and the thresholds of tier-2 invoices in sheet
// Settings (BR-MATCH-13: settings only come from the seed in phase 1). A workbook without these sheets or columns
// (the demo) gives nothing, and the defaults of the OQs apply. Running again changes nothing that exists.

const text = z.string().min(1)
const SupplierPaymentRow = z.object({
  supplierCode: text,
  payeeType: z.enum(['JURISTIC', 'INDIVIDUAL']),
  whtIncomeType: z.string().nullable(),
  paymentTermDays: z.coerce.number().int().min(0).max(180),
  eTaxIssuer: z.enum(['NONE', 'EMAIL', 'FULL']),
  registryStatus: z.string(),
})
const WhtTypeRow = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,40}$/), nameTh: text, rateBp: z.coerce.number().int().min(0).max(BASIS_POINTS_WHOLE), form: z.enum(['PND3_53', 'PND53', 'PND3']), legalRefTh: z.string().nullable() })
const RetentionRow = z.object({ code: text, defaultRetentionBp: z.coerce.number().int().min(0).max(BASIS_POINTS_WHOLE).nullable(), defaultRetentionHoldDays: z.coerce.number().int().min(0).max(RETENTION_HOLD_MAX_DAYS).nullable() })

/** registryStatus of the sheet as Supplier.registryFlag: ACTIVE is nothing to flag; anything unknown is NOT_FOUND */
export function registryFlagOf(status: string): 'NONE' | 'CEASED' | 'VAT_CANCELLED' | 'NOT_FOUND' {
  return status === 'ACTIVE' ? 'NONE' : status === 'CEASED' || status === 'VAT_CANCELLED' ? status : 'NOT_FOUND'
}

function tableOf<T extends z.ZodType>(workbook: InputWorkbook, sheet: string, schema: T): z.infer<T>[] {
  if (!workbook.hasSheet(sheet)) return []
  return workbook.table(sheet).map(({ row, values }) => {
    const parsed = schema.safeParse(values)
    if (!parsed.success) throw new Error(`${sheet} row ${row}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    return parsed.data
  })
}

export interface ApProfile {
  readonly payments: z.infer<typeof SupplierPaymentRow>[]
  readonly whtTypes: z.infer<typeof WhtTypeRow>[]
  readonly retention: z.infer<typeof RetentionRow>[]
}

export function parseApProfile(workbook: InputWorkbook): ApProfile {
  const retention = workbook.hasSheet('RequestTypes') ? tableOf(workbook, 'RequestTypes', RetentionRow.partial({ defaultRetentionBp: true, defaultRetentionHoldDays: true })) : []
  return {
    payments: tableOf(workbook, 'SupplierPayment', SupplierPaymentRow),
    whtTypes: tableOf(workbook, 'WHT_Types', WhtTypeRow),
    retention: retention.filter((r): r is z.infer<typeof RetentionRow> => r.defaultRetentionBp !== undefined && r.defaultRetentionBp !== null && r.defaultRetentionBp > 0),
  }
}

/** The S8 keys of sheet Settings over `base` (prisma/seed/org-settings.demo.yaml): none in the sheet, base as it is */
export function apSettingsFromSheet(workbook: InputWorkbook, base: OrgSettings): OrgSettings {
  if (!workbook.hasSheet('Settings')) return base
  const kv = workbook.keyValues('Settings')
  const value = (key: string) => kv.get(key)?.value ?? undefined
  const num = (key: string) => (value(key) === undefined ? undefined : Number(value(key)))
  const matching = { priceTolBp: num('matching.priceTolBp'), priceTolAmount: value('matching.priceTolAmount'), qtyTolBp: num('matching.qtyTolBp'), vatTolAmount: value('matching.vatTolAmount') }
  const wht = { minimumBase: value('wht.minimumBase'), timing: value('wht.timing') }
  const ap = { defaultTermDays: num('ap.defaultTermDays'), inboxAddress: value('ap.inboxAddress') }
  const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
  const numbering = { ...base.numbering }
  const reset = (value('numbering.reset') ?? 'YEARLY') as 'YEARLY'
  for (const doc of ['AP', 'WHT_CERT'] as const) {
    const pattern = value(`numbering.${doc}`)
    if (pattern) numbering[doc] = { pattern, reset }
  }
  const next = {
    ...base,
    numbering,
    ...(Object.keys(defined(matching)).length ? { matching: { ...base.matching, ...defined(matching) } } : {}),
    ...(Object.keys(defined(wht)).length ? { wht: { ...base.wht, ...defined(wht) } } : {}),
    ...(Object.keys(defined(ap)).length ? { ap: { ...base.ap, ...defined(ap) } } : {}),
  }
  const parsed = OrgSettingsSchema.safeParse(next)
  if (!parsed.success) throw new Error(`Settings (S8): ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return parsed.data
}

export interface ApProfileReport {
  readonly whtTypes: number
  readonly suppliers: number
  readonly requestTypes: number
}

/**
 * Writes the profile in one transaction: income types not there yet (unconfirmed: BR-WHT-03, the accountant confirms
 * them), each supplier's tax and payment data, and the request types' retention. Events name what changed.
 */
export async function seedApProfile(organizationId: string, profile: ApProfile, now: Date): Promise<ApProfileReport> {
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    const events: EventDraft[] = []
    let whtTypes = 0
    const types = new Set((await tx.whtIncomeType.findMany({ select: { code: true } })).map((t) => t.code))
    for (const t of profile.whtTypes) {
      if (types.has(t.code)) continue
      const row = await tx.whtIncomeType.create({ data: { organizationId, code: t.code, nameTh: t.nameTh, rateBp: t.rateBp, form: t.form, legalRefTh: t.legalRefTh, active: true }, select: { id: true } })
      events.push({ type: 'wht_income_type.updated', aggregateType: 'WhtIncomeType', aggregateId: row.id, data: { code: t.code, rateBp: t.rateBp, form: t.form, active: true } })
      whtTypes++
    }
    let suppliers = 0
    const byCode = new Map((await tx.supplier.findMany({ select: { id: true, code: true, payeeType: true, defaultWhtIncomeTypeCode: true, paymentTermDays: true, eTaxIssuer: true, registryFlag: true } })).map((s) => [s.code, s]))
    for (const p of profile.payments) {
      const s = byCode.get(p.supplierCode)
      if (!s) throw new Error(`SupplierPayment: no supplier ${p.supplierCode}`)
      const next = { payeeType: p.payeeType, defaultWhtIncomeTypeCode: p.whtIncomeType, paymentTermDays: p.paymentTermDays, eTaxIssuer: p.eTaxIssuer, registryFlag: registryFlagOf(p.registryStatus) }
      if (s.payeeType === next.payeeType && s.defaultWhtIncomeTypeCode === next.defaultWhtIncomeTypeCode && s.paymentTermDays === next.paymentTermDays && s.eTaxIssuer === next.eTaxIssuer && s.registryFlag === next.registryFlag) continue
      await tx.supplier.update({ where: { id: s.id }, data: { ...next, ...(next.registryFlag !== s.registryFlag ? { registryFlaggedAt: now } : {}) } })
      events.push({ type: 'supplier.tax_profile_updated', aggregateType: 'Supplier', aggregateId: s.id, data: { payeeType: next.payeeType, defaultWhtIncomeTypeCode: next.defaultWhtIncomeTypeCode } })
      suppliers++
    }
    let requestTypes = 0
    for (const r of profile.retention) {
      const updated = await tx.requestType.updateMany({ where: { code: r.code, defaultRetentionBp: { not: r.defaultRetentionBp! } }, data: { defaultRetentionBp: r.defaultRetentionBp!, defaultRetentionHoldDays: r.defaultRetentionHoldDays } })
      requestTypes += updated.count
    }
    if (events.length) await appendEvents(tx, ctx, events)
    return { whtTypes, suppliers, requestTypes }
  })
}

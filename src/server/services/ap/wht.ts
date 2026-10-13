import { z } from 'zod'
import { paymentWithholding, retentionWhtBases, returnForm, whtBases, type WhtLine } from '@/core/wht'
import { BASIS_POINTS_WHOLE } from '@/lib/constants'
import { apPolicyOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { fail, type Fail } from './common'

// Withholding tax of tier-2 invoices (ADR-127, BR-WHT-03 to BR-WHT-06, FR-AP-104 AC2): the income types of the
// organization (WhtIncomeType · rate and form are data, never code) edited and confirmed by FINANCE — the confirmer is
// never the member who changed it last — and each supplier's payee type and default income type. An invoice line of a
// SERVICE PO starts with the supplier's default type; FINANCE changes it with the coding. When the invoice is ready for
// payment its bases and expected tax are worked out from its lines (whtBases, paymentWithholding of the invoice alone);
// the tax itself is withheld when it is paid (OQ-122), in recordInvoicePayment (./payment.ts).

async function whtGuard(tx: TenantTx, ctx: Ctx, capability: 'wht.configure' | 'supplier.taxProfile.manage'): Promise<{ ok: true; memberId: string } | Fail> {
  const allowed = await authorize(tx, ctx, capability)
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  return { ok: true, memberId: allowed.data.memberId }
}

// ---------- wht.incomeType.update / wht.incomeType.confirm ----------

const IncomeTypeInput = z.strictObject({
  code: z.string().trim().regex(/^[A-Z0-9_]{1,40}$/),
  nameTh: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200).nullable().optional(),
  rateBp: z.number().int().min(0).max(BASIS_POINTS_WHOLE),
  form: z.enum(['PND3_53', 'PND53', 'PND3']),
  legalRefTh: z.string().trim().min(1).max(200).nullable().optional(),
  active: z.boolean(),
})

/** FINANCE adds or changes an income type; any change waits for another member's confirmation again */
export const updateIncomeTypeCommand = defineCommand({
  name: 'wht.incomeType.update',
  capability: 'wht.configure',
  input: IncomeTypeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ id: string }>> {
    const who = await whtGuard(tx, ctx, 'wht.configure')
    if (!who.ok) return who
    const values = { nameTh: input.nameTh, nameEn: input.nameEn ?? null, rateBp: input.rateBp, form: input.form, legalRefTh: input.legalRefTh ?? null, active: input.active, updatedById: who.memberId, confirmedById: null, confirmedAt: null }
    const row = await tx.whtIncomeType.upsert({ where: { organizationId_code: { organizationId: ctx.organizationId, code: input.code } }, create: { organizationId: ctx.organizationId, code: input.code, ...values }, update: values, select: { id: true } })
    return { ok: true, result: { id: row.id }, events: [{ type: 'wht_income_type.updated', aggregateType: 'WhtIncomeType', aggregateId: row.id, data: { code: input.code, rateBp: input.rateBp, form: input.form, active: input.active } }] }
  },
})

const ConfirmInput = z.strictObject({ code: z.string().trim().min(1).max(40) })

/** Another FINANCE member confirms the rate (BR-WHT-03); the one who changed it last is refused SOD_VIOLATION */
export const confirmIncomeTypeCommand = defineCommand({
  name: 'wht.incomeType.confirm',
  capability: 'wht.configure',
  input: ConfirmInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ id: string }>> {
    const who = await whtGuard(tx, ctx, 'wht.configure')
    if (!who.ok) return who
    const type = await tx.whtIncomeType.findFirst({ where: { code: input.code }, select: { id: true, updatedById: true, confirmedById: true, rateBp: true } })
    if (!type) return fail('NOT_FOUND', 'income type not found')
    if (type.confirmedById) return fail('INVALID_STATE_TRANSITION', 'the income type is confirmed already', { from: 'CONFIRMED', command: 'wht.incomeType.confirm' })
    if (type.updatedById === who.memberId) return fail('SOD_VIOLATION', 'the member who changed a rate does not confirm it', { rule: 'BR-WHT-03' })
    await tx.whtIncomeType.update({ where: { id: type.id }, data: { confirmedById: who.memberId, confirmedAt: ctx.now } })
    return { ok: true, result: { id: type.id }, events: [{ type: 'wht_income_type.confirmed', aggregateType: 'WhtIncomeType', aggregateId: type.id, data: { code: input.code, rateBp: type.rateBp } }] }
  },
})

// ---------- supplier.taxProfile.update ----------

const TaxProfileInput = z.strictObject({ supplierId: z.uuid(), payeeType: z.enum(['JURISTIC', 'INDIVIDUAL', 'FOREIGN']), defaultWhtIncomeTypeCode: z.string().trim().min(1).max(40).nullable() })

/** FINANCE sets a supplier's payee type and default income type (BR-WHT-03, BR-WHT-04) */
export const updateTaxProfileCommand = defineCommand({
  name: 'supplier.taxProfile.update',
  capability: 'supplier.taxProfile.manage',
  input: TaxProfileInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ supplierId: string }>> {
    const who = await whtGuard(tx, ctx, 'supplier.taxProfile.manage')
    if (!who.ok) return who
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId }, select: { id: true } })
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    if (input.payeeType === 'FOREIGN') return fail('VALIDATION_FAILED', 'a foreign payee is outside phase 1', { field: 'payeeType', reason: 'FOREIGN_PAYEE' })
    if (input.defaultWhtIncomeTypeCode) {
      const checked = await checkIncomeTypes(tx, [input.defaultWhtIncomeTypeCode], input.payeeType)
      if (!checked.ok) return checked
    }
    await tx.supplier.update({ where: { id: supplier.id }, data: { payeeType: input.payeeType, defaultWhtIncomeTypeCode: input.defaultWhtIncomeTypeCode } })
    return { ok: true, result: { supplierId: supplier.id }, events: [{ type: 'supplier.tax_profile_updated', aggregateType: 'Supplier', aggregateId: supplier.id, data: { payeeType: input.payeeType, defaultWhtIncomeTypeCode: input.defaultWhtIncomeTypeCode } }] }
  },
})

// ---------- the income types of an invoice ----------

/**
 * BR-WHT-03, BR-WHT-04: every code is an active income type of the organization whose form fits the payee:
 * WHT_TYPE_NOT_CONFIGURED, WHT_FORM_PAYEE_MISMATCH, or VALIDATION_FAILED (a foreign payee is outside phase 1)
 */
export async function checkIncomeTypes(tx: TenantTx, codes: readonly string[], payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'): Promise<{ ok: true } | Fail> {
  const wanted = [...new Set(codes)]
  if (wanted.length === 0) return { ok: true }
  const types = await tx.whtIncomeType.findMany({ where: { code: { in: wanted }, active: true }, select: { code: true, form: true } })
  for (const code of wanted) {
    const type = types.find((t) => t.code === code)
    if (!type) return fail('WHT_TYPE_NOT_CONFIGURED', `income type ${code} is not set up`, { code })
    const form = returnForm(payeeType, type.form)
    if (!form.ok) return form.code === 'WHT_FORM_PAYEE_MISMATCH' ? fail('WHT_FORM_PAYEE_MISMATCH', `income type ${code} is not for a ${payeeType} payee`, { code, payeeType }) : fail('VALIDATION_FAILED', 'a foreign payee is outside phase 1', { field: 'payeeType', reason: 'FOREIGN_PAYEE' })
  }
  return { ok: true }
}

/** The income type a new invoice line starts with (BR-WHT-03): the supplier's default on a SERVICE PO, none for goods */
export function defaultIncomeType(po: { readonly kind: string }, supplier: { readonly defaultWhtIncomeTypeCode: string | null }): string | null {
  return po.kind === 'SERVICE' ? supplier.defaultWhtIncomeTypeCode : null
}

/**
 * The bases of invoices (BR-WHT-05): one WhtLine per (income type, rate) of each invoice, with the rate of the
 * organization's income type now (an inactive type keeps its rate: the invoice was coded with it), after the PO's
 * minimum (BR-WHT-06). The doc of each line is the invoice id.
 */
export async function invoiceWhtLines(tx: TenantTx, organizationSettings: unknown, invoiceIds: readonly string[]): Promise<Map<string, WhtLine[]>> {
  const coded = await codedInvoices(tx, organizationSettings, invoiceIds)
  return new Map(coded.map((c) => [c.id, whtBases({ doc: c.id, lines: c.lines, retentionSatang: c.retentionSatang, poNetSatang: c.poNetSatang, minimumBaseSatang: c.minimum })]))
}

/** The bases of released retentions paid (BR-WHT-05): each retention by the income types and rates of its invoice */
export async function retentionWhtLines(tx: TenantTx, organizationSettings: unknown, retentions: ReadonlyArray<{ readonly id: string; readonly invoiceId: string; readonly amountSatang: bigint }>): Promise<Map<string, WhtLine[]>> {
  const coded = await codedInvoices(tx, organizationSettings, retentions.map((r) => r.invoiceId))
  return new Map(
    retentions.map((r) => {
      const c = coded.find((x) => x.id === r.invoiceId)!
      return [r.id, retentionWhtBases({ doc: r.id, lines: c.lines, retentionSatang: r.amountSatang, poNetSatang: c.poNetSatang, minimumBaseSatang: c.minimum })]
    }),
  )
}

/** Invoices with each line's income type and the organization's rate now (an inactive type keeps its rate) */
async function codedInvoices(tx: TenantTx, organizationSettings: unknown, invoiceIds: readonly string[]) {
  const invoices = await tx.invoice.findMany({
    where: { id: { in: [...invoiceIds] } },
    select: { id: true, retentionSatang: true, po: { select: { netSatang: true } }, lines: { orderBy: { lineNo: 'asc' }, select: { netSatang: true, whtIncomeTypeCode: true } } },
  })
  const codes = [...new Set(invoices.flatMap((i) => i.lines.map((l) => l.whtIncomeTypeCode)).filter((c): c is string => !!c))]
  const types = codes.length ? await tx.whtIncomeType.findMany({ where: { code: { in: codes } }, select: { code: true, rateBp: true } }) : []
  const minimum = apPolicyOf(organizationSettings).whtMinimumBaseSatang
  return invoices.map((invoice) => ({
    id: invoice.id,
    retentionSatang: invoice.retentionSatang,
    poNetSatang: invoice.po.netSatang,
    minimum,
    lines: invoice.lines.map((l) => {
      const type = l.whtIncomeTypeCode ? types.find((x) => x.code === l.whtIncomeTypeCode) : undefined
      if (l.whtIncomeTypeCode && !type) throw new Error(`income type ${l.whtIncomeTypeCode} of a coded invoice line is gone`)
      return { incomeType: type ? type.code : null, rateBp: type?.rateBp ?? 0, netSatang: l.netSatang }
    }),
  }))
}

/** The tax expected on an invoice paid alone (BR-WHT-05): written on the invoice when it is ready for payment */
export async function expectedWhtOf(tx: TenantTx, organizationSettings: unknown, invoiceId: string): Promise<bigint> {
  const lines = (await invoiceWhtLines(tx, organizationSettings, [invoiceId])).get(invoiceId) ?? []
  const result = paymentWithholding(lines)
  // whtBases never makes a negative base: retention is a share of the same amounts
  if (!result.ok) throw new Error('a negative withholding base on a ready invoice')
  return result.whtSatang
}

export function updateIncomeType(ctx: Ctx, input: z.input<typeof IncomeTypeInput>, options: RunOptions) {
  return runCommand(ctx, updateIncomeTypeCommand, input, options)
}
export function confirmIncomeType(ctx: Ctx, input: z.input<typeof ConfirmInput>, options: RunOptions) {
  return runCommand(ctx, confirmIncomeTypeCommand, input, options)
}
export function updateSupplierTaxProfile(ctx: Ctx, input: z.input<typeof TaxProfileInput>, options: RunOptions) {
  return runCommand(ctx, updateTaxProfileCommand, input, options)
}

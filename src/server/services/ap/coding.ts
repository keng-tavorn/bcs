import { z } from 'zod'
import { suggestCoding, type CodingSuggestion } from '@/core/invoice/ap'
import { MS_PER_DAY } from '@/lib/constants'
import AP_DEFAULTS from '@/lib/ap-defaults.json'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { fail, type Fail } from './common'
import { INVOICED_STATUSES } from './match-run'

// Account codes of tier-2 invoices (FR-AP-108, BR-AP-10, OQ-128): FINANCE keeps the organization's list of codes
// (accountCode.manage), and each invoice line is offered the code used most often for the same supplier and category
// in the last 365 days, else its budget line's — no AI (EG-1). The suggestion is shown with where it came from; a
// person still confirms every line (invoice.confirmCoding), whose source says HISTORY when the code they chose is the
// one the history offered.

// TODO(OQ-128): the days of history a suggestion looks back over
const WINDOW_DAYS = (AP_DEFAULTS as { coding?: { windowDays?: number } }).coding?.windowDays ?? 365
const READY_OR_LATER = INVOICED_STATUSES.filter((s) => s !== 'PENDING_APPROVAL')

export interface LineSuggestion extends CodingSuggestion {
  readonly invoiceLineId: string
  /** The cost center's id (the suggestion carries its code) */
  readonly costCenterId: string
}

/** BR-AP-10 for every line of an invoice, read inside `tx` */
export async function suggestionsFor(tx: TenantTx, invoiceId: string, now: Date): Promise<LineSuggestion[]> {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { invoiceDate: true, supplier: { select: { taxId: true } }, lines: { orderBy: { lineNo: 'asc' }, select: { id: true, poLine: { select: { categoryCode: true, budgetLine: { select: { accountCode: true, costCenterId: true, costCenter: { select: { code: true } } } } } } } } },
  })
  // a draft without its date yet is offered what today would give
  const day = invoice.invoiceDate ?? new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  const from = new Date(day.getTime() - WINDOW_DAYS * MS_PER_DAY)
  const taxId = invoice.supplier.taxId
  const categories = [...new Set(invoice.lines.map((l) => l.poLine.categoryCode))]
  const history = taxId
    ? await tx.invoiceLine.findMany({
        where: {
          accountCode: { not: null },
          codingConfirmedAt: { not: null },
          invoiceId: { not: invoiceId },
          invoice: { status: { in: [...READY_OR_LATER] }, supplier: { taxId }, invoiceDate: { gte: from, lte: day } },
          // a line without a category matches the history of lines without one (BR-AP-10 compares them as equal)
          poLine: { OR: [{ categoryCode: { in: categories.filter((c): c is string => c !== null) } }, ...(categories.includes(null) ? [{ categoryCode: null }] : [])] },
        },
        select: { accountCode: true, poLine: { select: { categoryCode: true } }, invoice: { select: { invoiceDate: true } } },
      })
    : []
  const rows = history.map((h) => ({ taxId: taxId!, categoryCode: h.poLine.categoryCode, accountCode: h.accountCode!, invoiceDate: h.invoice.invoiceDate!.toISOString().slice(0, 10) }))
  return invoice.lines.map((l) => ({
    invoiceLineId: l.id,
    costCenterId: l.poLine.budgetLine.costCenterId,
    ...suggestCoding({
      invoiceDate: day.toISOString().slice(0, 10),
      taxId,
      categoryCode: l.poLine.categoryCode,
      budgetLine: { accountCode: l.poLine.budgetLine.accountCode, costCenter: l.poLine.budgetLine.costCenter?.code ?? '' },
      history: rows,
      windowDays: WINDOW_DAYS,
    }),
  }))
}

/** The suggestions of an invoice for its coding screen: FINANCE (invoice.record) of an organization with PAY */
export async function suggestInvoiceCoding(ctx: Ctx, invoiceId: string): Promise<{ ok: true; data: LineSuggestion[] } | Fail> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'invoice.record')
    if (!allowed.ok) return { ok: false as const, error: allowed.error }
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return { ok: false as const, error: pay.error }
    if (!(await tx.invoice.count({ where: { id: invoiceId } }))) return fail('NOT_FOUND', 'invoice not found')
    return { ok: true as const, data: await suggestionsFor(tx, invoiceId, ctx.now) }
  })
}

// ---------- accountCode.update ----------

const AccountCodeInput = z.strictObject({
  code: z.string().trim().regex(/^[0-9A-Za-z.-]{1,40}$/),
  nameTh: z.string().trim().min(1).max(200),
  type: z.enum(['COST', 'EXPENSE', 'ASSET', 'LIABILITY']),
  active: z.boolean(),
})

/** FINANCE adds a code or changes one (FR-AP-108); a code no longer used is made inactive, never deleted */
export const updateAccountCodeCommand = defineCommand({
  name: 'accountCode.update',
  capability: 'accountCode.manage',
  input: AccountCodeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ id: string }>> {
    const allowed = await authorize(tx, ctx, 'accountCode.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return { ok: false, error: pay.error }
    const values = { nameTh: input.nameTh, type: input.type, active: input.active }
    const row = await tx.accountCode.upsert({ where: { organizationId_code: { organizationId: ctx.organizationId, code: input.code } }, create: { organizationId: ctx.organizationId, code: input.code, ...values }, update: values, select: { id: true } })
    return { ok: true, result: { id: row.id }, events: [{ type: 'account_code.updated', aggregateType: 'AccountCode', aggregateId: row.id, data: { code: input.code, type: input.type, active: input.active } }] }
  },
})

export function updateAccountCode(ctx: Ctx, input: z.input<typeof AccountCodeInput>, options: RunOptions) {
  return runCommand(ctx, updateAccountCodeCommand, input, options)
}

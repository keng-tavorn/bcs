import type { AppError, ErrorCode } from '@/core/result'
import { INVOICE_MACHINE, transition, type InvoiceCommand, type InvoiceState } from '@/core/state-machines'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { requireModule } from '../modules'

// What every command of a tier-2 invoice starts with (S8): the refusal shape, the PAY module and the member who acts,
// and the invoice locked and checked against its state machine and the version the screen read.

export type Fail = { ok: false; error: AppError }
export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

/** POs an invoice can be made on (BR-MATCH-05) */
export const INVOICEABLE_PO_STATUSES = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const
/** The invoice as the subject of the AI-assist contract and of approvals */
export const SUBJECT = (id: string) => ({ type: 'INVOICE', id })

/** Authorized member of an organization with PAY switched on (BR-AP-13) */
export async function guard(tx: TenantTx, ctx: Ctx, capability: 'invoice.record' | 'invoice.reject' | 'invoice.variance.request'): Promise<{ ok: true; memberId: string } | Fail> {
  const allowed = await authorize(tx, ctx, capability)
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'only a member acts on an invoice')
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  return { ok: true, memberId: allowed.data.memberId }
}

/** Locks the invoice and checks the command against its state and the version the screen read */
export async function lockedInvoice(tx: TenantTx, ctx: Ctx, invoiceId: string, command: InvoiceCommand, version?: number) {
  const [id] = await lockRowsForUpdate(tx, 'Invoice', ctx.organizationId, [invoiceId])
  if (!id) return fail('NOT_FOUND', 'invoice not found')
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  const moved = transition(INVOICE_MACHINE, invoice.status as InvoiceState, command)
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${invoice.status}`, { from: invoice.status, command })
  if (version !== undefined && version !== invoice.version) return fail('CONFLICT_VERSION', 'the invoice changed since it was read', { version: invoice.version })
  return { ok: true as const, invoice, to: moved.to }
}

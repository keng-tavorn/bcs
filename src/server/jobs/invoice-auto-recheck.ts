import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { INVOICE_RECHECK_EVENT, recheckPoInvoices } from '@/server/services/ap/exceptions'

// Job invoice-auto-recheck (BR-MATCH-10, FR-AP-102 AC4, FR-AP-103 AC4): after a goods receipt is posted on a PO, every
// invoice of the PO waiting in EXCEPTION is matched again by SYSTEM, with one idempotency key per invoice and cause, so a
// replay of the event never matches twice. Tests call recheckPoInvoices directly.

export const InvoiceRecheckRequested = z.object({ organizationId: z.uuid(), poId: z.uuid(), cause: z.string().min(1).max(200) })

const PoChangeApproved = z.object({ organizationId: z.uuid(), aggregateId: z.uuid(), data: z.object({ poId: z.uuid() }) })

export const invoiceAutoRecheck = inngest.createFunction({ id: 'invoice-auto-recheck', triggers: [{ event: INVOICE_RECHECK_EVENT }, { event: 'bcs/po_change.approved' }] }, async ({ event, step }) => {
  // S8-10: an approved PO change (BR-POC-04) as well as a goods receipt
  const { organizationId, poId, cause } =
    event.name === 'bcs/po_change.approved'
      ? (({ organizationId, aggregateId, data }) => ({ organizationId, poId: data.poId, cause: `po_change:${aggregateId}` }))(PoChangeApproved.parse(event.data))
      : InvoiceRecheckRequested.parse(event.data)
  return step.run('recheck', async () => (await recheckPoInvoices(organizationId, poId, cause, systemClock.now())).map((r) => r.ok))
})

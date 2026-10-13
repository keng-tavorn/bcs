import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { INVOICE_RECHECK_EVENT, recheckPoInvoices } from '@/server/services/ap/exceptions'

// Job invoice-auto-recheck (BR-MATCH-10, FR-AP-102 AC4, FR-AP-103 AC4): after a goods receipt is posted on a PO, every
// invoice of the PO waiting in EXCEPTION is matched again by SYSTEM, with one idempotency key per invoice and cause, so a
// replay of the event never matches twice. Tests call recheckPoInvoices directly.

export const InvoiceRecheckRequested = z.object({ organizationId: z.uuid(), poId: z.uuid(), cause: z.string().min(1).max(200) })

export const invoiceAutoRecheck = inngest.createFunction({ id: 'invoice-auto-recheck', triggers: [{ event: INVOICE_RECHECK_EVENT }] }, async ({ event, step }) => {
  const { organizationId, poId, cause } = InvoiceRecheckRequested.parse(event.data)
  return step.run('recheck', async () => (await recheckPoInvoices(organizationId, poId, cause, systemClock.now())).map((r) => r.ok))
})

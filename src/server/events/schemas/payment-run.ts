import { z } from 'zod'
import { defineEvents } from '../registry'

// Payment runs of S9 (docs/sub-specs/S9.md "สิทธิ์ event error และการแจ้งเตือน", BR-PAY-01 to BR-PAY-10): ids, days,
// amounts in satang as text and counts only — never an account number or a free-text reason (the cancel reason stays
// on the run, PaymentRun.cancelReason).

const satang = z.string().regex(/^\d+$/)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

defineEvents('PaymentRun', {
  'payment_run.drafted': { schema: z.object({ payDate: day, payerBankAccountId: z.uuid() }) },
  'payment_run.updated': { schema: z.object({ fields: z.array(z.enum(['payDate', 'payerBankAccountId'])).min(1) }) },
  'payment_run.documents_added': { schema: z.object({ invoiceIds: z.array(z.uuid()), retentionIds: z.array(z.uuid()), itemCount: z.number().int().min(0), totalTransferSatang: satang }) },
  'payment_run.documents_removed': { schema: z.object({ invoiceIds: z.array(z.uuid()), retentionIds: z.array(z.uuid()), itemCount: z.number().int().min(0), totalTransferSatang: satang }) },
  'payment_run.submitted': { schema: z.object({ number: z.string().min(1), routeId: z.uuid(), payDate: day, itemCount: z.number().int().min(1), totalTransferSatang: satang, flaggedItems: z.number().int().min(0) }) },
  'payment_run.resubmitted': { schema: z.object({ number: z.string().min(1), routeId: z.uuid(), payDate: day, itemCount: z.number().int().min(1), totalTransferSatang: satang, flaggedItems: z.number().int().min(0) }) },
  /** afterExport: a file of the run had been downloaded (BR-PAY-10) */
  'payment_run.cancelled': { schema: z.object({ from: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FILE_READY']), afterExport: z.boolean(), documentCount: z.number().int().min(0) }) },
})

defineEvents('PaymentRunItem', {
  /** BR-PAY-06: the preparer's reason for the item's flags; the reason itself stays on the item */
  'payment_run_item.flag_reason_set': { schema: z.object({ paymentRunId: z.uuid(), supplierId: z.uuid(), flags: z.array(z.string()) }) },
})

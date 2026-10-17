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
  // schemaVersion 2: the reason documents were taken out is a Comment of the run (reasonCommentId), never Event.data
  'payment_run.documents_removed': { schemaVersion: 2, schema: z.object({ invoiceIds: z.array(z.uuid()), retentionIds: z.array(z.uuid()), itemCount: z.number().int().min(0), totalTransferSatang: satang, reasonCommentId: z.uuid() }) },
  'payment_run.submitted': { schema: z.object({ number: z.string().min(1), routeId: z.uuid(), payDate: day, itemCount: z.number().int().min(1), totalTransferSatang: satang, flaggedItems: z.number().int().min(0) }) },
  'payment_run.resubmitted': { schema: z.object({ number: z.string().min(1), routeId: z.uuid(), payDate: day, itemCount: z.number().int().min(1), totalTransferSatang: satang, flaggedItems: z.number().int().min(0) }) },
  // S9-06: the decision of DOA PAYMENT_RUN (flagsKey: the flags the approver was shown, BR-PAY-07)
  'payment_run.approved': { schema: z.object({ number: z.string().min(1), flagsKey: z.string(), totalTransferSatang: satang }) },
  'payment_run.rejected': { schema: z.object({ number: z.string().min(1), reasonCommentId: z.uuid().nullable(), documentCount: z.number().int().min(0) }) },
  'payment_run.returned': { schema: z.object({ number: z.string().min(1), reasonCommentId: z.uuid().nullable() }) },
  // S9-07: a version of the bank file (BR-BANK-07): its sha256, count and total, and whether the version before it
  // had been downloaded; marked sent to the bank and taken back (the reason is a Comment of the run)
  'payment_run.file_generated': { schema: z.object({ paymentFileId: z.uuid(), version: z.number().int().min(1), templateCode: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), itemCount: z.number().int().min(1), totalTransferSatang: satang, afterExport: z.boolean() }) },
  'payment_run.sent_to_bank': { schema: z.object({ paymentFileId: z.uuid(), fileVersion: z.number().int().min(1) }) },
  'payment_run.sent_reverted': { schema: z.object({ reasonCommentId: z.uuid() }) },
  // S9-08: every item has its result (BR-PAY-12)
  'payment_run.completed': { schema: z.object({ number: z.string().min(1), paidItems: z.number().int().min(0), failedItems: z.number().int().min(0), paidTransferSatang: satang }) },
  /** afterExport: a file of the run had been downloaded (BR-PAY-10) */
  'payment_run.cancelled': { schema: z.object({ from: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FILE_READY']), afterExport: z.boolean(), documentCount: z.number().int().min(0) }) },
})

defineEvents('PaymentRunItem', {
  /** BR-PAY-06: the preparer's reason for the item's flags; the reason itself stays on the item */
  'payment_run_item.flag_reason_set': { schema: z.object({ paymentRunId: z.uuid(), supplierId: z.uuid(), flags: z.array(z.string()) }) },
  // S9-08 (BR-PAY-12 BR-PAY-13): an item's result — the failure's reason and the bank's reference stay on the item —
  // and its payment advice sent again (the reason is a Comment of the item)
  'payment_run_item.paid': { schema: z.object({ paymentRunId: z.uuid(), supplierId: z.uuid(), paidOn: day, transferSatang: satang, whtSatang: satang, certificateId: z.uuid().nullable(), documentCount: z.number().int().min(1) }) },
  'payment_run_item.failed': { schema: z.object({ paymentRunId: z.uuid(), supplierId: z.uuid(), documentCount: z.number().int().min(0) }) },
  'payment_run_item.advice_resent': { schema: z.object({ paymentRunId: z.uuid(), noticeId: z.uuid().nullable(), reasonCommentId: z.uuid() }) },
})

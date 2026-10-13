import { z } from 'zod'
import { defineEvents } from '../registry'

// Tier-2 invoice events (spec §10.2 "invoice", docs/sub-specs/S8.md "State machine"): the draft, its coding, the
// submit and what the match decided. Amounts are satang as text. The supplier's invoice number is the supplier's, not
// personal data; no file content and no line text is carried.

const satang = z.string().regex(/^\d+$/)
const exceptionType = z.enum(['PRICE_OVER', 'QTY_NOT_RECEIVED', 'QTY_OVER_ORDERED', 'ACCEPTANCE_PENDING', 'VAT_MISMATCH', 'VAT_SUPPLIER_NOT_REGISTERED', 'POSSIBLE_DUPLICATE', 'BUDGET_SHORT'])

defineEvents('Invoice', {
  'invoice.drafted': {
    schema: z.object({
      poId: z.uuid(),
      supplierId: z.uuid(),
      channel: z.enum(['EMAIL', 'UPLOAD', 'PORTAL']),
      prefill: z.enum(['MANUAL', 'ETAX_XML', 'AI_READING']),
      /** S13: the AgentAction whose reading made the draft; null otherwise */
      agentActionId: z.uuid().nullable(),
      sourceFileId: z.uuid().nullable(),
      lineCount: z.number().int().min(0),
    }),
  },
  'invoice.updated': { schema: z.object({ changed: z.array(z.string()).min(1), netSatang: satang, statedVatSatang: satang }) },
  'invoice.coding_confirmed': {
    schema: z.object({ lines: z.array(z.object({ invoiceLineId: z.uuid(), accountCode: z.string().min(1), costCenterId: z.uuid(), source: z.enum(['HISTORY', 'BUDGET_LINE', 'MANUAL']), whtIncomeTypeCode: z.string().nullable() })).min(1) }),
  },
  'invoice.submitted': {
    schema: z.object({
      number: z.string().min(1),
      supplierInvoiceNoNormalized: z.string().min(1),
      netSatang: satang,
      statedVatSatang: satang,
      grossSatang: satang,
      matchId: z.uuid(),
    }),
  },
  'invoice.matched': { schema: z.object({ matchId: z.uuid(), runNo: z.number().int().min(1), netSatang: satang }) },
  'invoice.exception_raised': {
    schema: z.object({
      matchId: z.uuid(),
      runNo: z.number().int().min(1),
      exceptions: z.array(z.object({ type: exceptionType, amountSatang: satang, lineNo: z.number().int().min(1).nullable() })).min(1),
    }),
  },
  'invoice.ready': {
    schema: z.object({ dueDate: z.iso.date(), payableSatang: satang, expectedWhtSatang: satang, actualSatang: satang, holdMoreSatang: satang, releasedSatang: satang }),
  },
  'invoice.cancelled': { schema: z.object({ reason: z.string().min(1) }) },
  // S8-06 (BR-MATCH-10): the match again, a reopened draft, a rejection, and the approval of a price variance
  'invoice.rechecked': { schema: z.object({ matchId: z.uuid(), runNo: z.number().int().min(1), triggeredBy: z.enum(['USER', 'SYSTEM']), status: z.enum(['READY_FOR_PAYMENT', 'EXCEPTION']) }) },
  'invoice.reopened': { schema: z.object({}) },
  'invoice.rejected': { schema: z.object({ from: z.enum(['DRAFT', 'EXCEPTION']), reason: z.string().min(1) }) },
  'invoice.variance_submitted': {
    schema: z.object({ routeId: z.uuid(), netSatang: satang, vatSatang: satang, reason: z.string().min(1), doaVersionId: z.uuid(), doaRuleCode: z.string().min(1) }),
  },
  'invoice.variance_approved': { schema: z.object({ holdMoreSatang: satang }) },
  'invoice.variance_rejected': { schema: z.object({ decision: z.enum(['RETURNED', 'REJECTED']), reasonCommentId: z.uuid().nullable() }) },
  'match_exception.dismissed': { schema: z.object({ exceptionId: z.uuid(), type: exceptionType, reason: z.string().min(1) }) },
})

// S8-08 (ADR-127): what S9's commands do to an invoice through ./services/ap/payment.ts, and the withholding tax
defineEvents('Invoice', {
  'invoice.payment_held': { schema: z.object({ paymentRunId: z.uuid() }) },
  'invoice.payment_released': { schema: z.object({ reason: z.string().min(1) }) },
  'invoice.paid': { schema: z.object({ paymentRunItemId: z.uuid(), paidOn: z.iso.date(), payableSatang: satang, whtSatang: satang, transferSatang: satang }) },
})
const whtForm = z.enum(['PND3_53', 'PND53', 'PND3'])
defineEvents('WhtIncomeType', {
  'wht_income_type.updated': { schema: z.object({ code: z.string().min(1), rateBp: z.number().int().min(0), form: whtForm, active: z.boolean() }) },
  'wht_income_type.confirmed': { schema: z.object({ code: z.string().min(1), rateBp: z.number().int().min(0) }) },
})
// never a payee's tax id (BR-WHT-09)
defineEvents('WithholdingTax', {
  'withholding_tax.recorded': { schema: z.object({ invoiceId: z.uuid().nullable(), retentionId: z.uuid().nullable(), incomeTypeCode: z.string().min(1), rateBp: z.number().int().min(0), baseSatang: satang, taxSatang: satang, certificateId: z.uuid().nullable() }) },
})
defineEvents('WhtCertificate', {
  'wht_certificate.issued': { schema: z.object({ number: z.string().min(1), supplierId: z.uuid(), form: z.enum(['PND3', 'PND53']), paidOn: z.iso.date(), totalBaseSatang: satang, totalTaxSatang: satang, fileId: z.uuid(), paymentRunItemId: z.uuid() }) },
})
defineEvents('Supplier', {
  'supplier.tax_profile_updated': { schema: z.object({ payeeType: z.enum(['JURISTIC', 'INDIVIDUAL', 'FOREIGN']), defaultWhtIncomeTypeCode: z.string().nullable() }) },
})

// S8-09 (ADR-124): performance retention held from an invoice until its due date, released by FINANCE, paid by S9
const day = z.iso.date()
defineEvents('Retention', {
  'retention.held': { schema: z.object({ invoiceId: z.uuid(), amountSatang: satang, releaseDueOn: day.nullable() }) },
  'retention.released': { schema: z.object({ invoiceId: z.uuid(), amountSatang: satang, releaseDueOn: day }) },
  'retention.release_due': { schema: z.object({ invoiceId: z.uuid(), amountSatang: satang, releaseDueOn: day }) },
  'retention.payment_held': { schema: z.object({ paymentRunId: z.uuid() }) },
  'retention.payment_released': { schema: z.object({ reason: z.string().min(1) }) },
  'retention.paid': { schema: z.object({ paymentRunItemId: z.uuid(), paidOn: day, amountSatang: satang, whtSatang: satang, transferSatang: satang }) },
})

// S8-09 (ADR-124, BR-RET-01, BR-RET-03): a draft service PO's milestones and retention
defineEvents('PurchaseOrder', {
  'po.milestones_set': { schema: z.object({ poLineId: z.uuid(), sharesBp: z.array(z.number().int().min(1)).min(2), lineIds: z.array(z.uuid()).min(2), driftSatang: z.string().regex(/^-?\d+$/) }) },
  'po.retention_set': { schema: z.object({ retentionBp: z.number().int().min(0), retentionHoldDays: z.number().int().min(0).nullable() }) },
})

// The invoice inbox (ADR-123, BR-AP-02): what came in, never the body; skipped files are named with the reason
const skipped = z.array(z.object({ fileName: z.string(), reason: z.enum(['TYPE_NOT_ALLOWED', 'TOO_LARGE', 'EMPTY', 'OVER_LIMIT']) }))
defineEvents('InboundEmail', {
  'inbound_email.received': { schema: z.object({ provider: z.string().min(1), attachmentCount: z.number().int().min(0), skippedCount: z.number().int().min(0) }) },
  'inbound_email.processed': { schema: z.object({ draftCount: z.number().int().min(0), pendingCount: z.number().int().min(0), skipped }) },
  'inbound_email.ignored': { schema: z.object({ reason: z.string().min(1), skipped }) },
  'inbound_email.failed': { schema: z.object({ code: z.string().min(1), attempts: z.number().int().min(1) }) },
})

// E-mails to a supplier (ADR-126): sent or refused, naming the template and the document (S9 reads payment.advice's)
const noticeData = z.object({ noticeId: z.uuid(), templateKey: z.string().min(1), subjectType: z.string().min(1), subjectId: z.uuid() })
defineEvents('SupplierNotice', {
  'supplier_notice.sent': { schema: noticeData },
  'supplier_notice.failed': { schema: noticeData.extend({ reason: z.enum(['PROVIDER_REFUSED', 'TEMPLATE_UNKNOWN', 'NO_EMAIL']) }) },
})

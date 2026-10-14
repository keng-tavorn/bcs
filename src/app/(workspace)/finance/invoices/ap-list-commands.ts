import { z } from 'zod'
import type { Ctx } from '@/server/context'
import { getAgentAction } from '@/server/services/ai'
import { createDraftFromReading, createInvoice } from '@/server/services/ap'
import { uploadInvoiceFile } from '@/server/services/ap/files'
import { createInvoiceFromInbox, ignoreInboundEmail, pollInvoiceInbox } from '@/server/services/ap/inbox'
import { toApFailure, type ApDoneOutcome, type ApDraftOutcome, type ApFailure, type ApFileOutcome, type ApPollOutcome } from '@/ui/ap/list/outcome'

// The commands behind the tier-2 invoice list, inbox and upload screens (S8-13, FR-AP-101 AC1 AC2), apart from the
// session and the page cache so tests run them with a context. Every input is parsed first, so a malformed call gets
// VALIDATION_FAILED and never a crash; then the S8 service decides and checks the capability and module PAY again
// (invoice.record, invoice.inbox.manage), so a hidden button is never the guard (BR-AUTH-05). Each command that
// changes something runs with the idempotencyKey of its form (spec §4.3).

const Key = z.uuid()
const REASON_MAX = 500

const invalid = (field: string, reason?: string): ApFailure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })

const CreateInput = z.strictObject({ poId: z.uuid(), sourceFileId: z.uuid().nullable() })

/** /finance/invoices/new: a draft on the PO, from the file uploaded for it or without a file (invoice.create) */
export async function createApInvoiceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApDraftOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const parsed = CreateInput.safeParse(input)
  if (!parsed.success) return invalid(String(parsed.error.issues[0]?.path[0] ?? 'input'))
  const result = await createInvoice(ctx, parsed.data, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true, invoiceId: result.data.invoiceId } : toApFailure(result.error)
}

const FromReadingInput = z.strictObject({ agentActionId: z.uuid() })

/** What the Document Agent kept of an invoice it read (src/server/services/ai/agents/document.ts invoiceProposal) */
const InvoiceReading = z.object({
  fileId: z.uuid(),
  mapping: z.object({
    invoice: z.object({
      poId: z.uuid(),
      supplierInvoiceNo: z.string().optional(),
      invoiceDate: z.string().optional(),
      statedVat: z.string().optional(),
      discount: z.string().optional(),
      priceIncludesVat: z.boolean().optional(),
      lines: z.array(z.object({ poLineId: z.uuid(), quantity: z.string(), unitPrice: z.string() })).optional(),
    }),
  }),
})

/**
 * /finance/invoices/new, "อ่านไฟล์ด้วย AI" (S13-20, FR-AI-303 AC6): the draft from what the Document Agent read off the
 * file for the PO. The values come from the AI action as the server kept it — the browser sends its id only — and go to
 * invoice.createDraftFromReading, which links the reading so every value waits for FINANCE (AI_REVIEW_PENDING on submit).
 * Only the member who asked for the reading sees its content (getAgentAction), so only they make the draft from it.
 */
export async function createApInvoiceFromReadingFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApDraftOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const parsed = FromReadingInput.safeParse(input)
  if (!parsed.success) return invalid('agentActionId')
  const action = await getAgentAction(ctx, parsed.data.agentActionId)
  if (!action.ok) return toApFailure(action.error)
  if (action.data.purpose !== 'INVOICE_READ') return invalid('agentActionId', 'PURPOSE_MISMATCH')
  if (action.data.status !== 'DRAFT') return { ok: false, code: 'INVALID_STATE_TRANSITION', field: 'agentActionId' }
  const reading = InvoiceReading.safeParse(action.data.content?.output)
  if (!reading.success) return invalid('agentActionId', 'NO_READING')
  const { invoice } = reading.data.mapping
  const result = await createDraftFromReading(ctx, { ...invoice, fileId: reading.data.fileId, agentActionId: action.data.id }, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true, invoiceId: result.data.invoiceId } : toApFailure(result.error)
}

/** /finance/invoices/new: keeps the invoice's file for the PO (PDF, XML, JPEG or PNG by its bytes) */
export async function uploadApInvoiceFileFor(ctx: Ctx, poId: string, fileName: string, content: Uint8Array): Promise<ApFileOutcome> {
  if (!z.uuid().safeParse(poId).success) return invalid('poId')
  const result = await uploadInvoiceFile(ctx, { poId, fileName, content })
  return result.ok ? { ok: true, fileId: result.data.fileId } : toApFailure(result.error)
}

/** "ดึงอีเมลตอนนี้": reads the organization's inbox once (the same as the job) */
export async function pollInboxFor(ctx: Ctx, options: Parameters<typeof pollInvoiceInbox>[1] = {}): Promise<ApPollOutcome> {
  const result = await pollInvoiceInbox(ctx, options)
  if (!result.ok) return toApFailure(result.error)
  const { address, provider, received, drafts, failed } = result.data
  return { ok: true, configured: Boolean(address) && provider !== 'disabled', received, drafts, failed }
}

const IgnoreInput = z.strictObject({ inboundEmailId: z.uuid(), reason: z.string().max(REASON_MAX * 2) })

/** Skips a message with the reason FINANCE wrote */
export async function ignoreEmailFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApDoneOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const parsed = IgnoreInput.safeParse(input)
  if (!parsed.success) return invalid(String(parsed.error.issues[0]?.path[0] ?? 'input'))
  const reason = parsed.data.reason.trim()
  if (!reason) return invalid('reason', 'REQUIRED')
  if (reason.length > REASON_MAX) return invalid('reason', 'TOO_LONG')
  const result = await ignoreInboundEmail(ctx, { inboundEmailId: parsed.data.inboundEmailId, reason }, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true } : toApFailure(result.error)
}

const FromInboxInput = z.strictObject({ inboundEmailId: z.uuid(), fileId: z.uuid(), poId: z.uuid() })

/** A file of the inbox that waits for its PO: FINANCE chooses the PO and gets the draft (invoice.createFromInbox) */
export async function createFromInboxFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApDraftOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const parsed = FromInboxInput.safeParse(input)
  if (!parsed.success) return invalid(String(parsed.error.issues[0]?.path[0] ?? 'input'))
  const result = await createInvoiceFromInbox(ctx, parsed.data, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true, invoiceId: result.data.invoiceId } : toApFailure(result.error)
}

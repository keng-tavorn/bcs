import { z } from 'zod'
import { fieldConfidence, mapDeliveryNote, mapQuotation, matchPoLine, verifyReading, type CheckResult, type ReadingToCheck } from '@/core/ai-checks'
import { parseQuantity } from '@/core/money/math'
import { err, ok, type Result } from '@/core/result'
import { normalizeTaxId } from '@/core/thai/taxid'
import { rateFor, taxDateOf } from '@/core/vat'
import { AI_FILE_MEDIA_TYPES, getAiClient, type AiFileMediaType } from '@/integrations/ai'
import { readObject } from '@/integrations/storage'
import { AGENT_OF_PURPOSE, AI_LIMITS, modelFor, type AiPurposeName } from '@/lib/ai-config'
import { DocumentReading } from '@/lib/ai-schemas/document'
import { getEnv } from '@/lib/env'
import { contentMatchesType, isAllowedMimeType } from '@/lib/file-types'
import { loadPrincipal } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { forTenant } from '@/server/db/tenant'
import { getReceivingPo } from '@/server/queries/receiving'
import type { RunOptions } from '../../_pipeline'
import { mayViewFile } from '../../files'
import { readEtaxContent } from '../../invoices/etax'
import { getReceivingView } from '../../receiving/view'
import { completeAgentAction, requestAgentAction } from '../actions'
import { decimalText } from '../assist-contract'
import { aiRuntime } from '../gate'

// Document Agent for quotations and delivery notes (FR-AI-303 AC1–AC5 AC8, docs/sub-specs/S13.md BR-AI-12 to BR-AI-17
// BR-AI-25). readDocument checks the file, its kind and the document it is read for, refuses an e-Tax file before any
// AI call (BR-AI-12: no AgentAction, no credits), and starts a PENDING AgentAction. The job ai-agent-run then reads the
// file with the adapter, checks every amount and identity in core (S13-06) and records a DRAFT whose review proposes form
// values by path (assist-contract.ts): a quotation's fields at quotations.<fileId>.*, a receipt's received quantity at
// lines.<poLineId>.received. Nothing is written into a document here: the person's own command takes the values in.

export const READ_PURPOSE = { QUOTATION: 'QUOTATION_READ', DELIVERY_NOTE: 'DELIVERY_NOTE_READ' } as const satisfies Record<string, AiPurposeName>
export const DOCUMENT_PURPOSES: readonly AiPurposeName[] = Object.values(READ_PURPOSE)

export const ReadDocumentInput = z.strictObject({
  fileId: z.uuid(),
  purpose: z.enum(['QUOTATION', 'DELIVERY_NOTE']),
  /** The request a quotation is read for (none while a new request has no draft yet); the PO a delivery note is for */
  subject: z.strictObject({ type: z.enum(['REQUEST', 'PURCHASE_ORDER']), id: z.uuid() }).optional(),
})

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
/** The bytes are what the file says it is: the upload's own sniffing, and RIFF…WEBP for a WebP the uploads do not take yet */
const contentIs = (bytes: Uint8Array, mimeType: string) =>
  mimeType === 'image/webp' ? ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP' : isAllowedMimeType(mimeType) && contentMatchesType(bytes, mimeType)

export type FileRefusal = 'NOT_AVAILABLE' | 'TYPE' | 'TOO_LARGE' | 'CONTENT_MISMATCH' | 'ETAX'
const unsupported = (reason: FileRefusal) => err('AI_FILE_UNSUPPORTED', `the AI does not read this file (${reason})`, { field: 'fileId', reason })

/** May this member read a file for this document? A request: its requester while it is a draft or returned; a PO: a receiver who may post it now */
async function subjectRefusal(ctx: Ctx, input: z.output<typeof ReadDocumentInput>): Promise<Result<true>> {
  const subject = input.subject
  if (input.purpose === 'DELIVERY_NOTE') {
    if (subject?.type !== 'PURCHASE_ORDER') return err('VALIDATION_FAILED', 'a delivery note is read for a purchase order', { field: 'subject' })
    const view = await getReceivingView(ctx, subject.id)
    if (!view.ok) return view
    return view.data.receivable ? ok(true) : err('FORBIDDEN', 'this purchase order takes no goods from this member now')
  }
  if (!subject) return ok(true)
  if (subject.type !== 'REQUEST') return err('VALIDATION_FAILED', 'a quotation is read for a request', { field: 'subject' })
  const request = await forTenant(ctx.organizationId).request.findFirst({ where: { id: subject.id }, select: { requesterMemberId: true, status: true } })
  if (!request) return err('NOT_FOUND', 'request not found')
  if (ctx.actor.type !== 'USER' || request.requesterMemberId !== ctx.actor.memberId) return err('FORBIDDEN', 'only the requester adds quotations')
  return request.status === 'DRAFT' || request.status === 'RETURNED' ? ok(true) : err('INVALID_STATE_TRANSITION', `the request is ${request.status}`, { from: request.status })
}

/**
 * Starts reading a quotation or a delivery note (docs/sub-specs/S13.md "interface"): `{ agentActionId }` of a PENDING
 * action, read in the background by ai-agent-run. Refusals: the gates of BR-AI-11 by their codes, AI_FILE_UNSUPPORTED
 * for a file the AI does not read (reason ETAX for an e-Tax invoice, which goes to S8's e-Tax import instead).
 */
export async function readDocument(ctx: Ctx, rawInput: z.input<typeof ReadDocumentInput>, options: RunOptions): Promise<Result<{ agentActionId: string }>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member of the organization uses AI')
  const parsed = ReadDocumentInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: parsed.error.issues[0]?.path.join('.') || 'fileId' })
  const input = parsed.data
  const file = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const row = await tx.fileObject.findUnique({ where: { id: input.fileId }, select: { id: true, status: true, mimeType: true, sizeBytes: true, storageKey: true, sha256: true, uploadedById: true } })
    if (!row || row.status !== 'AVAILABLE') return null
    const principal = await loadPrincipal(tx, ctx)
    return (await mayViewFile(tx, ctx, principal, row)) ? row : null
  })
  if (!file) return unsupported('NOT_AVAILABLE')
  if (!(AI_FILE_MEDIA_TYPES as readonly string[]).includes(file.mimeType)) return unsupported('TYPE')
  if (file.sizeBytes > AI_LIMITS.maxFileBytes) return unsupported('TOO_LARGE')
  const subject = await subjectRefusal(ctx, input)
  if (!subject.ok) return subject
  const bytes = await readObject(file.storageKey)
  if (!contentIs(bytes, file.mimeType)) return unsupported('CONTENT_MISMATCH')
  // BR-AI-12: an e-Tax invoice is read from its XML (BR-IVC-05), never by the AI, and costs nothing
  const etax = readEtaxContent(bytes)
  if (etax && 'prefill' in etax.reading) return unsupported('ETAX')

  const started = await requestAgentAction(
    ctx,
    {
      purpose: READ_PURPOSE[input.purpose],
      ...(input.subject ? { subjectType: input.subject.type, subjectId: input.subject.id } : {}),
      inputRefs: { fileId: file.id, ...(file.sha256 ? { sha256: file.sha256 } : {}) },
    },
    options,
  )
  return started.ok ? ok({ agentActionId: started.data.agentActionId }) : started
}

// ---------- the background read (job ai-agent-run) ----------

type Reading = z.infer<typeof DocumentReading>
type CheckOfField = 'PASS' | 'WARN' | 'FAIL' | null

/** Every path of the reading that holds a value, as the checks and the confidence name them */
function readPaths(reading: Reading): string[] {
  const paths: string[] = []
  const add = (path: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== '') paths.push(path)
  }
  for (const key of ['docNo', 'docDate', 'currency', 'priceIncludesVat', 'discountTotal', 'net', 'vat', 'gross'] as const) add(key, reading[key])
  add('seller.name', reading.seller.name)
  add('seller.taxId', reading.seller.taxId)
  add('seller.branch', reading.seller.branch)
  add('buyer.taxId', reading.buyer.taxId)
  reading.lines.forEach((l, i) => {
    for (const key of ['description', 'qty', 'unit', 'unitPrice', 'amount'] as const) add(`lines.${i}.${key}`, l[key])
  })
  return paths
}

/** Confidence in bp of each path read, capped by its check (BR-AI-16); a path the model gave no confidence for has none */
function confidenceOf(reading: Reading, checks: CheckResult, minConfidenceBp: number) {
  const given = new Map(reading.confidence.map((c) => [c.field, c.value]))
  const checkOf = (path: string): CheckOfField => checks.fieldStatus[path] ?? checks.fieldStatus['*'] ?? null
  const out: Record<string, { confidenceBp: number; mustConfirm: boolean }> = {}
  for (const path of readPaths(reading)) out[path] = fieldConfidence({ field: path, modelConfidence: given.get(path) ?? 0, check: checkOf(path), minConfidenceBp })
  return out
}

interface Proposal {
  readonly proposed: Record<string, string>
  readonly requiredPaths: string[]
  readonly mapping: unknown
}

async function quotationProposal(now: Date, fileId: string, reading: Reading, checks: CheckResult, confidence: ReturnType<typeof confidenceOf>, registry: readonly { id: string; taxId: string; branch: string; nameTh: string }[]): Promise<Proposal> {
  const rate = rateFor(taxDateOf(now), await listTaxRates())
  const mapping = mapQuotation(reading as ReadingToCheck & Reading, checks, { fileId, vatRateBp: rate.ok ? rate.rateBp : 0, registry, normalized: checks.normalized })
  const proposed: Record<string, string> = {}
  const requiredPaths: string[] = []
  const q = mapping.quotation
  if (q) {
    const at = `quotations.${fileId}`
    // Each form value and the read fields it came from: it waits one by one when any of them must (BR-AI-16)
    const put = (path: string, value: string | null, from: readonly string[], critical = false) => {
      if (value === null) return
      proposed[`${at}.${path}`] = value
      if (critical || from.some((f) => confidence[f]?.mustConfirm ?? true)) requiredPaths.push(`${at}.${path}`)
    }
    // The name follows how surely it was read; the supplier of the register is the tax id's, confirmed one by one
    put('supplierName', q.supplierName, ['seller.name'])
    put('supplierId', q.supplierId, ['seller.taxId', 'seller.branch'], true)
    put('amount', q.amount, [q.includesVat ? 'gross' : 'net'], true)
    put('includesVat', String(q.includesVat), ['priceIncludesVat'])
  }
  return { proposed, requiredPaths, mapping }
}

async function deliveryNoteProposal(organizationId: string, now: Date, poId: string, reading: Reading): Promise<Proposal> {
  const po = await getReceivingPo(systemCtx(organizationId, now), poId)
  const poLines = (po?.lines ?? []).map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, uom: l.uom, openQty: l.outstanding }))
  // Lines without a readable quantity are left to the receiver; the others name their PO line by its words, in code
  const readable = reading.lines.flatMap((l, dnLine) => {
    try {
      return l.qty !== null && l.unit !== null && parseQuantity(l.qty) >= 0n ? [{ dnLine, qty: l.qty, unit: l.unit, poLineNo: matchPoLine(l.description, poLines) }] : []
    } catch {
      return []
    }
  })
  const mapped = mapDeliveryNote(readable, poLines)
  const proposed: Record<string, string> = {}
  for (const p of mapped.prefill) {
    const line = poLines.find((l) => l.lineNo === p.lineNo)!
    proposed[`lines.${line.id}.received`] = decimalText(p.received)
  }
  // Quantities are critical (OQ-147): every one is confirmed one by one
  const flags = mapped.flags.map((f) => ('dnLine' in f ? { ...f, dnLine: readable[f.dnLine]!.dnLine } : f))
  return { proposed, requiredPaths: Object.keys(proposed), mapping: { prefill: mapped.prefill, flags, poLineIds: Object.fromEntries(poLines.map((l) => [l.lineNo, l.id])) } }
}

/**
 * Reads the file of one PENDING Document action and records the answer (agent_action.complete, actor AI_AGENT): a DRAFT
 * with the reading, the checks, the confidence and the values proposed for the form, or FAILED with the reason. An
 * action that is no longer PENDING, or not the Document Agent's, is left as it is (a retry of the job repeats nothing).
 */
export async function runDocumentRead(organizationId: string, agentActionId: string, now: Date): Promise<'DRAFT' | 'FAILED' | 'SKIPPED'> {
  const db = forTenant(organizationId)
  const action = await db.agentAction.findFirst({ where: { id: agentActionId }, select: { id: true, status: true, agent: true, purpose: true, promptVersion: true, subjectType: true, subjectId: true, inputRefs: true } })
  if (!action || action.status !== 'PENDING' || !DOCUMENT_PURPOSES.includes(action.purpose)) return 'SKIPPED'
  const purpose = action.purpose as AiPurposeName
  const model = modelFor(AGENT_OF_PURPOSE[purpose], aiRuntime().modelEnv)
  const finish = async (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) => {
    const r = await completeAgentAction(organizationId, now, action.promptVersion, { agentActionId: action.id, requestedModel: model, ...input })
    return r.ok ? r.data.status === 'DRAFT' ? ('DRAFT' as const) : ('FAILED' as const) : ('SKIPPED' as const)
  }
  const fileId = (action.inputRefs as { fileId?: string } | null)?.fileId
  const file = fileId ? await db.fileObject.findFirst({ where: { id: fileId, status: 'AVAILABLE' }, select: { storageKey: true, mimeType: true } }) : null
  const noTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  if (!file || !fileId) return finish({ outcome: 'FAILED', model: null, errorCode: 'FILE_GONE', usage: noTokens, latencyMs: null })

  const bytes = await readObject(file.storageKey)
  const answer = await getAiClient(getEnv()).extract({ purpose, model, schema: DocumentReading, files: [{ bytes, mediaType: file.mimeType as AiFileMediaType }] })
  if (!answer.ok) return finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs })

  const reading = answer.output
  const setting = await db.aiAgentSetting.findFirst({ where: { agent: action.agent }, select: { minConfidenceBp: true } })
  const org = await db.organization.findFirstOrThrow({ where: { id: organizationId }, select: { taxId: true } })
  // The seller's register entries by the tax id read (VAT registration, and the supplier of a quotation)
  const sellerTaxId = reading.seller.taxId ? normalizeTaxId(reading.seller.taxId) : null
  const suppliers = sellerTaxId ? await db.supplier.findMany({ where: { taxId: sellerTaxId }, select: { id: true, taxId: true, branchCode: true, isVatRegistered: true, nameTh: true } }) : []
  const registry = suppliers.map((s) => ({ id: s.id, taxId: s.taxId!, branch: s.branchCode, vatRegistered: s.isVatRegistered, nameTh: s.nameTh }))
  // The supplier of the context: the PO's for a delivery note (never the one the AI read: BR-AI-15)
  const poSupplier =
    action.subjectType === 'PURCHASE_ORDER' && action.subjectId
      ? (await db.purchaseOrder.findFirst({ where: { id: action.subjectId }, select: { supplier: { select: { taxId: true, branchCode: true, isVatRegistered: true } } } }))?.supplier
      : null
  const checks = verifyReading(reading, {
    rates: await listTaxRates(),
    orgTaxId: org.taxId,
    now,
    supplier: poSupplier?.taxId ? { taxId: poSupplier.taxId, branch: poSupplier.branchCode, vatRegistered: poSupplier.isVatRegistered } : null,
    registry,
  })
  const confidence = confidenceOf(reading, checks, setting?.minConfidenceBp ?? 0)
  const proposal =
    purpose === 'DELIVERY_NOTE_READ'
      ? await deliveryNoteProposal(organizationId, now, action.subjectId ?? '', reading)
      : await quotationProposal(now, fileId, reading, checks, confidence, registry)
  const { normalized: _normalized, fieldStatus: _fieldStatus, ...checkSummary } = checks
  return finish({
    outcome: 'DRAFT',
    model: answer.model,
    output: { fileId, reading, mapping: proposal.mapping },
    verification: checkSummary,
    fieldConfidence: Object.fromEntries(Object.entries(confidence).map(([path, c]) => [path, c.confidenceBp])),
    review: { requiredPaths: proposal.requiredPaths.sort(), confirmedPaths: [], proposed: proposal.proposed },
    usage: answer.usage,
    latencyMs: answer.latencyMs,
  })
}

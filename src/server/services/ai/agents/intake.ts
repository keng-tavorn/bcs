import { z } from 'zod'
import { fieldConfidence, suggestChannel, type ChannelSuggestion } from '@/core/ai-checks'
import type { Condition } from '@/core/forms'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { lineNet, parseQuantity } from '@/core/money/math'
import { err, ok, type Result } from '@/core/result'
import { normalizeTaxId } from '@/core/thai/taxid'
import { taxDateOf } from '@/core/vat'
import { AI_FILE_MEDIA_TYPES, getAiClient, type AiFile, type AiFileMediaType } from '@/integrations/ai'
import { readObject } from '@/integrations/storage'
import { AI_LIMITS, modelForPurpose } from '@/lib/ai-config'
import { IntakeDraft, intakeInputText } from '@/lib/ai-schemas/agents'
import { getEnv } from '@/lib/env'
import { loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { formDefinition } from '@/server/forms/schema'
import type { RunOptions } from '../../_pipeline'
import { mayViewFile } from '../../files'
import { completeAgentAction, requestAgentAction } from '../actions'
import { decimalText } from '../assist-contract'
import { asData } from '../data'
import { aiRuntime } from '../gate'

// Intake Agent (FR-AI-302 AC1–AC5, FR-AI-303 AC9, BR-AI-19, OQ-148, docs/sub-specs/S13.md "interface"). What a requester
// wrote, with the files they attached (a quotation, a photo from the LINE chat, read in the same call), becomes values of
// a request of a type they may create: the title, the lines, the supplier of the register when the tax id and branch or
// the exact name match, the delivery site by its code. Never screening answers, budget lines, cost centres, approvers or
// other attachments; catalogue items only by codes that exist (none until S6's catalogue is in main). The purchase
// channel is computed by code (suggestChannel). The result proposes form values by path (requests/ai-assist.ts) for the
// requester's own request.create_draft or request.edit with aiAssist; nothing is created here.
//   startIntake        step 0 of the web form: a PENDING action, read in the background by ai-agent-run
//   intakeFromMessage  S17's chat job: synchronous in the caller's job, the text never kept, idempotent by key

export const StartIntakeInput = z.strictObject({
  requestTypeCode: z.string().min(1).max(50),
  text: z.string().max(AI_LIMITS.maxInputTextChars).default(''),
  fileIds: z.array(z.uuid()).max(AI_LIMITS.intakeMaxFiles).default([]),
  /** The draft the values go into, once it exists */
  requestId: z.uuid().optional(),
})

export const IntakeMessageInput = z.strictObject({
  chatIntakeId: z.uuid(),
  text: z.string().max(AI_LIMITS.maxInputTextChars).default(''),
  fileIds: z.array(z.uuid()).max(AI_LIMITS.intakeMaxFiles).default([]),
  idempotencyKey: z.string().min(1).max(200).optional(),
})

/** The files a member may give the Intake Agent: theirs to see, available, of a type the AI reads, not too large */
async function readableFiles(ctx: Ctx, fileIds: readonly string[]): Promise<Result<true>> {
  if (fileIds.length === 0) return ok(true)
  const refused = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    for (const id of fileIds) {
      const f = await tx.fileObject.findUnique({ where: { id }, select: { id: true, status: true, mimeType: true, sizeBytes: true, uploadedById: true } })
      if (!f || f.status !== 'AVAILABLE' || !(await mayViewFile(tx, ctx, principal, f))) return 'NOT_AVAILABLE'
      if (!(AI_FILE_MEDIA_TYPES as readonly string[]).includes(f.mimeType)) return 'TYPE'
      if (f.sizeBytes > AI_LIMITS.maxFileBytes) return 'TOO_LARGE'
    }
    return null
  })
  return refused ? err('AI_FILE_UNSUPPORTED', `the AI does not read this file (${refused})`, { field: 'fileIds', reason: refused }) : ok(true)
}

/** Step 0 of the web form (FR-AI-302 AC1): what the requester wrote and attached, read in the background */
export async function startIntake(ctx: Ctx, rawInput: z.input<typeof StartIntakeInput>, options: RunOptions): Promise<Result<{ agentActionId: string }>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member of the organization uses AI')
  const parsed = StartIntakeInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: parsed.error.issues[0]?.path.join('.') || 'text' })
  const input = parsed.data
  if (!input.text.trim() && input.fileIds.length === 0) return err('VALIDATION_FAILED', 'write what you need or attach a file', { field: 'text', reason: 'EMPTY' })
  const files = await readableFiles(ctx, input.fileIds)
  if (!files.ok) return files
  const db = forTenant(ctx.organizationId)
  if (!(await db.requestType.count({ where: { code: input.requestTypeCode, active: true } }))) return err('NOT_FOUND', 'unknown request type', { field: 'requestTypeCode' })
  if (input.requestId) {
    const r = await db.request.findFirst({ where: { id: input.requestId }, select: { requesterMemberId: true, status: true } })
    if (!r) return err('NOT_FOUND', 'request not found')
    if (r.requesterMemberId !== ctx.actor.memberId) return err('FORBIDDEN', 'only the requester fills their request')
    if (r.status !== 'DRAFT' && r.status !== 'RETURNED') return err('INVALID_STATE_TRANSITION', `the request is ${r.status}`, { from: r.status })
  }
  const started = await requestAgentAction(
    ctx,
    {
      purpose: 'INTAKE',
      ...(input.requestId ? { subjectType: 'REQUEST', subjectId: input.requestId } : {}),
      inputRefs: { requestTypeCode: input.requestTypeCode, fileIds: input.fileIds },
      ...(input.text.trim() ? { inputText: input.text } : {}),
    },
    options,
  )
  return started.ok ? ok({ agentActionId: started.data.agentActionId }) : started
}

/**
 * S17's chat job (FR-AI-302 AC5, FR-AI-303 AC9): reads the message now, in the caller's job, and returns the action as
 * it ended. The text is never stored (BR-AI-18); the same idempotencyKey again returns the action of that key as it is
 * now, without a new call or credits. Nothing is created: the owner's request.create_draft with aiAssist in LIFF is.
 */
export async function intakeFromMessage(ctx: Ctx, rawInput: z.input<typeof IntakeMessageInput>, options: RunOptions): Promise<Result<{ agentActionId: string; status: string }>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member of the organization uses AI')
  const parsed = IntakeMessageInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: parsed.error.issues[0]?.path.join('.') || 'text' })
  const input = parsed.data
  const files = await readableFiles(ctx, input.fileIds)
  if (!files.ok) return files
  const started = await requestAgentAction(
    ctx,
    { purpose: 'INTAKE', subjectType: 'CHAT_INTAKE', subjectId: input.chatIntakeId, inputRefs: { fileIds: input.fileIds }, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
    options,
  )
  if (!started.ok) return started
  const agentActionId = started.data.agentActionId
  if (!started.data.existing) await runIntake(ctx.organizationId, agentActionId, ctx.now, input.text)
  const row = await forTenant(ctx.organizationId).agentAction.findFirstOrThrow({ where: { id: agentActionId }, select: { status: true } })
  return ok({ agentActionId, status: row.status })
}

// ---------- the call and what it proposes ----------

const money = (v: string | null): string | null => {
  if (v === null) return null
  try {
    const s = amountToSatang(v.replace(/,/g, '').trim())
    return s >= 0n ? satangToAmount(s) : null
  } catch {
    return null
  }
}
const quantity = (v: string | null): string | null => {
  try {
    return v !== null && parseQuantity(v.trim()) > 0n ? decimalText(v.trim()) : null
  } catch {
    return null
  }
}
const words = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

export interface IntakeOutcome {
  readonly proposed: Record<string, string>
  readonly requiredPaths: string[]
  /** A type the requester may create that fits better than the form they opened (FR-AI-302 AC2), or none */
  readonly suggestedType: string | null
  /** The supplier named but not found in the register: shown as text, never created (BR-AI-19) */
  readonly supplierText: string | null
  readonly channel: ChannelSuggestion
}

/**
 * Calls the Intake Agent for one PENDING action and records its answer (agent_action.complete, actor AI_AGENT). `text`
 * comes from the caller (the chat, never stored) or from the action (the web's step 0, kept redacted).
 */
export async function runIntake(organizationId: string, agentActionId: string, now: Date, text?: string): Promise<'DRAFT' | 'FAILED' | 'SKIPPED'> {
  const db = forTenant(organizationId)
  const action = await db.agentAction.findFirst({ where: { id: agentActionId }, select: { id: true, status: true, purpose: true, promptVersion: true, inputRefs: true, inputText: true, subjectType: true } })
  if (!action || action.status !== 'PENDING' || action.purpose !== 'INTAKE') return 'SKIPPED'
  // A chat's text is never stored: only intakeFromMessage, which holds it, runs a chat intake (never the job)
  if (action.subjectType === 'CHAT_INTAKE' && text === undefined) return 'SKIPPED'
  const model = modelForPurpose('INTAKE', aiRuntime().modelEnv)
  const refs = (action.inputRefs ?? {}) as { requestTypeCode?: string; fileIds?: string[] }
  const finish = async (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) => {
    const r = await completeAgentAction(organizationId, now, action.promptVersion, { agentActionId: action.id, requestedModel: model, ...input })
    return r.ok ? (r.data.status === 'DRAFT' ? ('DRAFT' as const) : ('FAILED' as const)) : ('SKIPPED' as const)
  }

  // What the agent may choose from: the active types with a published form, the active sites (no catalogue before S6)
  const types = await db.requestType.findMany({ where: { active: true, currentFormVersion: { status: 'PUBLISHED' } }, select: { code: true, nameTh: true, descriptionTh: true, currentFormVersion: { select: { schema: true } } }, orderBy: { code: 'asc' } })
  const sites = await db.deliverySite.findMany({ where: { active: true }, select: { id: true, code: true, nameTh: true }, orderBy: { code: 'asc' } })
  const files: AiFile[] = []
  for (const id of refs.fileIds ?? []) {
    const f = await db.fileObject.findFirst({ where: { id, status: 'AVAILABLE' }, select: { storageKey: true, mimeType: true } })
    if (f) files.push({ bytes: await readObject(f.storageKey), mediaType: f.mimeType as AiFileMediaType })
  }
  const answer = await getAiClient(getEnv()).extract({
    purpose: 'INTAKE',
    model,
    schema: IntakeDraft,
    text: intakeInputText({ message: asData(text ?? action.inputText ?? ''), requestTypes: types.map((t) => ({ code: t.code, name: t.nameTh, description: t.descriptionTh })), items: [], sites: sites.map((s) => ({ code: s.code, name: s.nameTh })) }),
    files,
  })
  if (!answer.ok) return finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs })
  const draft = answer.output

  const setting = await db.aiAgentSetting.findFirst({ where: { agent: 'INTAKE' }, select: { minConfidenceBp: true } })
  const given = new Map(draft.confidence.map((c) => [c.field, c.value]))
  const proposed: Record<string, string> = {}
  const requiredPaths: string[] = []
  const put = (path: string, value: string | null, readField: string, critical = false) => {
    if (value === null || value === '') return
    proposed[path] = value
    const c = fieldConfidence({ field: readField, modelConfidence: given.get(readField) ?? 0, check: null, minConfidenceBp: setting?.minConfidenceBp ?? 0 })
    if (critical || c.mustConfirm) requiredPaths.push(path)
  }

  // The type: the form's own on the web (a better one is only suggested, AC2); proposed from the chat (S17)
  const known = draft.requestTypeCode && types.some((t) => t.code === draft.requestTypeCode) ? draft.requestTypeCode : null
  const formType = refs.requestTypeCode ?? null
  const suggestedType = formType && known && known !== formType ? known : null
  if (!formType) put('requestTypeCode', known, 'requestType', true)
  put('title', draft.title?.trim().slice(0, 200) || null, 'title')
  // A line without words is left out; each line kept reads its confidence at the place the model gave it (`read`)
  const lines = draft.lines.flatMap((l, read) => (l.description?.trim() ? [{ ...l, read }] : []))
  lines.forEach((l, i) => {
    put(`lines.${i}.description`, l.description!.trim().slice(0, 500), `lines.${l.read}.description`)
    put(`lines.${i}.quantity`, quantity(l.qty), `lines.${l.read}.qty`, true)
    put(`lines.${i}.uom`, l.unit?.trim() || null, `lines.${l.read}.unit`)
    put(`lines.${i}.unitPrice`, money(l.unitPrice), `lines.${l.read}.unitPrice`, true)
  })
  const site = draft.siteCode ? sites.find((s) => s.code === draft.siteCode) : undefined
  put('deliverySiteId', site?.id ?? null, 'siteCode')
  // The supplier of the register by tax id and branch, else by the exact name; otherwise the name stays text only
  const taxId = draft.supplier.taxId ? normalizeTaxId(draft.supplier.taxId) : null
  const byTax = taxId ? await db.supplier.findFirst({ where: { taxId, branchCode: draft.supplier.branch ?? '00000', status: 'ACTIVE' }, select: { id: true } }) : null
  const byName = !byTax && draft.supplier.name ? (await db.supplier.findMany({ where: { status: 'ACTIVE' }, select: { id: true, nameTh: true } })).filter((s) => words(s.nameTh) === words(draft.supplier.name!)) : []
  const supplierId = byTax?.id ?? (byName.length === 1 ? byName[0]!.id : null)
  put('suggestedSupplierId', supplierId, 'supplier.taxId', true)

  // The channel (golden ai-intake-channel): no catalogue items before S6, so a reorder or a standard request
  const type = types.find((t) => t.code === (formType ?? known))
  const rules = type?.currentFormVersion ? (formDefinition(type.currentFormVersion.schema).rules as readonly { id: string; when: Condition }[]) : []
  const gross = lines.reduce((sum, l) => {
    const q = quantity(l.qty)
    const p = money(l.unitPrice)
    return q && p ? sum + lineNet(q, amountToSatang(p)) : sum
  }, 0n)
  const channel = suggestChannel(
    { lines: lines.map(() => ({ itemCode: null })), amountGross: satangToAmount(gross) },
    // the day agreements are in force on, as the organization reads it (Thai calendar, BR-DATE-01)
    { asOf: taxDateOf(now), rules, catalog: [], pastRequests: [], reorderLookbackDays: AI_LIMITS.reorderLookbackDays },
  )
  const outcome: IntakeOutcome = { proposed, requiredPaths: [...new Set(requiredPaths)].sort(), suggestedType, supplierText: supplierId ? null : (draft.supplier.name ?? null), channel }
  return finish({
    outcome: 'DRAFT',
    model: answer.model,
    output: { draft, suggestedType, suggestedTypeName: suggestedType ? (types.find((t) => t.code === suggestedType)?.nameTh ?? null) : null, supplierText: outcome.supplierText, channel },
    fieldConfidence: Object.fromEntries(draft.confidence.map((c) => [c.field, Math.min(100, Math.max(0, Math.trunc(c.value))) * 100])),
    review: { requiredPaths: outcome.requiredPaths, confirmedPaths: [], proposed },
    usage: answer.usage,
    latencyMs: answer.latencyMs,
  })
}

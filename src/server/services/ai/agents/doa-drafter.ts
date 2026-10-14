import { z } from 'zod'
import { DOA_DOCUMENT_TYPES, lintDoaVersion, type DoaDocumentType, type DoaRuleSnapshot } from '@/core/doa'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { getAiClient } from '@/integrations/ai'
import { readObject } from '@/integrations/storage'
import { AI_LIMITS, modelForPurpose } from '@/lib/ai-config'
import { DoaDraft, doaDraftInputText } from '@/lib/ai-schemas/agents'
import { MS_PER_DAY, MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSnapshot } from '@/server/doa/policy'
import { doaVersionDataFromRows, doaYaml, type DoaVersionData } from '@/server/doa/yaml'
import type { RunOptions } from '../../_pipeline'
import { draftRuleText } from '../../doa/ai-assist'
import { enabledModules } from '../../modules'
import { completeAgentAction, requestAgentAction } from '../actions'
import { aiRuntime } from '../gate'

// DOA drafter (FR-AI-308 AC1–AC4, BR-AI-22, NG-12, OQ-146). A member holding admin.doa.draft — never PLATFORM_ADMIN —
// gives the organization's regulation (a PDF); the AI drafts its rules in the import shape of FR-DOA-001 AC2, each with
// the sentence it came from and its page. Code checks each rule: limits are baht amounts, the document type and the
// position exist in the organization; a rule that fails is shown with why and left out of the draft. The draft is one
// new version of the organization's DOA (its settings copied from the latest version), linted with BR-DOA-08 and shown
// beside the regulation; nothing is created until the person confirms every rule and creates it with doa.import_draft
// and aiAssist. Phase 1 reads no PDF in code: the person compares each source sentence with its page.

export const StartDoaDraftInput = z.strictObject({ fileId: z.uuid() })

export type RuleProblem = 'GT_NOT_BAHT' | 'LTE_NOT_BAHT' | 'UNKNOWN_DOCUMENT_TYPE' | 'UNKNOWN_POSITION' | 'MEMBER_APPROVER' | 'DUPLICATE_CODE'

const DEFAULT_SLA_MINUTES = 8 * 60
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])

/** Starts reading a regulation in the background (ai-agent-run); refused for anyone but a holder of admin.doa.draft */
export async function startDoaDraft(ctx: Ctx, rawInput: z.input<typeof StartDoaDraftInput>, options: RunOptions): Promise<Result<{ agentActionId: string }>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member of the organization drafts its DOA (NG-12)')
  const parsed = StartDoaDraftInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: 'fileId' })
  const db = forTenant(ctx.organizationId)
  const checked = await db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'admin.doa.draft')
    if (!allowed.ok) return allowed
    const f = await tx.fileObject.findUnique({ where: { id: parsed.data.fileId }, select: { status: true, mimeType: true, sizeBytes: true, uploadedById: true, storageKey: true } })
    if (!f || f.status !== 'AVAILABLE' || f.uploadedById !== (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)) return err('AI_FILE_UNSUPPORTED', 'the AI does not read this file (NOT_AVAILABLE)', { field: 'fileId', reason: 'NOT_AVAILABLE' })
    if (f.mimeType !== 'application/pdf') return err('AI_FILE_UNSUPPORTED', 'a regulation is a PDF', { field: 'fileId', reason: 'TYPE' })
    if (f.sizeBytes > AI_LIMITS.maxFileBytes) return err('AI_FILE_UNSUPPORTED', 'the file is too large', { field: 'fileId', reason: 'TOO_LARGE' })
    return ok(f.storageKey)
  })
  if (!checked.ok) return checked
  const head = (await readObject(checked.data)).subarray(0, PDF.length)
  if (!PDF.every((b, i) => head[i] === b)) return err('AI_FILE_UNSUPPORTED', 'the file is not a PDF', { field: 'fileId', reason: 'CONTENT_MISMATCH' })
  const started = await requestAgentAction(ctx, { purpose: 'DOA_DRAFT', inputRefs: { fileId: parsed.data.fileId } }, options)
  return started.ok ? ok({ agentActionId: started.data.agentActionId }) : started
}

const baht = (v: string | null): { ok: true; value: string | null } | { ok: false } => {
  if (v === null || v.trim() === '') return { ok: true, value: null }
  try {
    const s = amountToSatang(v.replace(/,/g, '').trim())
    return s >= 0n ? { ok: true, value: satangToAmount(s) } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** Midnight (Thai time) of the day after `now`: the draft's effective time, which the person may change before submitting */
function tomorrowThai(now: Date): Date {
  const thai = new Date(now.getTime() + 7 * 60 * MS_PER_MINUTE)
  const day = Date.UTC(thai.getUTCFullYear(), thai.getUTCMonth(), thai.getUTCDate())
  return new Date(day + MS_PER_DAY - 7 * 60 * MS_PER_MINUTE)
}

/** Reads the regulation of one PENDING DOA_DRAFT action and records the draft (agent_action.complete, actor AI_AGENT) */
export async function runDoaDraft(organizationId: string, agentActionId: string, now: Date): Promise<'DRAFT' | 'FAILED' | 'SKIPPED'> {
  const db = forTenant(organizationId)
  const action = await db.agentAction.findFirst({ where: { id: agentActionId }, select: { id: true, status: true, purpose: true, promptVersion: true, inputRefs: true } })
  if (!action || action.status !== 'PENDING' || action.purpose !== 'DOA_DRAFT') return 'SKIPPED'
  const model = modelForPurpose('DOA_DRAFT', aiRuntime().modelEnv)
  const finish = async (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) => {
    const r = await completeAgentAction(organizationId, now, action.promptVersion, { agentActionId: action.id, requestedModel: model, ...input })
    return r.ok ? (r.data.status === 'DRAFT' ? ('DRAFT' as const) : ('FAILED' as const)) : ('SKIPPED' as const)
  }
  const noTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const fileId = (action.inputRefs as { fileId?: string } | null)?.fileId
  const file = fileId ? await db.fileObject.findFirst({ where: { id: fileId, status: 'AVAILABLE' }, select: { storageKey: true } }) : null
  // The draft is the next version of the organization's DOA: its settings come from the latest version
  const base =
    (await db.doaVersion.findFirst({ where: { status: 'PUBLISHED' }, orderBy: [{ effectiveFrom: 'desc' }, { versionNo: 'desc' }], include: { rules: true } })) ??
    (await db.doaVersion.findFirst({ orderBy: [{ effectiveFrom: 'desc' }, { versionNo: 'desc' }], include: { rules: true } }))
  if (!file || !base) return finish({ outcome: 'FAILED', model: null, errorCode: !file ? 'FILE_GONE' : 'NO_BASE_VERSION', usage: noTokens, latencyMs: null })
  const positions = (await db.position.findMany({ select: { code: true }, orderBy: { code: 'asc' } })).map((p) => p.code)

  const answer = await getAiClient(getEnv()).extract({
    purpose: 'DOA_DRAFT',
    model,
    schema: DoaDraft,
    text: doaDraftInputText({ documentTypes: [...DOA_DOCUMENT_TYPES], positions }),
    files: [{ bytes: await readObject(file.storageKey), mediaType: 'application/pdf' }],
  })
  if (!answer.ok) return finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs })

  const baseData = doaVersionDataFromRows(base, base.rules)
  const slaOf = (type: string) => baseData.rules.find((r) => r.documentType === type)?.steps[0]?.slaBusinessMinutes ?? DEFAULT_SLA_MINUTES
  const seen = new Set<string>()
  const rules: DoaRuleSnapshot[] = []
  const shown = answer.output.rules.map((r) => {
    const problems: RuleProblem[] = []
    const gt = baht(r.gt)
    const lte = baht(r.lte)
    if (!gt.ok) problems.push('GT_NOT_BAHT')
    if (!lte.ok) problems.push('LTE_NOT_BAHT')
    if (!(DOA_DOCUMENT_TYPES as readonly string[]).includes(r.documentType)) problems.push('UNKNOWN_DOCUMENT_TYPE')
    if (r.approverKind === 'MEMBER') problems.push('MEMBER_APPROVER')
    else if (!r.approverPosition || !positions.includes(r.approverPosition)) problems.push('UNKNOWN_POSITION')
    if (seen.has(r.code)) problems.push('DUPLICATE_CODE')
    seen.add(r.code)
    if (problems.length === 0 && gt.ok && lte.ok) {
      const amount = gt.value !== null || lte.value !== null ? { amount: { ...(gt.value !== null ? { gt: amountToSatang(gt.value) } : {}), ...(lte.value !== null ? { lte: amountToSatang(lte.value) } : {}) } } : {}
      rules.push({
        code: r.code,
        documentType: r.documentType as DoaDocumentType,
        priority: 100,
        when: amount,
        steps: [{ approver: { kind: r.approverKind as 'POSITION_OF_DEPARTMENT' | 'POSITION_OF_ORG', position: r.approverPosition! }, slaBusinessMinutes: slaOf(r.documentType), mode: 'SEQUENTIAL' }],
      })
    }
    return { code: r.code, documentType: r.documentType, gt: gt.ok ? gt.value : r.gt, lte: lte.ok ? lte.value : r.lte, approverKind: r.approverKind, approverPosition: r.approverPosition, sourceText: r.sourceText, page: r.page, problems }
  })

  const latestNo = (await db.doaVersion.findFirst({ where: { code: baseData.code }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } }))!.versionNo
  const data: DoaVersionData = { ...baseData, versionNo: latestNo + 1, effectiveFrom: tomorrowThai(now), rules }
  const lint = await db.$transaction(async (tx) => lintDoaVersion({ id: 'draft', code: data.code, versionNo: data.versionNo, status: 'DRAFT', effectiveFrom: data.effectiveFrom, effectiveTo: null, amountBasis: data.amountBasis, selfApprovalPolicy: data.selfApprovalPolicy, collapseDuplicateApprovers: data.collapseDuplicateApprovers, rules }, await loadOrgSnapshot(tx), data.effectiveFrom, { modules: await enabledModules(tx) }))
  const issue = (i: { code: string; documentType?: string; rule?: string; gt?: bigint; lte?: bigint | null }) => ({ code: i.code, ...(i.documentType ? { documentType: i.documentType } : {}), ...(i.rule ? { rule: i.rule } : {}), ...(i.gt !== undefined ? { gt: satangToAmount(i.gt) } : {}), ...(i.lte !== undefined ? { lte: i.lte === null ? null : satangToAmount(i.lte) } : {}) })
  const proposed = Object.fromEntries(rules.map((r) => [`rules.${r.code}`, draftRuleText(r)]))
  return finish({
    outcome: 'DRAFT',
    model: answer.model,
    output: { yaml: doaYaml([data], new Map()), versionCode: data.code, versionNo: data.versionNo, rules: shown, lint: { errors: lint.errors.map(issue), warnings: lint.warnings.map(issue) } },
    review: { requiredPaths: Object.keys(proposed).sort(), confirmedPaths: [], proposed },
    usage: answer.usage,
    latencyMs: answer.latencyMs,
  })
}

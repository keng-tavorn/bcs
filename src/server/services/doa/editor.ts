import { z } from 'zod'
import {
  DOA_DOCUMENT_TYPES,
  NO_AMOUNT_DOCUMENT_TYPES,
  isCommitteeStep,
  lintDoaVersion,
  stepApprovers,
  type ApproverSpec,
  type CommitteeQuorum,
  type DoaDocumentType,
  type DoaRuleSnapshot,
  type DoaStepSpec,
  type DoaVersionSnapshot,
} from '@/core/doa'
import { err, ok, type Result } from '@/core/result'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { toJsonSafe } from '@/lib/json'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSnapshot } from '@/server/doa/policy'
import { ruleJson, ruleSnapshotFromRow } from '@/server/doa/snapshot'
import { doaVersionDataFromRows, type DoaVersionData } from '@/server/doa/yaml'
import { getDoaVersionRow, listDoaVersions } from '@/server/queries/doa'
import { listMembers, listPositions } from '@/server/queries/org'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { enabledModules } from '../modules'
import { stepKey } from './compare'
import { THAI_DATE, effectiveDates, thaiDateStart } from './dates'
import { diffVersions } from './diff'
import { laterVersionScheduled } from './index'
import { issueView } from './lint-view'
import { personOf, summaryOf, type DoaVersionSummaryView, type PersonView } from './view'

// The DOA editor of ORG_ADMIN (FR-DOA-001 AC1): a version is edited as a table per document type — amount bands, the
// approver position from the organization's positions, the time under the SLA — with the version's policies (amount
// basis, step-up threshold, sodPolicy and the two approval policies), starting from a copy of the latest version.
// A version never changes once it exists (FR-DOA-007 AC3, tests/generated/authority-writes.test.ts): saving the table
// creates a new draft with the next version number (doa_version.drafted, via COPY) and leaves the source untouched.
// A saved draft can be sent: the save refuses what the send would refuse anyway — a band table with gaps or overlaps
// or any other lint error, an effective date that has passed, or a version approved for the same or a later start —
// so no draft that can never be sent is left behind (drafts are never deleted). Lint warnings stay for the send, where
// each is ticked on its own (FR-DOA-002 AC1). PLATFORM_ADMIN, scripts and migrations never get here (NG-12): the
// capability is ORG_ADMIN's only.

const MINUTES_PER_HOUR = 60
/** A sanity bound on the time under the SLA a screen accepts (about 125 business days) */
export const SLA_MAX_HOURS = 999
const SLA_MAX_MINUTES = SLA_MAX_HOURS * MINUTES_PER_HOUR
const MAX_RULES = 200
const MAX_STEPS = 10
/** The rank a new rule gets when the source version has no rule to copy it from (the seed and the fixtures use it) */
const DEFAULT_PRIORITY = 100

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND', message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

// ---------- what the editor starts from ----------

/** A band as the editor holds it: lower end exclusive (gt) or inclusive (gte), upper end inclusive, satang text */
export interface EditorBand {
  readonly lowerKind: 'gt' | 'gte'
  readonly lower: string | null
  readonly upper: string | null
}

/** A committee step (S6 · FR-WF-102): the approvers and the quorum; quorumCount for COUNT only */
export interface EditorCommittee {
  readonly approvers: readonly ApproverSpec[]
  readonly quorum: CommitteeQuorum
  readonly quorumCount: number | null
}

/** One step: one approver, or a committee (then `approver` repeats its first approver for the screens of one) */
export interface EditorStep {
  readonly approver: ApproverSpec
  readonly slaMinutes: number
  readonly committee?: EditorCommittee
}

export interface EditorRule {
  readonly code: string
  readonly documentType: DoaDocumentType
  /** null = the rule has no amount condition */
  readonly band: EditorBand | null
  readonly steps: readonly EditorStep[]
}

/** A step of the engine as the editor holds it */
export function editorStep(s: DoaStepSpec): EditorStep {
  if (!isCommitteeStep(s)) return { approver: s.approver, slaMinutes: s.slaBusinessMinutes }
  return { approver: s.approvers[0]!, slaMinutes: s.slaBusinessMinutes, committee: { approvers: s.approvers, quorum: s.quorum, quorumCount: s.quorumCount ?? null } }
}

export interface EditorPolicy {
  readonly amountBasis: 'GROSS' | 'NET'
  readonly selfApprovalPolicy: 'ESCALATE_NEXT_BAND' | 'BLOCK'
  readonly collapseDuplicateApprovers: boolean
  /** satang text; null = not set */
  readonly stepUpThreshold: string | null
  readonly approverMayReceive: boolean
  readonly requesterMayReceive: boolean
}

export interface DoaEditorView {
  readonly source: DoaVersionSummaryView
  /** The number the saved draft gets */
  readonly nextVersionNo: number
  /** YYYY-MM-DD, Thai calendar */
  readonly defaultEffectiveDate: string
  readonly minEffectiveDate: string
  readonly policy: EditorPolicy
  readonly rules: readonly EditorRule[]
  /** Every position of the organization: the dropdown of approvers */
  readonly positions: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly scope: 'DEPARTMENT' | 'ORG' }>
  /** The people the source names as approvers (MEMBER), so their rules keep them */
  readonly members: readonly PersonView[]
}

async function allow(ctx: Ctx) {
  return forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.doa.draft'))
}

function editorBand(rule: DoaRuleSnapshot): EditorBand | null {
  const amount = rule.when.amount
  if (!amount) return null
  if (amount.gte !== undefined) return { lowerKind: 'gte', lower: amount.gte.toString(), upper: amount.lte === undefined ? null : amount.lte.toString() }
  return { lowerKind: 'gt', lower: amount.gt === undefined ? null : amount.gt.toString(), upper: amount.lte === undefined ? null : amount.lte.toString() }
}

export function editorPolicy(data: DoaVersionData): EditorPolicy {
  return {
    amountBasis: data.amountBasis,
    selfApprovalPolicy: data.selfApprovalPolicy,
    collapseDuplicateApprovers: data.collapseDuplicateApprovers,
    stepUpThreshold: data.stepUpThresholdSatang === null ? null : data.stepUpThresholdSatang.toString(),
    approverMayReceive: data.sodPolicy.approverMayReceive,
    requesterMayReceive: data.sodPolicy.requesterMayReceive,
  }
}

/** /admin/doa/[versionId]/edit: the version as an editable table, the number the draft will get and its dates. */
export async function getDoaEditor(ctx: Ctx, versionId: string): Promise<Result<DoaEditorView>> {
  const allowed = await allow(ctx)
  if (!allowed.ok) return allowed
  if (!z.uuid().safeParse(versionId).success) return err('NOT_FOUND', 'DOA version not found')
  const row = await getDoaVersionRow(ctx, versionId)
  if (!row) return err('NOT_FOUND', 'DOA version not found')
  const [members, positions, versions] = await Promise.all([listMembers(ctx), listPositions(ctx), listDoaVersions(ctx)])
  const person = personOf(members)
  const data = doaVersionDataFromRows(row, row.ruleRows)
  const sameCode = versions.filter((v) => v.code === row.code)
  const latestStart = sameCode.filter((v) => v.status === 'PUBLISHED').reduce<Date | null>((latest, v) => (latest && latest >= v.effectiveFrom ? latest : v.effectiveFrom), null)
  const dates = effectiveDates(ctx.now, latestStart)
  const named = [...new Set(data.rules.flatMap((r) => r.steps.flatMap(stepApprovers).flatMap((a) => (a.kind === 'MEMBER' ? [a.memberId] : []))))]
  return ok({
    source: summaryOf(row, person, ctx.now),
    nextVersionNo: Math.max(row.versionNo, ...sameCode.map((v) => v.versionNo)) + 1,
    defaultEffectiveDate: dates.defaultDate,
    minEffectiveDate: dates.minDate,
    policy: editorPolicy(data),
    rules: data.rules.map((r) => ({ code: r.code, documentType: r.documentType, band: editorBand(r), steps: r.steps.map(editorStep) })),
    positions: positions.map((p) => ({ code: p.code, nameTh: p.nameTh, nameEn: p.nameEn, scope: p.scope })),
    members: named.map((id) => person(id)!),
  })
}

// ---------- saving the table as a new draft ----------

const SatangText = z.string().regex(/^\d{1,15}$/, 'satang as a whole number written as text')
const Code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/)

const ApproverInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('POSITION_OF_DEPARTMENT'), position: Code }),
  z.strictObject({ kind: z.literal('POSITION_OF_ORG'), position: Code }),
  z.strictObject({ kind: z.literal('MEMBER'), memberId: z.uuid() }),
])

/** At most this many approvers in one committee */
const MAX_COMMITTEE = 20
const SlaMinutes = z.number().int().positive().max(SLA_MAX_MINUTES)
// A step names one approver; with `committee` it is a committee (FR-WF-102) and `approver` is its first approver. Lint
// checks the number of approvers and the quorum (BR-WF-05) as the send does
const StepInput = z
  .strictObject({
    approver: ApproverInput,
    slaMinutes: SlaMinutes,
    committee: z
      .strictObject({
        approvers: z.array(ApproverInput).min(1).max(MAX_COMMITTEE),
        quorum: z.enum(['ALL', 'ANY', 'COUNT', 'MAJORITY']),
        quorumCount: z.number().int().positive().max(MAX_COMMITTEE).nullable(),
      })
      .optional(),
  })
  .refine((s) => !s.committee || JSON.stringify(s.committee.approvers[0]) === JSON.stringify(s.approver), {
    message: 'a committee step names its first approver as approver',
    path: ['approver'],
  })

const RuleInput = z.strictObject({
  code: Code,
  documentType: z.enum(DOA_DOCUMENT_TYPES),
  band: z.strictObject({ lowerKind: z.enum(['gt', 'gte']), lower: SatangText.nullable(), upper: SatangText.nullable() }).nullable(),
  steps: z.array(StepInput).min(1).max(MAX_STEPS),
})

const PolicyInput = z.strictObject({
  amountBasis: z.enum(['GROSS', 'NET']),
  selfApprovalPolicy: z.enum(['ESCALATE_NEXT_BAND', 'BLOCK']),
  collapseDuplicateApprovers: z.boolean(),
  stepUpThreshold: SatangText.nullable(),
  approverMayReceive: z.boolean(),
  requesterMayReceive: z.boolean(),
})

export const DraftCopyInput = z.strictObject({
  /**
   * The version the table was copied from: its code, its escalation policy, the rank of its rules, and the description
   * of each rule whose band and steps did not change
   */
  sourceVersionId: z.uuid(),
  /** A Thai calendar date; the version starts at 00:00 Thai time */
  effectiveDate: z.string().regex(THAI_DATE),
  changeReason: z.string().trim().min(3).max(REASON_MAX_LENGTH),
  policy: PolicyInput,
  rules: z.array(RuleInput).min(1).max(MAX_RULES),
})
export type DraftCopyInput = z.input<typeof DraftCopyInput>

/** A band as a comparable key: each end with its kind, satang as text */
const bandKey = (rule: DoaRuleSnapshot) => {
  const a = rule.when.amount
  return a ? `gt:${a.gt ?? '-'}|gte:${a.gte ?? '-'}|lte:${a.lte ?? '-'}` : 'none'
}
/** Steps as a comparable key: each approver (or committee) with its time under the SLA and its mode, in order */
const stepsKey = (rule: DoaRuleSnapshot) => rule.steps.map((s) => `${stepKey(s)}@${s.slaBusinessMinutes}@${s.mode}`).join('>')

/** The two rules hold the same band and the same steps (what a rule's description puts in words) */
export const sameBandAndSteps = (a: DoaRuleSnapshot, b: DoaRuleSnapshot) => bandKey(a) === bandKey(b) && stepsKey(a) === stepsKey(b)

/** The most common rank among these rules (the first of a tie), or none */
function commonPriority(rules: readonly { readonly priority: number }[]): number | null {
  const counts = new Map<number, number>()
  for (const r of rules) counts.set(r.priority, (counts.get(r.priority) ?? 0) + 1)
  let best: number | null = null
  for (const [priority, count] of counts) if (best === null || count > counts.get(best)!) best = priority
  return best
}

export const draftDoaCopyCommand = defineCommand({
  name: 'doa.draft_copy',
  capability: 'admin.doa.draft',
  input: DraftCopyInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; code: string; versionNo: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.doa.draft')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (ctx.actor.type !== 'USER') return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member drafts a DOA version' } }
    // One draft number at a time: two drafts saved together would otherwise take the same number
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const source = await tx.doaVersion.findFirst({ where: { id: input.sourceVersionId }, include: { rules: { orderBy: { id: 'asc' } } } })
    if (!source) return fail('NOT_FOUND', 'DOA version not found')

    const effectiveFrom = thaiDateStart(input.effectiveDate)
    if (!effectiveFrom) return fail('VALIDATION_FAILED', 'not a calendar date', { field: 'effectiveDate', reason: 'DATE' })
    // BR-DOA-12: never in the past; ADR-042 item 7: after every version of the code that is approved for later
    if (effectiveFrom.getTime() < ctx.now.getTime()) return fail('VALIDATION_FAILED', 'the effective time is in the past', { field: 'effectiveDate', reason: 'EFFECTIVE_IN_PAST' })
    const id = newId()
    const later = await laterVersionScheduled(tx, { id, code: source.code }, effectiveFrom)
    if (later) return { ok: false, error: { ...later.error, details: { ...later.error.details, field: 'effectiveDate' } } }

    // The rules as the engine reads them; rank and description come from the source rule of the same code
    const sourceRules = source.rules.map((r) => ({ priority: r.priority, documentType: r.documentType, code: r.code, descriptionTh: r.descriptionTh, snapshot: ruleSnapshotFromRow(r) }))
    const byCode = new Map(sourceRules.map((r) => [r.code, r]))
    const seen = new Set<string>()
    const rules: DoaRuleSnapshot[] = []
    for (const [i, r] of input.rules.entries()) {
      if (seen.has(r.code)) return fail('VALIDATION_FAILED', `rule code ${r.code} is used twice`, { field: `rules.${i}.code`, reason: 'DUPLICATE_RULE', rule: r.code })
      seen.add(r.code)
      const band = r.band && (r.band.lower !== null || r.band.upper !== null) ? r.band : null
      if (band && NO_AMOUNT_DOCUMENT_TYPES.includes(r.documentType)) return fail('VALIDATION_FAILED', 'this document type has no amount', { field: `rules.${i}.band`, reason: 'BAND_NOT_ALLOWED', rule: r.code })
      if (band && band.lower !== null && band.upper !== null) {
        const lower = BigInt(band.lower)
        const upper = BigInt(band.upper)
        if (band.lowerKind === 'gt' ? lower >= upper : lower > upper) return fail('VALIDATION_FAILED', 'the band ends before it starts', { field: `rules.${i}.band`, reason: 'BAND_ORDER', rule: r.code })
      }
      const from = byCode.get(r.code)
      const same = from && from.documentType === r.documentType ? from : undefined
      const priority = same ? same.priority : (commonPriority(sourceRules.filter((x) => x.documentType === r.documentType)) ?? commonPriority(sourceRules) ?? DEFAULT_PRIORITY)
      const rule: DoaRuleSnapshot = {
        code: r.code,
        documentType: r.documentType,
        priority,
        when: band
          ? {
              amount: {
                ...(band.lower !== null ? (band.lowerKind === 'gt' ? { gt: BigInt(band.lower) } : { gte: BigInt(band.lower) }) : {}),
                ...(band.upper !== null ? { lte: BigInt(band.upper) } : {}),
              },
            }
          : {},
        steps: r.steps.map(
          (s): DoaStepSpec =>
            s.committee
              ? {
                  approvers: s.committee.approvers.map((a) => ({ ...a })),
                  slaBusinessMinutes: s.slaMinutes,
                  mode: 'PARALLEL',
                  quorum: s.committee.quorum,
                  ...(s.committee.quorumCount !== null ? { quorumCount: s.committee.quorumCount } : {}),
                }
              : { approver: { ...s.approver }, slaBusinessMinutes: s.slaMinutes, mode: 'SEQUENTIAL' },
        ),
      }
      // A description says the rule's band and approver in words ("ขอซื้อไม่เกิน 20,000 บาท → ผู้จัดการฝ่าย"): it travels
      // only with a rule whose band and steps did not change, never into a rule it would contradict
      rules.push(same?.descriptionTh && sameBandAndSteps(same.snapshot, rule) ? { ...rule, descriptionTh: same.descriptionTh } : rule)
    }

    // Approvers are positions of this organization, or its members
    const positionCodes = [...new Set(rules.flatMap((r) => r.steps.flatMap(stepApprovers).flatMap((a) => (a.kind === 'MEMBER' ? [] : [a.position]))))]
    const known = new Set((await tx.position.findMany({ where: { code: { in: positionCodes } }, select: { code: true } })).map((p) => p.code))
    const memberIds = [...new Set(rules.flatMap((r) => r.steps.flatMap(stepApprovers).flatMap((a) => (a.kind === 'MEMBER' ? [a.memberId] : []))))]
    const members = new Set((await tx.member.findMany({ where: { id: { in: memberIds } }, select: { id: true } })).map((m) => m.id))
    for (const [i, r] of rules.entries()) {
      for (const [j, s] of r.steps.entries()) {
        for (const a of stepApprovers(s)) {
          const missing = a.kind === 'MEMBER' ? !members.has(a.memberId) : !known.has(a.position)
          if (missing) return fail('VALIDATION_FAILED', 'unknown approver', { field: `rules.${i}.steps.${j}.approver`, reason: a.kind === 'MEMBER' ? 'MEMBER' : 'POSITION', rule: r.code })
        }
      }
    }

    // BR-DOA-08: the full lint against the organization on the effective date with the modules on now (BR-DOA-23), as
    // the send will run it
    const snapshot: DoaVersionSnapshot = {
      id,
      code: source.code,
      versionNo: 1,
      status: 'DRAFT',
      effectiveFrom,
      effectiveTo: null,
      amountBasis: input.policy.amountBasis,
      selfApprovalPolicy: input.policy.selfApprovalPolicy,
      collapseDuplicateApprovers: input.policy.collapseDuplicateApprovers,
      rules,
    }
    const lint = lintDoaVersion(snapshot, await loadOrgSnapshot(tx), effectiveFrom, { modules: await enabledModules(tx) })
    if (lint.errors.length) return { ok: false, error: { code: 'DOA_LINT_FAILED', message: 'the DOA version does not pass the lint', details: { errors: lint.errors.map(issueView) } } }

    const last = await tx.doaVersion.aggregate({ where: { code: source.code }, _max: { versionNo: true } })
    const versionNo = (last._max.versionNo ?? 0) + 1
    const sod = { approverMayReceive: input.policy.approverMayReceive, requesterMayReceive: input.policy.requesterMayReceive }
    const stepUpThresholdSatang = input.policy.stepUpThreshold === null ? null : BigInt(input.policy.stepUpThreshold)
    // What changed from the version it was copied from, kept with the draft (FR-DOA-001 AC3 history)
    const sourceData = doaVersionDataFromRows(source, source.rules)
    const draftData: DoaVersionData = {
      code: source.code,
      versionNo,
      effectiveFrom,
      amountBasis: input.policy.amountBasis,
      selfApprovalPolicy: input.policy.selfApprovalPolicy,
      collapseDuplicateApprovers: input.policy.collapseDuplicateApprovers,
      stepUpThresholdSatang,
      sodPolicy: sod,
      rules,
    }
    const diff = diffVersions(sourceData, draftData)
    await tx.doaVersion.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        code: source.code,
        versionNo,
        status: 'DRAFT',
        effectiveFrom,
        amountBasis: input.policy.amountBasis,
        selfApprovalPolicy: input.policy.selfApprovalPolicy,
        collapseDuplicateApprovers: input.policy.collapseDuplicateApprovers,
        stepUpThresholdSatang,
        // The reminder and escalation times travel with the copy: the editor does not change them
        escalationPolicy: (source.escalationPolicy ?? {}) as object,
        sodPolicy: sod,
        changeReason: input.changeReason,
        diffSummary: toJsonSafe({ fromVersionId: source.id, fromVersionNo: source.versionNo, ...diff }) as object,
      },
    })
    for (const rule of rules) {
      const json = ruleJson(rule)
      await tx.doaRule.create({
        data: { organizationId: ctx.organizationId, doaVersionId: id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps, descriptionTh: rule.descriptionTh ?? null },
      })
    }
    return {
      ok: true,
      result: { versionId: id, code: source.code, versionNo },
      events: [
        {
          type: 'doa_version.drafted',
          aggregateType: 'DoaVersion',
          aggregateId: id,
          data: { code: source.code, versionNo, via: 'COPY', rules: rules.length, fromVersionId: source.id, fromVersionNo: source.versionNo },
        },
      ],
    }
  },
})

/** Saves the editor's table as a new draft (FR-DOA-001 AC1); the source version does not change. */
export function draftDoaCopy(ctx: Ctx, input: DraftCopyInput, options: RunOptions) {
  return runCommand(ctx, draftDoaCopyCommand, input, options)
}

import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import type { AppError, Result } from '@/core/result'
import { maxTier, overrideExpiryCheck, overrideWindow, type GateReason, type RiskTierCode } from '@/core/risk'
import { RISK_OVERRIDE_MACHINE, transition, type RiskOverrideCommand, type RiskOverrideState } from '@/core/state-machines'
import { dateIn } from '@/core/supplier-docs'
import { RISK_OVERRIDE_REASON_MAX, RISK_OVERRIDE_REASON_MIN } from '@/lib/constants'
import { riskSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { riskOverridesForPayment } from '@/server/queries/risk-overrides'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { startRoute } from '../approvals/route'
import { requireModule } from '../modules'
import { issueDocumentNumber } from '../numbering'
import { loadAssessment, questionsOf } from './assessments'
import { evaluatePoGate, storedRiskGate } from './gate'
import { RISK_TIMEZONE } from './screening'

// Risk overrides (S11-08 · FR-RSK-203 AC2 AC3 AC5 · BR-RSK-10 BR-RSK-11 · BR-DOA-28 · BR-SOD-15 · ADR-226 · OQ-224 OQ-225):
// PROCUREMENT asks to let POs out to a supplier the risk gate holds — for one PO or every PO of the supplier — within a
// cap with VAT that counts every PO it lets out (cumulative · OQ-224) and until a last day no later than the send day +
// settings.risk.overrideMaxDays. Sent, it routes under DOA RISK_OVERRIDE with the cap as its amount (VAT 0) in the
// requester's department; the requester, the PO's creator and whoever filled in the supplier's open assessment are kept
// off the route and refused at deciding (BR-SOD-15). The approvers decide it through approval.decide and the adapter
// subjects/risk-override.ts; the gate (gate.ts) counts its use. A supplier with a registry flag gets none (BR-RSK-12);
// one open override per supplier (RISK_OVERRIDE_OPEN). Only who asked edits, sends or cancels it. Every command needs RISK.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const iso = (d: Date) => d.toISOString().slice(0, 10)
const asDate = (day: string) => new Date(`${day}T00:00:00Z`)

const Baht = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
const Reason = z.string().trim().min(RISK_OVERRIDE_REASON_MIN).max(RISK_OVERRIDE_REASON_MAX)
const OPEN = ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'] as const
const OPEN_ASSESSMENT = ['DRAFT', 'IN_REVIEW', 'RETURNED'] as const
/** A PO that is over: an override for it lets nothing out */
const CLOSED_PO = ['CANCELLED', 'CLOSED'] as const

/** Gate refusals an override clears (BR-RSK-09 steps 4 and 5): never a registry flag (BR-RSK-12) */
export const OVERRIDE_CLEARS: readonly GateReason[] = ['NOT_ASSESSED', 'IN_PROGRESS', 'SCOPE_EXPANDED', 'VALIDITY_LAPSED', 'OVERRIDE_EXPIRED', 'OVERRIDE_CAP_EXCEEDED']

export { riskOverridesForPayment }

// ---------- who acts ----------

/** PROCUREMENT with risk.override.request (a member) — RISK on */
async function requesterOf(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; memberId: string } | Fail> {
  const on = await requireModule(ctx, 'RISK', tx)
  if (!on.ok) return { ok: false, error: on.error }
  const may = await authorize(tx, ctx, 'risk.override.request')
  if (!may.ok) return { ok: false, error: may.error }
  if (may.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
  return { ok: true, memberId: may.data.memberId }
}

/** The DOA in effect has a RISK_OVERRIDE rule (BR-DOA-28): without one an override could only be refused at its send */
export async function overrideRuleInEffect(tx: TenantTx, now: Date): Promise<boolean> {
  const version = await tx.doaVersion.findFirst({
    where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { rules: { where: { documentType: 'RISK_OVERRIDE' }, select: { id: true } } },
  })
  return (version?.rules.length ?? 0) > 0
}

// ---------- the terms of an override ----------

interface Terms {
  readonly supplierId: string
  readonly poId: string | null
  readonly capGrossSatang: bigint
  readonly expiresOn: string
}

/**
 * The supplier (locked: one open override per supplier at a time), its flag, and the terms as of today: a cap above
 * zero, a last day from today to today + overrideMaxDays (BR-RSK-10 · GC-RSK-73 to 76), a PO of this supplier still open
 */
async function checkTerms(tx: TenantTx, ctx: Ctx, terms: Terms): Promise<{ ok: true } | Fail> {
  const [locked] = await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [terms.supplierId])
  if (!locked) return fail('NOT_FOUND', 'supplier not found')
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: terms.supplierId }, select: { status: true, registryFlag: true } })
  if (supplier.status !== 'ACTIVE') return fail('VALIDATION_FAILED', 'the supplier is not active', { field: 'supplierId', reason: 'SUPPLIER_INACTIVE' })
  // BR-RSK-12: a registry flag blocks before any override is looked at, so none is asked for
  if (supplier.registryFlag !== 'NONE') return fail('VALIDATION_FAILED', 'the supplier has a registry flag', { field: 'supplierId', reason: 'REGISTRY_BLOCKED', registryFlag: supplier.registryFlag })
  if (terms.capGrossSatang <= 0n) return fail('VALIDATION_FAILED', 'the cap is above zero', { field: 'capGross', reason: 'AMOUNT_NOT_POSITIVE' })
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const today = dateIn(ctx.now, RISK_TIMEZONE)
  const window = overrideExpiryCheck({ submittedOn: today, expiresOn: terms.expiresOn, overrideMaxDays: riskSettingsOf(org.settings).overrideMaxDays })
  if (!window.ok) return fail('VALIDATION_FAILED', 'the last day is outside what may be asked', { field: 'expiresOn', reason: window.reason })
  if (terms.poId) {
    const po = await tx.purchaseOrder.findFirst({ where: { id: terms.poId }, select: { supplierId: true, status: true } })
    if (!po) return fail('VALIDATION_FAILED', 'unknown purchase order', { field: 'poId', reason: 'UNKNOWN' })
    if (po.supplierId !== terms.supplierId) return fail('VALIDATION_FAILED', 'the purchase order is of another supplier', { field: 'poId', reason: 'PO_OTHER_SUPPLIER' })
    if ((CLOSED_PO as readonly string[]).includes(po.status)) return fail('VALIDATION_FAILED', 'the purchase order is over', { field: 'poId', reason: 'PO_NOT_OPEN' })
  }
  return { ok: true }
}

async function openOverrideOf(tx: TenantTx, supplierId: string, except?: string) {
  return tx.riskOverride.findFirst({ where: { supplierId, status: { in: [...OPEN] }, ...(except ? { id: { not: except } } : {}) }, select: { id: true, number: true } })
}

// ---------- riskOverride.request ----------

const RequestInput = z.strictObject({
  supplierId: z.uuid(),
  poId: z.uuid().nullable().optional(),
  reason: Reason,
  capGross: Baht,
  expiresOn: z.iso.date(),
})

const requestCommand = defineCommand({
  name: 'riskOverride.request',
  capability: 'risk.override.request',
  input: RequestInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ overrideId: string }>> {
    const who = await requesterOf(tx, ctx)
    if (!who.ok) return who
    const terms: Terms = { supplierId: input.supplierId, poId: input.poId ?? null, capGrossSatang: amountToSatang(input.capGross), expiresOn: input.expiresOn }
    const checked = await checkTerms(tx, ctx, terms)
    if (!checked.ok) return checked
    const open = await openOverrideOf(tx, terms.supplierId)
    if (open) return fail('RISK_OVERRIDE_OPEN', 'the supplier has an open risk override', { overrideId: open.id, number: open.number })
    if (!(await overrideRuleInEffect(tx, ctx.now))) return fail('DOA_NOT_CONFIGURED', 'the DOA in effect has no RISK_OVERRIDE rule', { documentType: 'RISK_OVERRIDE' })
    const assessment = await tx.riskAssessment.findFirst({ where: { supplierId: terms.supplierId, status: { in: [...OPEN_ASSESSMENT] } }, select: { id: true } })
    const created = await tx.riskOverride.create({
      data: {
        organizationId: ctx.organizationId,
        supplierId: terms.supplierId,
        poId: terms.poId,
        assessmentId: assessment?.id ?? null,
        reason: input.reason,
        capGrossSatang: terms.capGrossSatang,
        expiresOn: asDate(terms.expiresOn),
        requestedById: who.memberId,
      },
      select: { id: true },
    })
    return {
      ok: true,
      result: { overrideId: created.id },
      events: [
        {
          type: 'risk_override.drafted',
          aggregateType: 'RiskOverride',
          aggregateId: created.id,
          data: { supplierId: terms.supplierId, capGrossSatang: terms.capGrossSatang.toString(), expiresOn: terms.expiresOn, poId: terms.poId, assessmentId: assessment?.id ?? null },
        },
      ],
    }
  },
})

// ---------- the requester's own override ----------

const IdInput = z.strictObject({ overrideId: z.uuid(), expectedVersion: z.int().min(0) })

type OverrideRow = NonNullable<Awaited<ReturnType<typeof lockedOverride>>>
async function lockedOverride(tx: TenantTx, ctx: Ctx, id: string) {
  const [locked] = await lockRowsForUpdate(tx, 'RiskOverride', ctx.organizationId, [id])
  return locked ? tx.riskOverride.findUniqueOrThrow({ where: { id } }) : null
}

/** The override, its requester acting (FORBIDDEN for anyone else), the move allowed from its state and the version they saw */
async function ownMove(tx: TenantTx, ctx: Ctx, input: { overrideId: string; expectedVersion: number }, command: RiskOverrideCommand): Promise<{ ok: true; row: OverrideRow; to: RiskOverrideState } | Fail> {
  const who = await requesterOf(tx, ctx)
  if (!who.ok) return who
  const row = await lockedOverride(tx, ctx, input.overrideId)
  if (!row) return fail('NOT_FOUND', 'risk override not found')
  if (row.requestedById !== who.memberId) return fail('FORBIDDEN', 'only who asked for the override changes it', { reason: 'NOT_REQUESTER' })
  const moved = transition(RISK_OVERRIDE_MACHINE, row.status as RiskOverrideState, command)
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${row.status}`, { from: row.status, command })
  if (row.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the override changed since it was opened', { currentVersion: row.version })
  return { ok: true, row, to: moved.to }
}

// ---------- riskOverride.update ----------

const UpdateInput = z
  .strictObject({ overrideId: z.uuid(), expectedVersion: z.int().min(0), reason: Reason.optional(), capGross: Baht.optional(), expiresOn: z.iso.date().optional(), poId: z.uuid().nullable().optional() })
  .refine((v) => v.reason !== undefined || v.capGross !== undefined || v.expiresOn !== undefined || v.poId !== undefined, { message: 'nothing to change' })

const updateCommand = defineCommand({
  name: 'riskOverride.update',
  capability: 'risk.override.request',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ overrideId: string }>> {
    const own = await ownMove(tx, ctx, input, 'riskOverride.update')
    if (!own.ok) return own
    const { row } = own
    const terms: Terms = {
      supplierId: row.supplierId,
      poId: input.poId === undefined ? row.poId : input.poId,
      capGrossSatang: input.capGross === undefined ? row.capGrossSatang : amountToSatang(input.capGross),
      expiresOn: input.expiresOn ?? iso(row.expiresOn),
    }
    const checked = await checkTerms(tx, ctx, terms)
    if (!checked.ok) return checked
    const reason = input.reason ?? row.reason
    const fields = [
      ...(reason !== row.reason ? (['reason'] as const) : []),
      ...(terms.capGrossSatang !== row.capGrossSatang ? (['capGrossSatang'] as const) : []),
      ...(terms.expiresOn !== iso(row.expiresOn) ? (['expiresOn'] as const) : []),
      ...(terms.poId !== row.poId ? (['poId'] as const) : []),
    ]
    await tx.riskOverride.update({ where: { id: row.id }, data: { status: own.to, reason, capGrossSatang: terms.capGrossSatang, expiresOn: asDate(terms.expiresOn), poId: terms.poId, version: { increment: 1 } } })
    return { ok: true, result: { overrideId: row.id }, events: [{ type: 'risk_override.updated', aggregateType: 'RiskOverride', aggregateId: row.id, data: { fields, from: row.status as 'DRAFT' | 'RETURNED' } }] }
  },
})

// ---------- riskOverride.submit (and again after a return) ----------

/**
 * Who may not approve it (BR-SOD-15): who asked, who made the PO it names, and who filled in the supplier's assessment for
 * it — the one it was asked against, or the one open now. The adapter reads it again at deciding (facts → sodContext).
 */
export async function overrideConflicts(tx: TenantTx, row: { requestedById: string; poId: string | null; assessmentId: string | null; supplierId: string }): Promise<string[]> {
  const po = row.poId ? await tx.purchaseOrder.findFirst({ where: { id: row.poId }, select: { createdById: true } }) : null
  const assessments = await tx.riskAssessment.findMany({
    where: { OR: [...(row.assessmentId ? [{ id: row.assessmentId }] : []), { supplierId: row.supplierId, status: { in: [...OPEN_ASSESSMENT] } }] },
    select: { filledOnBehalfById: true, answers: { select: { answeredByMemberId: true } } },
  })
  const fillers = assessments.flatMap((a) => [a.filledOnBehalfById, ...a.answers.map((x) => x.answeredByMemberId)])
  return [...new Set([row.requestedById, po?.createdById ?? null, ...fillers].filter((m): m is string => typeof m === 'string'))]
}

const submitCommand = defineCommand({
  name: 'riskOverride.submit',
  capability: 'risk.override.request',
  input: IdInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ overrideId: string; number: string; routeId: string }>> {
    const own = await ownMove(tx, ctx, input, 'riskOverride.submit')
    if (!own.ok) return own
    const { row } = own
    // the terms again on the send day: the flag may have come, the day may have passed, the PO may be over
    const checked = await checkTerms(tx, ctx, { supplierId: row.supplierId, poId: row.poId, capGrossSatang: row.capGrossSatang, expiresOn: iso(row.expiresOn) })
    if (!checked.ok) return checked
    const requester = await tx.member.findUniqueOrThrow({ where: { id: row.requestedById }, select: { primaryDepartmentId: true } })
    if (!requester.primaryDepartmentId) return fail('VALIDATION_FAILED', 'the requester has no department to route in', { reason: 'NO_DEPARTMENT' })
    const assessment = await tx.riskAssessment.findFirst({ where: { supplierId: row.supplierId, status: { in: [...OPEN_ASSESSMENT] } }, select: { id: true } })
    const assessmentId = assessment?.id ?? row.assessmentId
    // the number stays with a resubmit (BR-NUM-01)
    const number = row.number ?? (await issueDocumentNumber(tx, ctx, { document: 'RO' }))
    const conflicts = await overrideConflicts(tx, { ...row, assessmentId })
    // BR-DOA-28: the cap with VAT is the amount, sent with VAT 0 so every basis reads the same; no rule → DOA_NOT_CONFIGURED
    const route = await startRoute(
      tx,
      ctx,
      { type: 'RISK_OVERRIDE', id: row.id, label: number, number },
      { documentType: 'RISK_OVERRIDE', amount: { netSatang: row.capGrossSatang, vatSatang: 0n }, requesterMemberId: row.requestedById, chargedDepartmentId: requester.primaryDepartmentId, conflictMemberIds: conflicts, at: ctx.now },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.riskOverride.update({ where: { id: row.id }, data: { status: own.to, number, assessmentId, submittedAt: ctx.now, decidedAt: null, currentRouteId: route.data.routeId, version: { increment: 1 } } })
    return {
      ok: true,
      result: { overrideId: row.id, number, routeId: route.data.routeId },
      events: [
        {
          type: 'risk_override.submitted',
          aggregateType: 'RiskOverride',
          aggregateId: row.id,
          data: { number, capGrossSatang: row.capGrossSatang.toString(), expiresOn: iso(row.expiresOn), poId: row.poId, assessmentId, routeId: route.data.routeId, resubmitted: row.status === 'RETURNED' },
        },
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

// ---------- riskOverride.cancel ----------

const cancelCommand = defineCommand({
  name: 'riskOverride.cancel',
  capability: 'risk.override.request',
  input: IdInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ overrideId: string }>> {
    const own = await ownMove(tx, ctx, input, 'riskOverride.cancel')
    if (!own.ok) return own
    await tx.riskOverride.update({ where: { id: own.row.id }, data: { status: own.to, version: { increment: 1 } } })
    return { ok: true, result: { overrideId: own.row.id }, events: [{ type: 'risk_override.cancelled', aggregateType: 'RiskOverride', aggregateId: own.row.id, data: { from: own.row.status as 'DRAFT' | 'RETURNED' } }] }
  },
})

export const requestRiskOverride = (ctx: Ctx, input: z.input<typeof RequestInput>, options: RunOptions) => runCommand(ctx, requestCommand, input, options)
export const updateRiskOverride = (ctx: Ctx, input: z.input<typeof UpdateInput>, options: RunOptions) => runCommand(ctx, updateCommand, input, options)
export const submitRiskOverride = (ctx: Ctx, input: z.input<typeof IdInput>, options: RunOptions) => runCommand(ctx, submitCommand, input, options)
export const cancelRiskOverride = (ctx: Ctx, input: z.input<typeof IdInput>, options: RunOptions) => runCommand(ctx, cancelCommand, input, options)

// ---------- what the route came to (the RISK_OVERRIDE subject adapter) ----------

type Decided = { ok: true; documentStatus: string; events: EventDraft[]; notifications: NotificationDraft[] } | Fail

const decidedNotice = (row: { id: string; number: string | null; requestedById: string; expiresOn: Date }, outcome: 'APPROVED' | 'REJECTED' | 'RETURNED', at: Date): NotificationDraft => ({
  recipientMemberId: row.requestedById,
  templateKey: 'risk.override_decided',
  data: { overrideId: row.id, number: row.number, outcome, expiresOn: iso(row.expiresOn) },
  urgency: 'DIGEST',
  dedupeKey: `risk.override_decided:${row.id}:${outcome}:${at.toISOString()}`,
  subjectType: 'RISK_OVERRIDE',
  subjectId: row.id,
})

/**
 * The route's result, inside decide's transaction (ADR-068): the last step approved → APPROVED (the gate may now let POs
 * out under it); a step rejected → REJECTED; returned → RETURNED, its requester edits and sends it again on a new route.
 * Only the override waiting for this very route moves; anything else is refused and the task stays open.
 */
export async function decideRiskOverride(tx: TenantTx, ctx: Ctx, overrideId: string, routeId: string, outcome: 'APPROVED' | 'REJECTED' | 'RETURNED', reasonCommentId: string | null): Promise<Decided> {
  const row = await lockedOverride(tx, ctx, overrideId)
  if (!row) return fail('VALIDATION_FAILED', 'no risk override for this task', { reason: 'SUBJECT' })
  if (row.status !== 'PENDING_APPROVAL' || row.currentRouteId !== routeId) return fail('INVALID_STATE_TRANSITION', 'the override is not waiting for this route', { status: row.status })
  const command: RiskOverrideCommand = outcome === 'APPROVED' ? 'riskOverride.final_approval' : outcome === 'REJECTED' ? 'approval.reject' : 'approval.return'
  const moved = transition(RISK_OVERRIDE_MACHINE, row.status as RiskOverrideState, command)
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${row.status}`, { from: row.status, command })
  const number = row.number!
  await tx.riskOverride.update({
    where: { id: row.id },
    data: { status: moved.to, ...(outcome === 'RETURNED' ? { currentRouteId: null } : { decidedAt: ctx.now }), version: { increment: 1 } },
  })
  const event: EventDraft =
    outcome === 'APPROVED'
      ? { type: 'risk_override.approved', aggregateType: 'RiskOverride', aggregateId: row.id, data: { number, capGrossSatang: row.capGrossSatang.toString(), expiresOn: iso(row.expiresOn) } }
      : { type: outcome === 'REJECTED' ? 'risk_override.rejected' : 'risk_override.returned', aggregateType: 'RiskOverride', aggregateId: row.id, data: { number, reasonCommentId } }
  return { ok: true, documentStatus: moved.to, events: [event], notifications: [decidedNotice(row, outcome, ctx.now)] }
}

// ---------- what the screens read ----------

const TIER_RANK: Readonly<Record<RiskTierCode, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2 }

export type OverrideAssessmentState =
  | { readonly state: 'NONE' }
  | { readonly state: 'IN_PROGRESS'; readonly id: string; readonly number: string | null; readonly answered: number; readonly total: number }
  | { readonly state: 'CURRENT' | 'OVERDUE'; readonly id: string; readonly number: string | null; readonly validUntil: string }

export interface RiskOverrideView {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly version: number
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly individual: boolean; readonly registryFlag: 'NONE' | 'CEASED' | 'VAT_CANCELLED' | 'NOT_FOUND' }
  readonly po: { readonly id: string; readonly number: string | null; readonly grossSatang: bigint } | null
  readonly reason: string
  readonly capGrossSatang: bigint
  readonly expiresOn: string
  readonly usedCount: number
  readonly usedGrossSatang: bigint
  readonly requestedBy: { readonly id: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly createdAt: Date
  readonly submittedAt: Date | null
  readonly decidedAt: Date | null
  /** The higher of the tier from the screening (of the PO, or of the open assessment) and the supplier's assessed tier */
  readonly tier: RiskTierCode | null
  readonly tierSource: 'SCREENING' | 'ASSESSMENT' | null
  readonly assessment: OverrideAssessmentState
  /** The DOA route now: the rule and who holds the open task */
  readonly route: { readonly ruleCode: string; readonly openTaskId: string | null; readonly approver: { readonly nameTh: string; readonly nameEn: string | null } | null } | null
  /** The approver's words on the last return or rejection */
  readonly lastDecision: { readonly outcome: 'RETURNED' | 'REJECTED'; readonly reason: string | null } | null
  /** The POs it lets out and what of the cap each holds */
  readonly posUsing: readonly { readonly id: string; readonly number: string | null; readonly countedGrossSatang: bigint }[]
  /** The reader asked for it and may still change it (DRAFT, RETURNED) */
  readonly canEdit: boolean
  /** The last day the requester may set when sending it today (today + overrideMaxDays) */
  readonly lastAllowed: string
  readonly today: string
}

/** Who reads an override: whoever reads the risk files (risk.assessment.view ORG), and whoever has or had a task on its routes */
async function mayRead(tx: TenantTx, ctx: Ctx, overrideId: string): Promise<boolean> {
  if ((await authorize(tx, ctx, 'risk.assessment.view')).ok) return true
  if (ctx.actor.type !== 'USER') return false
  const me = ctx.actor.memberId
  const tasks = await tx.approvalTask.count({ where: { step: { route: { subjectType: 'RISK_OVERRIDE', subjectId: overrideId } }, OR: [{ assigneeMemberId: me }, { principalMemberId: me }] } })
  return tasks > 0
}

async function assessmentStateOf(tx: TenantTx, supplierId: string, today: string): Promise<{ state: OverrideAssessmentState; inherentTier: RiskTierCode | null }> {
  const open = await tx.riskAssessment.findFirst({ where: { supplierId, status: { in: [...OPEN_ASSESSMENT] } }, select: { id: true } })
  if (open) {
    const a = (await loadAssessment(tx, open.id))!
    const set = questionsOf(a)
    const codes = new Set(set.map((q) => q.code))
    const answered = a.answers.filter((x) => codes.has(x.questionCode)).length
    return { state: { state: 'IN_PROGRESS', id: a.id, number: a.number, answered, total: set.length }, inherentTier: a.inherentTier as RiskTierCode }
  }
  const done = await tx.riskAssessment.findFirst({ where: { supplierId, status: 'COMPLETED' }, select: { id: true, number: true, validUntil: true, inherentTier: true } })
  if (done?.validUntil) return { state: { state: iso(done.validUntil) >= today ? 'CURRENT' : 'OVERDUE', id: done.id, number: done.number, validUntil: iso(done.validUntil) }, inherentTier: null }
  return { state: { state: 'NONE' }, inherentTier: null }
}

/** /risk/overrides/[id], the approval task's facts on the web, LIFF and the app (FR-RSK-203 AC2 · BR-RSK-11) */
export async function riskOverrideView(ctx: Ctx, overrideId: string): Promise<Result<RiskOverrideView>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return on
    if (!(await mayRead(tx, ctx, overrideId))) return fail('FORBIDDEN', 'not allowed to read this override')
    const row = await tx.riskOverride.findFirst({
      where: { id: overrideId },
      include: {
        supplier: { select: { id: true, code: true, nameTh: true, nameEn: true, payeeType: true, registryFlag: true, riskTier: true } },
        po: { select: { id: true, number: true, grossSatang: true } },
        requestedBy: { select: { id: true, displayNameTh: true, displayNameEn: true } },
        posUsing: { select: { id: true, number: true, riskGate: true }, orderBy: { createdAt: 'asc' } },
      },
    })
    if (!row) return fail('NOT_FOUND', 'risk override not found')
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const today = dateIn(ctx.now, RISK_TIMEZONE)

    // the tier and where it comes from: the PO's screening (or the open assessment's), against the supplier's assessed tier
    const { state, inherentTier } = await assessmentStateOf(tx, row.supplierId, today)
    let screeningTier = inherentTier
    if (row.po) {
      const e = await evaluatePoGate(tx, ctx, row.po.id, row.po.grossSatang, 'SUBMIT')
      if (e.ok) screeningTier = screeningTier ? maxTier(screeningTier, e.data.inherentTier) : e.data.inherentTier
    }
    const assessed = (row.supplier.riskTier as RiskTierCode | null) ?? null
    const tier = screeningTier && assessed ? maxTier(screeningTier, assessed) : (screeningTier ?? assessed)
    const tierSource = tier === null ? null : assessed !== null && TIER_RANK[assessed] >= TIER_RANK[screeningTier ?? 'LOW'] ? 'ASSESSMENT' : 'SCREENING'

    const routeRow = row.currentRouteId ? await tx.approvalRoute.findFirst({ where: { id: row.currentRouteId }, select: { ruleCode: true } }) : null
    const openTask = row.currentRouteId
      ? await tx.approvalTask.findFirst({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { routeId: row.currentRouteId } }, select: { id: true, assignee: { select: { displayNameTh: true, displayNameEn: true } } } })
      : null
    const last = await tx.event.findFirst({ where: { aggregateType: 'RiskOverride', aggregateId: row.id, type: { in: ['risk_override.returned', 'risk_override.rejected'] } }, orderBy: { seq: 'desc' }, select: { type: true, data: true } })
    const commentId = (last?.data as { reasonCommentId?: string | null } | null)?.reasonCommentId ?? null
    const comment = commentId ? await tx.comment.findFirst({ where: { id: commentId }, select: { body: true } }) : null
    const mine = ctx.actor.type === 'USER' && ctx.actor.memberId === row.requestedById
    const may = mine ? (await authorize(tx, ctx, 'risk.override.request')).ok : false
    return {
      ok: true,
      data: {
        id: row.id,
        number: row.number,
        status: row.status,
        version: row.version,
        supplier: { id: row.supplier.id, code: row.supplier.code, nameTh: row.supplier.nameTh, nameEn: row.supplier.nameEn, individual: row.supplier.payeeType === 'INDIVIDUAL', registryFlag: row.supplier.registryFlag },
        po: row.po ? { id: row.po.id, number: row.po.number, grossSatang: row.po.grossSatang } : null,
        reason: row.reason,
        capGrossSatang: row.capGrossSatang,
        expiresOn: iso(row.expiresOn),
        usedCount: row.usedCount,
        usedGrossSatang: row.usedGrossSatang,
        requestedBy: { id: row.requestedBy.id, nameTh: row.requestedBy.displayNameTh, nameEn: row.requestedBy.displayNameEn },
        createdAt: row.createdAt,
        submittedAt: row.submittedAt,
        decidedAt: row.decidedAt,
        tier,
        tierSource,
        assessment: state,
        route: routeRow ? { ruleCode: routeRow.ruleCode, openTaskId: openTask?.id ?? null, approver: openTask ? { nameTh: openTask.assignee.displayNameTh, nameEn: openTask.assignee.displayNameEn } : null } : null,
        lastDecision: last && (row.status === 'RETURNED' || row.status === 'REJECTED') ? { outcome: last.type === 'risk_override.returned' ? 'RETURNED' : 'REJECTED', reason: comment?.body ?? null } : null,
        posUsing: row.posUsing.map((p) => ({ id: p.id, number: p.number, countedGrossSatang: BigInt(storedRiskGate(p.riskGate)?.countedGrossSatang ?? '0') })),
        canEdit: may && (row.status === 'DRAFT' || row.status === 'RETURNED'),
        lastAllowed: overrideWindow({ submittedOn: today, overrideMaxDays: riskSettingsOf(org.settings).overrideMaxDays }).lastAllowed,
        today,
      },
    }
  })
}

export interface RiskOverrideListItem {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly supplier: { readonly code: string; readonly nameTh: string }
  /** The PO it names (its number null while a draft); null = every PO of the supplier */
  readonly po: { readonly number: string | null } | null
  readonly capGrossSatang: bigint
  readonly usedGrossSatang: bigint
  readonly expiresOn: string
  readonly requestedBy: { readonly nameTh: string; readonly nameEn: string | null }
  readonly createdAt: Date
}

export type OverrideListFilter = 'OPEN' | 'APPROVED' | 'CLOSED' | 'ALL'
const FILTER_STATUSES: Readonly<Record<OverrideListFilter, readonly RiskOverrideState[] | null>> = {
  OPEN: OPEN,
  APPROVED: ['APPROVED'],
  CLOSED: ['REJECTED', 'CANCELLED', 'EXPIRED'],
  ALL: null,
}

/** /risk/overrides: the organization's overrides, newest first, for whoever reads the risk files (risk.assessment.view) */
export async function listRiskOverrides(ctx: Ctx, filter: OverrideListFilter = 'ALL'): Promise<Result<{ readonly items: readonly RiskOverrideListItem[]; readonly canRequest: boolean }>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return on
    const may = await authorize(tx, ctx, 'risk.assessment.view')
    if (!may.ok) return may
    const statuses = FILTER_STATUSES[filter]
    const rows = await tx.riskOverride.findMany({
      where: statuses ? { status: { in: [...statuses] } } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 200,
      select: {
        id: true,
        number: true,
        status: true,
        capGrossSatang: true,
        usedGrossSatang: true,
        expiresOn: true,
        createdAt: true,
        supplier: { select: { code: true, nameTh: true } },
        po: { select: { number: true } },
        requestedBy: { select: { displayNameTh: true, displayNameEn: true } },
      },
    })
    const canRequest = (await authorize(tx, ctx, 'risk.override.request')).ok && (await overrideRuleInEffect(tx, ctx.now))
    return {
      ok: true,
      data: {
        items: rows.map((r) => ({
          id: r.id,
          number: r.number,
          status: r.status,
          supplier: r.supplier,
          po: r.po ? { number: r.po.number } : null,
          capGrossSatang: r.capGrossSatang,
          usedGrossSatang: r.usedGrossSatang,
          expiresOn: iso(r.expiresOn),
          requestedBy: { nameTh: r.requestedBy.displayNameTh, nameEn: r.requestedBy.displayNameEn },
          createdAt: r.createdAt,
        })),
        canRequest,
      },
    }
  })
}

export interface RiskOverrideForm {
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string }
  readonly po: { readonly id: string; readonly number: string | null; readonly grossSatang: bigint } | null
  readonly today: string
  readonly lastAllowed: string
  /** The open override of the supplier, which the form points to instead of asking for a second one */
  readonly open: { readonly id: string; readonly number: string | null } | null
}

/**
 * The form "ขออนุมัติข้าม" for a supplier (and a PO of it): who may ask (risk.override.request, the DOA has a rule —
 * DOA_NOT_CONFIGURED otherwise, FR-RSK-203 AC2), the supplier and its PO, and the window of last days
 */
export async function riskOverrideForm(ctx: Ctx, input: { readonly supplierId?: string; readonly poId?: string }): Promise<Result<RiskOverrideForm>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await requesterOf(tx, ctx)
    if (!who.ok) return who
    if (!(await overrideRuleInEffect(tx, ctx.now))) return fail('DOA_NOT_CONFIGURED', 'the DOA in effect has no RISK_OVERRIDE rule', { documentType: 'RISK_OVERRIDE' })
    const po = input.poId ? await tx.purchaseOrder.findFirst({ where: { id: input.poId }, select: { id: true, number: true, grossSatang: true, supplierId: true } }) : null
    if (input.poId && !po) return fail('NOT_FOUND', 'purchase order not found')
    const supplierId = po?.supplierId ?? input.supplierId
    if (!supplierId) return fail('VALIDATION_FAILED', 'a supplier or a purchase order is needed', { field: 'supplierId', reason: 'REQUIRED' })
    const supplier = await tx.supplier.findFirst({ where: { id: supplierId }, select: { id: true, code: true, nameTh: true, registryFlag: true } })
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    if (supplier.registryFlag !== 'NONE') return fail('VALIDATION_FAILED', 'the supplier has a registry flag', { field: 'supplierId', reason: 'REGISTRY_BLOCKED', registryFlag: supplier.registryFlag })
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const today = dateIn(ctx.now, RISK_TIMEZONE)
    return {
      ok: true,
      data: {
        supplier: { id: supplier.id, code: supplier.code, nameTh: supplier.nameTh },
        po: po ? { id: po.id, number: po.number, grossSatang: po.grossSatang } : null,
        today,
        lastAllowed: overrideWindow({ submittedOn: today, overrideMaxDays: riskSettingsOf(org.settings).overrideMaxDays }).lastAllowed,
        open: await openOverrideOf(tx, supplier.id),
      },
    }
  })
}

/** The PO band's buttons (FR-RSK-203 AC6): the supplier's open override, and whether the reader may ask for one now */
export async function overrideOptionsForPo(tx: TenantTx, ctx: Ctx, supplierId: string): Promise<{ readonly open: { readonly id: string; readonly number: string | null } | null; readonly canRequest: boolean }> {
  const open = await openOverrideOf(tx, supplierId)
  const supplier = await tx.supplier.findFirst({ where: { id: supplierId }, select: { registryFlag: true, status: true } })
  const may = (await authorize(tx, ctx, 'risk.override.request')).ok
  const canRequest = !open && may && supplier?.registryFlag === 'NONE' && supplier.status === 'ACTIVE' && (await overrideRuleInEffect(tx, ctx.now))
  return { open, canRequest }
}

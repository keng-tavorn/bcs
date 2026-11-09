import { inherentTier, maxTier, poGate, REASON_WARNINGS, screeningCovers, SCREENING_FIELDS, type GateAssessment, type GateWarning, type PoGateResult, type PoGateTrigger, type RegistryFlag, type RiskTierCode, type Screening } from '@/core/risk'
import type { AppError, Result } from '@/core/result'
import { dateIn } from '@/core/supplier-docs'
import { authorize, scopesFor } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { isActivePlatformAdmin } from '@/server/db/lookups'
import { lockRowsForShare, lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { requireModule } from '../modules'
import { mergeScreening, RISK_TIMEZONE } from './screening'
import { riskPolicyInEffect, riskTiersInEffect } from './tiers'

// The gate before a PO goes out (S11-07 · FR-RSK-203 · BR-RSK-09 BR-RSK-12 · ADR-225 · INV-RSK-01): po.submit, po.send and
// a PO change call assertSupplierClearForPo inside their own transaction. With RISK off it does nothing. With RISK on it
// gathers what poGate reads — the PO's screening (the requests behind its lines) and categories, the supplier's tier,
// registry flag and assessment, the overrides that speak for the PO — and either refuses the command or writes the gate
// the PO passed (PurchaseOrder.riskGate, its event) and what an override lets out (once per PO, its share of the cap).

const OPEN_ASSESSMENT = ['DRAFT', 'IN_REVIEW', 'RETURNED'] as const
const iso = (d: Date) => d.toISOString().slice(0, 10)
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** PurchaseOrder.riskGate: the gate the PO passed last (BR-RSK-09 · INV-RSK-01 · read by G-9 and the PO's approvers) */
export interface StoredRiskGate {
  readonly tier: RiskTierCode
  readonly source: 'NOT_REQUIRED' | 'ASSESSMENT' | 'OVERRIDE'
  readonly trigger: PoGateTrigger
  readonly assessmentId: string | null
  readonly overrideId: string | null
  /** ISO time of ctx.now */
  readonly at: string
  readonly warnings: readonly GateWarning[]
  /** What of this PO the override holds in usedGrossSatang, in satang as text (source OVERRIDE) */
  readonly countedGrossSatang?: string
  /** The reason given for the warnings that need one (BR-SUP-04): a comment on the PO, or the PO change's own reason */
  readonly reasonCommentId?: string
  readonly reasonPoChangeId?: string
  readonly reasonFor?: readonly GateWarning[]
}

export function storedRiskGate(value: unknown): StoredRiskGate | null {
  if (!value || typeof value !== 'object') return null
  const g = value as Partial<StoredRiskGate>
  return typeof g.tier === 'string' && typeof g.source === 'string' ? (value as StoredRiskGate) : null
}

interface OverrideRow {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly poId: string | null
  readonly expiresOn: Date
  readonly capGrossSatang: bigint
  readonly usedGrossSatang: bigint
}

/** What the gate weighed: the decision and what it rests on (for the command, the PO page and the module dry-run) */
export interface PoGateEvaluation {
  readonly decision: PoGateResult
  readonly tier: RiskTierCode
  readonly inherentTier: RiskTierCode
  readonly assessment: GateAssessment
  readonly assessmentId: string | null
  /** The override it passed with (source OVERRIDE), or the one it was refused on (OVERRIDE_EXPIRED · OVERRIDE_CAP_EXCEEDED) */
  readonly override: OverrideRow | null
  readonly supplierId: string
  readonly prior: StoredRiskGate | null
  readonly boundOverrideId: string | null
}

const OVERRIDE_STATUSES: ('APPROVED' | 'EXPIRED')[] = ['APPROVED', 'EXPIRED']

/**
 * BR-RSK-19: inside the command's transaction, before the gate is weighed — the supplier's COMPLETED assessment FOR SHARE
 * (a reassessment that would supersede it waits for the PO) and the overrides that speak for the PO FOR UPDATE when the
 * command writes their use, FOR SHARE when it only checks.
 */
async function holdGateRows(tx: TenantTx, ctx: Ctx, poId: string, write: boolean): Promise<readonly string[]> {
  const po = await tx.purchaseOrder.findFirst({ where: { id: poId }, select: { supplierId: true, riskOverrideId: true } })
  if (!po) return []
  const completed = await tx.riskAssessment.findFirst({ where: { supplierId: po.supplierId, status: 'COMPLETED' }, select: { id: true } })
  if (completed) await lockRowsForShare(tx, 'RiskAssessment', ctx.organizationId, [completed.id])
  const listed = await tx.riskOverride.findMany({ where: { supplierId: po.supplierId, status: { in: OVERRIDE_STATUSES }, OR: [{ poId: null }, { poId }] }, select: { id: true } })
  const ids = [...listed.map((o) => o.id), ...(po.riskOverrideId ? [po.riskOverrideId] : [])]
  return write ? lockRowsForUpdate(tx, 'RiskOverride', ctx.organizationId, ids) : lockRowsForShare(tx, 'RiskOverride', ctx.organizationId, ids)
}

/**
 * Weighs the gate of a PO at `grossSatang` on ctx.now, RISK on, reading only: the tier is the higher of the PO's inherent
 * tier (BR-RSK-03 on the screening of the requests behind its lines and its line categories) and the supplier's; an
 * override the PO already draws on is tried first, then the others by the latest last day. The command holds the rows
 * first (holdGateRows) and weighs only the overrides it holds (`heldOverrideIds`: one approved meanwhile waits for the
 * next command); a screen reads them as they stand.
 */
export async function evaluatePoGate(tx: TenantTx, ctx: Ctx, poId: string, grossSatang: bigint, trigger: PoGateTrigger, heldOverrideIds?: readonly string[]): Promise<Result<PoGateEvaluation>> {
  const tiers = await riskTiersInEffect(tx)
  if (!tiers.ok) return tiers
  const policy = await riskPolicyInEffect(tx)
  if (!policy.ok) return policy
  const po = await tx.purchaseOrder.findFirst({
    where: { id: poId },
    select: {
      supplierId: true,
      riskGate: true,
      riskOverrideId: true,
      lines: { select: { categoryCode: true, sources: { select: { requestLine: { select: { request: { select: { formData: true } } } } } } } },
      supplier: { select: { riskTier: true, registryFlag: true, registryFlaggedAt: true } },
    },
  })
  if (!po) return fail('NOT_FOUND', 'purchase order not found')
  const prior = storedRiskGate(po.riskGate)

  // the work of the PO: every request behind its lines (Y wins) and its line categories
  const merged = mergeScreening(po.lines.flatMap((l) => l.sources.map((s) => s.requestLine.request.formData)))
  const screening = Object.fromEntries(SCREENING_FIELDS.map((f) => [f, merged[f] ?? 'N'])) as Screening
  const categoryCodes = [...new Set(po.lines.map((l) => l.categoryCode).filter((c): c is string => Boolean(c)))]
  const inherent = inherentTier({ screening, categoryCodes }, policy.data)
  const tier = maxTier(inherent, (po.supplier.riskTier as RiskTierCode | null) ?? 'LOW')

  const current = await tx.riskAssessment.findFirst({ where: { supplierId: po.supplierId, status: 'COMPLETED' }, select: { id: true, completedAt: true, validUntil: true, screening: true, categoryCodes: true } })
  const open = current ? 0 : await tx.riskAssessment.count({ where: { supplierId: po.supplierId, status: { in: [...OPEN_ASSESSMENT] } } })
  const today = dateIn(ctx.now, RISK_TIMEZONE)
  const assessment: GateAssessment = current?.validUntil ? (iso(current.validUntil) >= today ? 'CURRENT' : 'OVERDUE') : open > 0 ? 'IN_PROGRESS' : 'NONE'
  const covered = current ? screeningCovers({ screening: current.screening as Record<string, 'Y' | 'N'>, categoryCodes: current.categoryCodes }, { screening, categoryCodes }, policy.data.highRiskCategories) : false
  const flaggedAt = po.supplier.registryFlaggedAt
  const assessedAfterFlag = Boolean(current?.completedAt && flaggedAt && current.completedAt.getTime() > flaggedAt.getTime())

  const rows: OverrideRow[] = await tx.riskOverride.findMany({
    where: { supplierId: po.supplierId, status: { in: OVERRIDE_STATUSES }, OR: [{ poId: null }, { poId }], ...(heldOverrideIds ? { id: { in: [...heldOverrideIds] } } : {}) },
    orderBy: [{ expiresOn: 'desc' }, { id: 'asc' }],
    select: { id: true, number: true, status: true, poId: true, expiresOn: true, capGrossSatang: true, usedGrossSatang: true },
  })
  const candidates = [...rows.filter((o) => o.id === po.riskOverrideId), ...rows.filter((o) => o.id !== po.riskOverrideId)]
  const counted = prior?.countedGrossSatang !== undefined ? BigInt(prior.countedGrossSatang) : 0n

  const weigh = (o: OverrideRow | null) =>
    poGate({
      tier,
      tiers: tiers.data,
      policy: policy.data,
      registryFlag: po.supplier.registryFlag as RegistryFlag,
      assessedAfterFlag,
      assessment,
      screeningCovered: covered,
      override: o ? { status: o.status, poId: o.poId, expiresOn: iso(o.expiresOn), capGrossSatang: o.capGrossSatang, usedGrossSatang: o.usedGrossSatang } : null,
      poId,
      poDate: today,
      grossSatang,
      // what of this PO the override holds already: its share when the PO draws on it, nothing when it is new to it
      countedGrossSatang: o && o.id === po.riskOverrideId ? counted : 0n,
      trigger,
    })
  let decision = weigh(candidates[0] ?? null)
  let chosen = candidates[0] ?? null
  for (const o of candidates) {
    const d = weigh(o)
    if (d.allowed) {
      decision = d
      chosen = o
      break
    }
  }
  const refusedOnOverride = !decision.allowed && (decision.reason === 'OVERRIDE_EXPIRED' || decision.reason === 'OVERRIDE_CAP_EXCEEDED')
  return {
    ok: true,
    data: {
      decision,
      tier,
      inherentTier: inherent,
      assessment,
      assessmentId: current?.id ?? null,
      override: (decision.allowed && decision.source === 'OVERRIDE') || refusedOnOverride ? chosen : null,
      supplierId: po.supplierId,
      prior,
      boundOverrideId: po.riskOverrideId,
    },
  }
}

export interface PoGateCall {
  readonly poId: string
  readonly trigger: PoGateTrigger
  /** The gross the PO goes out with: its new totals at po.submit, its own at po.send, the change's at a PO change */
  readonly grossSatang: bigint
  /** Given when the gate warns of something that needs a reason on the PO (BR-SUP-04 · `requiresReason`) */
  readonly reason?: string | null
  /** A PO change: its own reason answers a warning that needs one */
  readonly poChangeId?: string
  /** po_change.submit before its approvals: refuses as the final step would, writes nothing */
  readonly checkOnly?: boolean
}

export type PoGateOutcome = { readonly ok: true; readonly events: EventDraft[]; readonly notifications: NotificationDraft[] } | { readonly ok: false; readonly error: AppError }

const NOTHING: PoGateOutcome = { ok: true, events: [], notifications: [] }

/** The gate's refusal: the code of BR-RSK-09 with its reason, the tier and what it rests on (no amount of the cap) */
function refusal(e: PoGateEvaluation & { decision: Extract<PoGateResult, { allowed: false }> }, poId: string): PoGateOutcome {
  const message = e.decision.error === 'RISK_BLOCKED' ? 'the supplier is blocked from new purchase orders' : 'the supplier needs a risk assessment before this purchase order goes out'
  return fail(e.decision.error, message, { reason: e.decision.reason, tier: e.tier, supplierId: e.supplierId, poId, assessmentId: e.assessmentId, overrideId: e.override?.id ?? null })
}

/**
 * BR-RSK-09 at po.submit, po.send and a PO change (FR-RSK-203 AC1): RISK off → nothing. RISK on → the gate refuses with
 * RISK_ASSESSMENT_REQUIRED, RISK_REASSESSMENT_REQUIRED or RISK_BLOCKED, or asks a reason for a warning that needs one
 * (VALIDATION_FAILED field riskReason), or passes: PurchaseOrder.riskGate and riskOverrideId written, po.risk_gate_passed,
 * and an override's use counted once per PO (risk_override.used) with its share moved by the PO's new gross.
 */
export async function assertSupplierClearForPo(tx: TenantTx, ctx: Ctx, call: PoGateCall): Promise<PoGateOutcome> {
  if (!(await requireModule(ctx, 'RISK', tx)).ok) return NOTHING
  const held = await holdGateRows(tx, ctx, call.poId, !call.checkOnly)
  const evaluated = await evaluatePoGate(tx, ctx, call.poId, call.grossSatang, call.trigger, held)
  if (!evaluated.ok) return evaluated
  const e = evaluated.data
  if (!e.decision.allowed) return refusal({ ...e, decision: e.decision }, call.poId)
  const { source, warnings } = e.decision

  // BR-SUP-04: a warning that needs a reason has one — given now, the PO change's own, or the PO's earlier one for it
  const needed = warnings.filter((w) => REASON_WARNINGS.includes(w))
  let reason: Pick<StoredRiskGate, 'reasonCommentId' | 'reasonPoChangeId' | 'reasonFor'> = {}
  if (needed.length > 0) {
    const given = call.reason?.trim()
    if (given) reason = { reasonFor: needed }
    else if (call.poChangeId) reason = { reasonPoChangeId: call.poChangeId, reasonFor: needed }
    else if (e.prior && reasonCovered(e.prior, needed)) {
      reason = { ...(e.prior.reasonCommentId ? { reasonCommentId: e.prior.reasonCommentId } : { reasonPoChangeId: e.prior.reasonPoChangeId! }), reasonFor: e.prior.reasonFor! }
    } else return fail('VALIDATION_FAILED', 'a reason is needed to order from this supplier', { field: 'riskReason', reason: 'RISK_REASON_REQUIRED', warnings: needed })
    if (given && !call.checkOnly) {
      const comment = await tx.comment.create({
        data: { organizationId: ctx.organizationId, subjectType: 'PurchaseOrder', subjectId: call.poId, authorMemberId: ctx.actor.type === 'USER' ? ctx.actor.memberId : null, body: given },
        select: { id: true },
      })
      reason = { ...reason, reasonCommentId: comment.id }
    }
  }
  if (call.checkOnly) return NOTHING

  // the override's share of the cap: this PO counted once, its share moved with its gross, released when it no longer draws
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  const drawsOn = source === 'OVERRIDE' ? e.override! : null
  const share = e.prior?.countedGrossSatang !== undefined ? BigInt(e.prior.countedGrossSatang) : 0n
  if (e.boundOverrideId && e.boundOverrideId !== drawsOn?.id) {
    await tx.riskOverride.update({ where: { id: e.boundOverrideId }, data: { usedGrossSatang: { decrement: share }, usedCount: { decrement: 1 }, version: { increment: 1 } } })
    events.push({ type: 'risk_override.released', aggregateType: 'RiskOverride', aggregateId: e.boundOverrideId, data: { poId: call.poId, grossSatang: share.toString(), trigger: call.trigger } })
  }
  if (drawsOn) {
    const first = e.boundOverrideId !== drawsOn.id
    const delta = first ? call.grossSatang : call.grossSatang - share
    await tx.riskOverride.update({ where: { id: drawsOn.id }, data: { usedGrossSatang: { increment: delta }, ...(first ? { usedCount: { increment: 1 } } : {}), version: { increment: 1 } } })
    if (first) events.push({ type: 'risk_override.used', aggregateType: 'RiskOverride', aggregateId: drawsOn.id, data: { poId: call.poId, grossSatang: call.grossSatang.toString(), trigger: call.trigger } })
  }

  const gate: StoredRiskGate = {
    tier: e.tier,
    source,
    trigger: call.trigger,
    assessmentId: source === 'ASSESSMENT' ? e.assessmentId : null,
    overrideId: drawsOn?.id ?? null,
    at: ctx.now.toISOString(),
    warnings,
    ...(drawsOn ? { countedGrossSatang: call.grossSatang.toString() } : {}),
    ...reason,
  }
  await tx.purchaseOrder.update({ where: { id: call.poId }, data: { riskGate: JSON.parse(JSON.stringify(gate)) as Record<string, string>, riskOverrideId: drawsOn?.id ?? null } })
  events.push({
    type: 'po.risk_gate_passed',
    aggregateType: 'PurchaseOrder',
    aggregateId: call.poId,
    data: { tier: e.tier, inherentTier: e.inherentTier, source, trigger: call.trigger, assessmentId: gate.assessmentId, overrideId: gate.overrideId, warnings: [...warnings], grossSatang: call.grossSatang.toString(), reasonCommentId: gate.reasonCommentId ?? null },
  })

  // FR-RSK-203 AC6 · BR-NOTI-12: AUDITOR hears of every PO an override lets out, in the daily digest
  if (drawsOn) {
    const auditors = await tx.roleAssignment.findMany({ where: { role: 'AUDITOR', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
    for (const memberId of new Set(auditors.map((a) => a.memberId))) {
      notifications.push({
        recipientMemberId: memberId,
        templateKey: 'risk.override_used',
        data: { poId: call.poId, overrideId: drawsOn.id, number: drawsOn.number, trigger: call.trigger },
        urgency: 'DIGEST',
        dedupeKey: `risk.override_used:${drawsOn.id}:${call.poId}:${memberId}`,
        subjectType: 'PURCHASE_ORDER',
        subjectId: call.poId,
      })
    }
  }
  return { ok: true, events, notifications }
}

// ---------- what the screens read (FR-RSK-203 AC6): nothing here writes ----------

/** Whether an earlier reason of the PO answers the warnings that need one now */
function reasonCovered(prior: StoredRiskGate | null, needed: readonly GateWarning[]): boolean {
  return Boolean(prior?.reasonFor && (prior.reasonCommentId || prior.reasonPoChangeId) && needed.every((w) => prior.reasonFor!.includes(w)))
}

/** The gate a PO meets next: its submit while a DRAFT, its first sending while APPROVED and not yet out; else none */
function nextTrigger(po: { status: string; sentAt: Date | null }): 'SUBMIT' | 'SEND' | null {
  if (po.status === 'DRAFT') return 'SUBMIT'
  if (po.status === 'APPROVED' && po.sentAt === null) return 'SEND'
  return null
}

const OPEN_FOR_ASSESSMENT: readonly string[] = ['NOT_ASSESSED', 'SCOPE_EXPANDED', 'VALIDITY_LAPSED', 'REGISTRY_FLAGGED', 'OVERRIDE_EXPIRED', 'OVERRIDE_CAP_EXCEEDED']

export interface PoRiskStatus {
  readonly trigger: 'SUBMIT' | 'SEND'
  readonly decision: PoGateResult
  readonly tier: RiskTierCode
  /** Warnings that need a reason no earlier one of the PO answers: the submit or the sending asks it */
  readonly reasonNeeded: readonly GateWarning[]
  /** The override it would pass with (source OVERRIDE) */
  readonly override: { readonly id: string; readonly number: string | null } | null
  /** The supplier's assessment still being answered or reviewed */
  readonly openAssessment: { readonly id: string; readonly number: string | null } | null
  /** The reader may open an assessment from this PO now (risk.assessment.manage · none open · the refusal is one an assessment clears) */
  readonly canOpenAssessment: boolean
}

/**
 * The PO page's risk band (FR-RSK-203 AC6): the gate the PO meets next, weighed now at its stored gross without writing
 * anything — for whoever reads every PO (po.view ORG: PROCUREMENT FINANCE EXECUTIVE AUDITOR); null with RISK off, for
 * anyone else (a requester or an approver reads the gate the PO passed in its facts), or when the PO meets no gate any
 * more (it went out). `draftGrossSatang`: the draft's gross at today's VAT rate as the page computed it, which its
 * submit weighs (the stored gross of a draft may be of another day's rate).
 */
export async function poRiskStatus(ctx: Ctx, poId: string, draftGrossSatang?: bigint): Promise<PoRiskStatus | null> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    if (!(await requireModule(ctx, 'RISK', tx)).ok) return null
    const reader = await authorize(tx, ctx, 'po.view')
    if (!reader.ok || !scopesFor(reader.data, 'po.view').has('ORG')) return null
    const po = await tx.purchaseOrder.findFirst({ where: { id: poId }, select: { status: true, sentAt: true, grossSatang: true, supplierId: true } })
    const trigger = po ? nextTrigger(po) : null
    if (!po || !trigger) return null
    const evaluated = await evaluatePoGate(tx, ctx, poId, trigger === 'SUBMIT' && draftGrossSatang !== undefined ? draftGrossSatang : po.grossSatang, trigger)
    if (!evaluated.ok) return null
    const e = evaluated.data
    const needed = e.decision.allowed ? e.decision.warnings.filter((w) => REASON_WARNINGS.includes(w)) : []
    const open = await tx.riskAssessment.findFirst({ where: { supplierId: po.supplierId, status: { in: [...OPEN_ASSESSMENT] } }, select: { id: true, number: true } })
    const manage = (await authorize(tx, ctx, 'risk.assessment.manage')).ok
    return {
      trigger,
      decision: e.decision,
      tier: e.tier,
      reasonNeeded: reasonCovered(e.prior, needed) ? [] : needed,
      override: e.decision.allowed && e.decision.source === 'OVERRIDE' && e.override ? { id: e.override.id, number: e.override.number } : null,
      openAssessment: open,
      canOpenAssessment: manage && !open && !e.decision.allowed && OPEN_FOR_ASSESSMENT.includes(e.decision.reason),
    }
  })
}

/**
 * The board's filter "PO ติดด่านความเสี่ยง" (FR-RSK-203 AC6): of the POs given, those whose first sending the gate would
 * refuse now — the approval goes on, the PO cannot go out. Empty with RISK off.
 */
export async function riskGatedPoIds(tx: TenantTx, ctx: Ctx, poIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (poIds.length === 0 || !(await requireModule(ctx, 'RISK', tx)).ok) return out
  const pos = await tx.purchaseOrder.findMany({ where: { id: { in: [...new Set(poIds)] } }, select: { id: true, grossSatang: true } })
  for (const po of pos) {
    const e = await evaluatePoGate(tx, ctx, po.id, po.grossSatang, 'SEND')
    if (e.ok && !e.data.decision.allowed) out.add(po.id)
  }
  return out
}

export type RiskGateDryRun = { readonly kind: 'COUNTED'; readonly open: number; readonly held: number } | { readonly kind: 'NOT_CONFIGURED'; readonly code: AppError['code'] }

/**
 * /platform/tenants/[orgId]/modules (S11-02 · S11-07): how many of the organization's POs still to go out (DRAFT, waiting
 * for approval, approved and not sent) the gate would hold the moment RISK is switched on — weighed with its tiers and
 * policy in effect, writing nothing. Not configured yet → the code that switching on would refuse with. The BCS team only.
 */
export async function riskGateDryRun(ctx: Ctx): Promise<Result<RiskGateDryRun>> {
  if (ctx.actor.type !== 'PLATFORM_ADMIN' || !(await isActivePlatformAdmin(ctx.actor.platformAdminId))) return fail('FORBIDDEN', 'only the BCS team')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const tiers = await riskTiersInEffect(tx)
    if (!tiers.ok) return { ok: true, data: { kind: 'NOT_CONFIGURED', code: tiers.error.code } }
    const policy = await riskPolicyInEffect(tx)
    if (!policy.ok) return { ok: true, data: { kind: 'NOT_CONFIGURED', code: policy.error.code } }
    const pos = await tx.purchaseOrder.findMany({
      where: { OR: [{ status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, { status: 'APPROVED', sentAt: null }] },
      select: { id: true, status: true, grossSatang: true },
    })
    let held = 0
    for (const po of pos) {
      const e = await evaluatePoGate(tx, ctx, po.id, po.grossSatang, po.status === 'DRAFT' ? 'SUBMIT' : 'SEND')
      if (e.ok && !e.data.decision.allowed) held++
    }
    return { ok: true, data: { kind: 'COUNTED', open: pos.length, held } }
  })
}

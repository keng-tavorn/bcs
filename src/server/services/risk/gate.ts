import { inherentTier, maxTier, poGate, REASON_WARNINGS, screeningCovers, SCREENING_FIELDS, type GateAssessment, type GateWarning, type PoGateResult, type PoGateTrigger, type RegistryFlag, type RiskTierCode, type Screening } from '@/core/risk'
import type { AppError, Result } from '@/core/result'
import { dateIn } from '@/core/supplier-docs'
import type { Ctx } from '@/server/context'
import { lockRowsForShare, lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
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
  readonly usedCount: number
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

type Lock = 'UPDATE' | 'SHARE' | 'NONE'

/**
 * Weighs the gate of a PO at `grossSatang` on ctx.now, RISK on: the tier is the higher of the PO's inherent tier
 * (BR-RSK-03 on the screening of the requests behind its lines and its line categories) and the supplier's; an override
 * the PO already draws on is tried first, then the others by the latest last day. `lock` UPDATE holds the overrides for
 * the write that follows and the assessment FOR SHARE (BR-RSK-19); SHARE holds both for a check that writes nothing.
 */
export async function evaluatePoGate(tx: TenantTx, ctx: Ctx, poId: string, grossSatang: bigint, trigger: PoGateTrigger, lock: Lock): Promise<Result<PoGateEvaluation>> {
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

  const completed = await tx.riskAssessment.findFirst({ where: { supplierId: po.supplierId, status: 'COMPLETED' }, select: { id: true } })
  if (completed && lock !== 'NONE') await lockRowsForShare(tx, 'RiskAssessment', ctx.organizationId, [completed.id])
  const current = completed
    ? await tx.riskAssessment.findFirst({ where: { id: completed.id, status: 'COMPLETED' }, select: { id: true, completedAt: true, validUntil: true, screening: true, categoryCodes: true } })
    : null
  const open = current ? 0 : await tx.riskAssessment.count({ where: { supplierId: po.supplierId, status: { in: [...OPEN_ASSESSMENT] } } })
  const today = dateIn(ctx.now, RISK_TIMEZONE)
  const assessment: GateAssessment = current?.validUntil ? (iso(current.validUntil) >= today ? 'CURRENT' : 'OVERDUE') : open > 0 ? 'IN_PROGRESS' : 'NONE'
  const covered = current ? screeningCovers({ screening: current.screening as Record<string, 'Y' | 'N'>, categoryCodes: current.categoryCodes }, { screening, categoryCodes }, policy.data.highRiskCategories) : false
  const flaggedAt = po.supplier.registryFlaggedAt
  const assessedAfterFlag = Boolean(current?.completedAt && flaggedAt && current.completedAt.getTime() > flaggedAt.getTime())

  const where = { supplierId: po.supplierId, status: { in: ['APPROVED', 'EXPIRED'] as ('APPROVED' | 'EXPIRED')[] }, OR: [{ poId: null }, { poId }] }
  const listed = await tx.riskOverride.findMany({ where, select: { id: true } })
  const ids = [...new Set([...listed.map((o) => o.id), ...(po.riskOverrideId ? [po.riskOverrideId] : [])])]
  if (lock === 'UPDATE') await lockRowsForUpdate(tx, 'RiskOverride', ctx.organizationId, ids)
  else if (lock === 'SHARE') await lockRowsForShare(tx, 'RiskOverride', ctx.organizationId, ids)
  const rows: OverrideRow[] = await tx.riskOverride.findMany({
    where: { ...where, id: { in: ids } },
    orderBy: [{ expiresOn: 'desc' }, { id: 'asc' }],
    select: { id: true, number: true, status: true, poId: true, expiresOn: true, capGrossSatang: true, usedGrossSatang: true, usedCount: true },
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
function refusal(e: PoGateEvaluation, poId: string): PoGateOutcome {
  if (e.decision.allowed) throw new Error('not a refusal')
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
  const evaluated = await evaluatePoGate(tx, ctx, call.poId, call.grossSatang, call.trigger, call.checkOnly ? 'SHARE' : 'UPDATE')
  if (!evaluated.ok) return evaluated
  const e = evaluated.data
  if (!e.decision.allowed) return refusal(e, call.poId)
  const { source, warnings } = e.decision

  // BR-SUP-04: a warning that needs a reason has one — given now, the PO change's own, or the PO's earlier one for it
  const needed = warnings.filter((w) => REASON_WARNINGS.includes(w))
  let reason: Pick<StoredRiskGate, 'reasonCommentId' | 'reasonPoChangeId' | 'reasonFor'> = {}
  if (needed.length > 0) {
    const given = call.reason?.trim()
    if (given) reason = { reasonFor: needed }
    else if (call.poChangeId) reason = { reasonPoChangeId: call.poChangeId, reasonFor: needed }
    else if (e.prior?.reasonFor && needed.every((w) => e.prior!.reasonFor!.includes(w)) && (e.prior.reasonCommentId || e.prior.reasonPoChangeId)) {
      reason = { ...(e.prior.reasonCommentId ? { reasonCommentId: e.prior.reasonCommentId } : { reasonPoChangeId: e.prior.reasonPoChangeId! }), reasonFor: e.prior.reasonFor }
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
  const held = e.prior?.countedGrossSatang !== undefined ? BigInt(e.prior.countedGrossSatang) : 0n
  if (e.boundOverrideId && e.boundOverrideId !== drawsOn?.id) {
    await tx.riskOverride.update({ where: { id: e.boundOverrideId }, data: { usedGrossSatang: { decrement: held }, usedCount: { decrement: 1 }, version: { increment: 1 } } })
    events.push({ type: 'risk_override.released', aggregateType: 'RiskOverride', aggregateId: e.boundOverrideId, data: { poId: call.poId, grossSatang: held.toString(), trigger: call.trigger } })
  }
  if (drawsOn) {
    const first = e.boundOverrideId !== drawsOn.id
    const delta = first ? call.grossSatang : call.grossSatang - held
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

import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import { applyTierChanges, RISK_TIER_CODES, tierOrderProblem, type RiskPolicyDef, type RiskTierCode, type RiskTierDef, type TierChange } from '@/core/risk'
import { RISK_TIER_POINTS_MAX } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { DB_NULL } from '@/server/db/json'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'

// The tier thresholds and the gate policy of an organization (S11-04 · BR-RSK-02 · ADR-229): ORG_ADMIN or DOA_ADMIN
// proposes new values, which wait in pending* while the values in effect stay; someone else confirms them, which copies
// them over in one transaction, or anyone of the two discards them. The engine and the PO gate read the values in effect
// only (riskTiersInEffect · riskPolicyInEffect), so a proposal changes nothing until it is confirmed. PLATFORM_ADMIN
// never reaches these commands (NG-12): admin.riskTiers is granted to members of the organization only.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

/** RISK on, admin.riskTiers (ORG_ADMIN or DOA_ADMIN · ORG_ADMIN not once the DOA administrators are separated) */
async function tiersGuard(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; memberId: string } | Fail> {
  const on = await requireModule(ctx, 'RISK', tx)
  if (!on.ok) return { ok: false, error: on.error }
  const may = await authorize(tx, ctx, 'admin.riskTiers')
  if (!may.ok) return { ok: false, error: may.error }
  if (may.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
  return { ok: true, memberId: may.data.memberId }
}

const TIER_FIELDS = ['minPoints', 'reviewMonths', 'reminderDaysBefore', 'blocksPo', 'requiresExplicitAnswers'] as const
type TierField = (typeof TIER_FIELDS)[number]

const TierChangeInput = z.strictObject({
  minPoints: z.int().min(0).max(RISK_TIER_POINTS_MAX).optional(),
  reviewMonths: z.int().min(1).max(120).optional(),
  reminderDaysBefore: z.int().min(0).max(365).optional(),
  blocksPo: z.boolean().optional(),
  requiresExplicitAnswers: z.boolean().optional(),
})
const TierChangesInput = z.strictObject({ LOW: TierChangeInput.optional(), MEDIUM: TierChangeInput.optional(), HIGH: TierChangeInput.optional() })
const PendingTierChange = TierChangeInput

type TierRow = Awaited<ReturnType<typeof loadTierRows>>[number]
const loadTierRows = (tx: TenantTx) => tx.riskTier.findMany({ orderBy: { minPoints: 'asc' } })
const defOf = (r: Pick<TierRow, 'code' | TierField>): RiskTierDef => ({ code: r.code, minPoints: r.minPoints, reviewMonths: r.reviewMonths, reminderDaysBefore: r.reminderDaysBefore, blocksPo: r.blocksPo, requiresExplicitAnswers: r.requiresExplicitAnswers })

/** The rows of the three tiers, or RISK_TIER_NOT_CONFIGURED: they come from the organization's data (seed), never code */
async function threeTiers(tx: TenantTx): Promise<{ ok: true; rows: TierRow[] } | Fail> {
  const rows = await loadTierRows(tx)
  if (RISK_TIER_CODES.some((code) => rows.filter((r) => r.code === code).length !== 1)) return fail('RISK_TIER_NOT_CONFIGURED', 'the organization has no three risk tiers')
  return { ok: true, rows }
}

/** What the confirmed tiers would become: each field of the change that differs from the value in effect */
function realChange(row: TierRow, change: TierChange | undefined): TierChange {
  const out: Record<string, number | boolean> = {}
  for (const f of TIER_FIELDS) if (change?.[f] !== undefined && change[f] !== row[f]) out[f] = change[f]!
  return out as TierChange
}

// ---------- admin.riskTiers.propose · .confirm · .discard ----------

const proposeTiersCommand = defineCommand({
  name: 'admin.riskTiers.propose',
  capability: 'admin.riskTiers',
  input: z.strictObject({ changes: TierChangesInput }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ codes: RiskTierCode[] }>> {
    const who = await tiersGuard(tx, ctx)
    if (!who.ok) return who
    const tiers = await threeTiers(tx)
    if (!tiers.ok) return tiers
    if (tiers.rows.some((r) => r.pendingChange !== null)) return fail('VALIDATION_FAILED', 'a change of the tiers waits for confirmation', { reason: 'PENDING_CHANGE_EXISTS' })
    const changes = Object.fromEntries(tiers.rows.map((r) => [r.code, realChange(r, input.changes[r.code])]).filter(([, c]) => Object.keys(c as object).length > 0)) as Partial<Record<RiskTierCode, TierChange>>
    const codes = Object.keys(changes) as RiskTierCode[]
    if (codes.length === 0) return fail('VALIDATION_FAILED', 'nothing changed', { reason: 'NO_CHANGE' })
    // the order is checked on the set that would be in effect after confirming (BR-RSK-02)
    const problem = tierOrderProblem(applyTierChanges(tiers.rows.map(defOf), changes))
    if (problem) return fail('VALIDATION_FAILED', 'the lower bounds must rise from LOW at 0 to MEDIUM to HIGH', { reason: 'TIER_ORDER', problem })
    const events: EventDraft[] = []
    for (const row of tiers.rows.filter((r) => codes.includes(r.code))) {
      const pendingChange = changes[row.code]!
      await tx.riskTier.update({ where: { id: row.id }, data: { pendingChange: pendingChange as object, pendingById: who.memberId, pendingAt: ctx.now, version: { increment: 1 } } })
      events.push({ type: 'risk_tier.proposed', aggregateType: 'RiskTier', aggregateId: row.id, data: { code: row.code, pendingChange } })
    }
    return { ok: true, result: { codes }, events }
  },
})

/** The proposal the screen showed: each pending row and its version, so a newer proposal is not confirmed unseen */
const PendingRowsInput = z.strictObject({ rows: z.array(z.strictObject({ code: z.enum(RISK_TIER_CODES), version: z.int().min(0) })).min(1).max(3) })

async function pendingTierRows(tx: TenantTx, input: z.infer<typeof PendingRowsInput>): Promise<{ ok: true; rows: TierRow[] } | Fail> {
  const tiers = await threeTiers(tx)
  if (!tiers.ok) return tiers
  const pending = tiers.rows.filter((r) => r.pendingChange !== null)
  if (pending.length === 0) return fail('INVALID_STATE_TRANSITION', 'no change of the tiers waits for confirmation', { reason: 'NO_PENDING_CHANGE' })
  const asked = new Map(input.rows.map((r) => [r.code, r.version]))
  if (asked.size !== pending.length || pending.some((r) => asked.get(r.code) !== r.version)) return fail('CONFLICT_VERSION', 'the proposal changed since it was read', { reason: 'PENDING_CHANGED' })
  return { ok: true, rows: tiers.rows }
}

const confirmTiersCommand = defineCommand({
  name: 'admin.riskTiers.confirm',
  capability: 'admin.riskTiers',
  input: PendingRowsInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ codes: RiskTierCode[] }>> {
    const who = await tiersGuard(tx, ctx)
    if (!who.ok) return who
    const tiers = await pendingTierRows(tx, input)
    if (!tiers.ok) return tiers
    const pending = tiers.rows.filter((r) => r.pendingChange !== null)
    // the one who proposed does not confirm (BR-RSK-02 · CHECK risk_tier_shape)
    if (pending.some((r) => r.pendingById === who.memberId)) return fail('VALIDATION_FAILED', 'the member who proposed a change does not confirm it', { reason: 'SAME_EDITOR' })
    const changes = Object.fromEntries(pending.map((r) => [r.code, PendingTierChange.parse(r.pendingChange)])) as Partial<Record<RiskTierCode, TierChange>>
    // the tiers in effect may not have moved since the proposal (only confirm writes them), but the order is checked again
    const problem = tierOrderProblem(applyTierChanges(tiers.rows.map(defOf), changes))
    if (problem) return fail('VALIDATION_FAILED', 'the lower bounds must rise from LOW at 0 to MEDIUM to HIGH', { reason: 'TIER_ORDER', problem })
    const events: EventDraft[] = []
    for (const row of pending) {
      const change = changes[row.code]!
      const changed = TIER_FIELDS.filter((f) => change[f] !== undefined).map((f) => ({ field: f, from: row[f], to: change[f]! }))
      await tx.riskTier.update({
        where: { id: row.id },
        data: { ...change, updatedById: row.pendingById!, confirmedById: who.memberId, confirmedAt: ctx.now, pendingChange: DB_NULL, pendingById: null, pendingAt: null, version: { increment: 1 } },
      })
      events.push({ type: 'risk_tier.confirmed', aggregateType: 'RiskTier', aggregateId: row.id, data: { code: row.code, changed, proposedById: row.pendingById!, confirmedById: who.memberId } })
    }
    return { ok: true, result: { codes: pending.map((r) => r.code) }, events }
  },
})

const discardTiersCommand = defineCommand({
  name: 'admin.riskTiers.discard',
  capability: 'admin.riskTiers',
  input: PendingRowsInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ codes: RiskTierCode[] }>> {
    const who = await tiersGuard(tx, ctx)
    if (!who.ok) return who
    const tiers = await pendingTierRows(tx, input)
    if (!tiers.ok) return tiers
    const pending = tiers.rows.filter((r) => r.pendingChange !== null)
    const events: EventDraft[] = []
    for (const row of pending) {
      await tx.riskTier.update({ where: { id: row.id }, data: { pendingChange: DB_NULL, pendingById: null, pendingAt: null, version: { increment: 1 } } })
      events.push({ type: 'risk_tier.discarded', aggregateType: 'RiskTier', aggregateId: row.id, data: { code: row.code, proposedById: row.pendingById! } })
    }
    return { ok: true, result: { codes: pending.map((r) => r.code) }, events }
  },
})

export const proposeRiskTiers = (ctx: Ctx, input: z.input<typeof proposeTiersCommand.input>, options: RunOptions) => runCommand(ctx, proposeTiersCommand, input, options)
export const confirmRiskTiers = (ctx: Ctx, input: z.input<typeof PendingRowsInput>, options: RunOptions) => runCommand(ctx, confirmTiersCommand, input, options)
export const discardRiskTiers = (ctx: Ctx, input: z.input<typeof PendingRowsInput>, options: RunOptions) => runCommand(ctx, discardTiersCommand, input, options)

// ---------- admin.riskPolicy.propose · .confirm · .discard (the capability admin.riskTiers) ----------

const CATEGORY_CODE = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,29}$/)
const PolicyValues = z.strictObject({
  screeningTierMap: z.strictObject({ processesPersonalData: z.enum(RISK_TIER_CODES), accessesSystems: z.enum(RISK_TIER_CODES), accessesPremises: z.enum(RISK_TIER_CODES) }),
  highRiskCategories: z.array(CATEGORY_CODE).max(50).refine((a) => new Set(a).size === a.length, { message: 'a category appears twice' }),
  registryFlagBlocks: z.boolean(),
  mediumOverdueBlocks: z.boolean(),
  overrideChatButton: z.boolean(),
})
const PendingPolicyChange = PolicyValues.partial()
type PolicyChange = z.infer<typeof PendingPolicyChange>
const POLICY_FIELDS = ['screeningTierMap', 'highRiskCategories', 'registryFlagBlocks', 'mediumOverdueBlocks', 'overrideChatButton'] as const

type PolicyRow = NonNullable<Awaited<ReturnType<typeof loadPolicy>>>
const loadPolicy = (tx: TenantTx) => tx.riskPolicy.findFirst()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const proposePolicyCommand = defineCommand({
  name: 'admin.riskPolicy.propose',
  capability: 'admin.riskTiers',
  input: z.strictObject({ changes: PendingPolicyChange }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ fields: string[] }>> {
    const who = await tiersGuard(tx, ctx)
    if (!who.ok) return who
    const row = await loadPolicy(tx)
    if (!row) return fail('RISK_POLICY_NOT_CONFIGURED', 'the organization has no risk policy')
    if (row.pendingChange !== null) return fail('VALIDATION_FAILED', 'a change of the policy waits for confirmation', { reason: 'PENDING_CHANGE_EXISTS' })
    const pendingChange: PolicyChange = {}
    for (const f of POLICY_FIELDS) if (input.changes[f] !== undefined && !same(input.changes[f], row[f])) (pendingChange as Record<string, unknown>)[f] = input.changes[f]
    const fields = Object.keys(pendingChange)
    if (fields.length === 0) return fail('VALIDATION_FAILED', 'nothing changed', { reason: 'NO_CHANGE' })
    await tx.riskPolicy.update({ where: { id: row.id }, data: { pendingChange, pendingById: who.memberId, pendingAt: ctx.now, version: { increment: 1 } } })
    return { ok: true, result: { fields }, events: [{ type: 'risk_policy.proposed', aggregateType: 'RiskPolicy', aggregateId: row.id, data: { fields, pendingChange } }] }
  },
})

const PolicyVersionInput = z.strictObject({ version: z.int().min(0) })

async function pendingPolicy(tx: TenantTx, version: number): Promise<{ ok: true; row: PolicyRow } | Fail> {
  const row = await loadPolicy(tx)
  if (!row) return fail('RISK_POLICY_NOT_CONFIGURED', 'the organization has no risk policy')
  if (row.pendingChange === null) return fail('INVALID_STATE_TRANSITION', 'no change of the policy waits for confirmation', { reason: 'NO_PENDING_CHANGE' })
  if (row.version !== version) return fail('CONFLICT_VERSION', 'the proposal changed since it was read', { reason: 'PENDING_CHANGED' })
  return { ok: true, row }
}

const confirmPolicyCommand = defineCommand({
  name: 'admin.riskPolicy.confirm',
  capability: 'admin.riskTiers',
  input: PolicyVersionInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ fields: string[] }>> {
    const who = await tiersGuard(tx, ctx)
    if (!who.ok) return who
    const p = await pendingPolicy(tx, input.version)
    if (!p.ok) return p
    if (p.row.pendingById === who.memberId) return fail('VALIDATION_FAILED', 'the member who proposed a change does not confirm it', { reason: 'SAME_EDITOR' })
    const change = PendingPolicyChange.parse(p.row.pendingChange)
    const changed = POLICY_FIELDS.filter((f) => change[f] !== undefined).map((f) => ({ field: f, from: p.row[f], to: change[f] }))
    await tx.riskPolicy.update({
      where: { id: p.row.id },
      data: { ...change, updatedById: p.row.pendingById!, confirmedById: who.memberId, confirmedAt: ctx.now, pendingChange: DB_NULL, pendingById: null, pendingAt: null, version: { increment: 1 } },
    })
    return {
      ok: true,
      result: { fields: changed.map((c) => c.field) },
      events: [{ type: 'risk_policy.confirmed', aggregateType: 'RiskPolicy', aggregateId: p.row.id, data: { changed, proposedById: p.row.pendingById!, confirmedById: who.memberId } }],
    }
  },
})

const discardPolicyCommand = defineCommand({
  name: 'admin.riskPolicy.discard',
  capability: 'admin.riskTiers',
  input: PolicyVersionInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ fields: string[] }>> {
    const who = await tiersGuard(tx, ctx)
    if (!who.ok) return who
    const p = await pendingPolicy(tx, input.version)
    if (!p.ok) return p
    const fields = Object.keys(PendingPolicyChange.parse(p.row.pendingChange))
    await tx.riskPolicy.update({ where: { id: p.row.id }, data: { pendingChange: DB_NULL, pendingById: null, pendingAt: null, version: { increment: 1 } } })
    return { ok: true, result: { fields }, events: [{ type: 'risk_policy.discarded', aggregateType: 'RiskPolicy', aggregateId: p.row.id, data: { fields, proposedById: p.row.pendingById! } }] }
  },
})

export const proposeRiskPolicy = (ctx: Ctx, input: z.input<typeof proposePolicyCommand.input>, options: RunOptions) => runCommand(ctx, proposePolicyCommand, input, options)
export const confirmRiskPolicy = (ctx: Ctx, input: { version: number }, options: RunOptions) => runCommand(ctx, confirmPolicyCommand, input, options)
export const discardRiskPolicy = (ctx: Ctx, input: { version: number }, options: RunOptions) => runCommand(ctx, discardPolicyCommand, input, options)

// ---------- what the engine and the gate read: the values in effect only (BR-RSK-02) ----------

/**
 * The three tiers in effect: the confirmed columns of each row (a pending change never shows here). RISK_TIER_NOT_CONFIGURED
 * when a row is missing or was never confirmed (BR-RSK-16).
 */
export async function riskTiersInEffect(tx: TenantTx): Promise<Result<RiskTierDef[]>> {
  const rows = await loadTierRows(tx)
  if (RISK_TIER_CODES.some((code) => rows.filter((r) => r.code === code && r.confirmedById !== null).length !== 1)) {
    return { ok: false, error: { code: 'RISK_TIER_NOT_CONFIGURED', message: 'the risk tiers are not confirmed' } }
  }
  return { ok: true, data: rows.map(defOf) }
}

/** The confirmed policy of the gate (BR-RSK-03 · BR-RSK-09); RISK_POLICY_NOT_CONFIGURED when none is confirmed (BR-RSK-16) */
export interface RiskPolicyInEffect extends RiskPolicyDef {
  readonly registryFlagBlocks: boolean
  readonly mediumOverdueBlocks: boolean
  readonly overrideChatButton: boolean
}

export async function riskPolicyInEffect(tx: TenantTx): Promise<Result<RiskPolicyInEffect>> {
  const row = await loadPolicy(tx)
  if (!row || row.confirmedById === null) return { ok: false, error: { code: 'RISK_POLICY_NOT_CONFIGURED', message: 'the risk policy is not confirmed' } }
  const values = PolicyValues.parse({ screeningTierMap: row.screeningTierMap, highRiskCategories: row.highRiskCategories, registryFlagBlocks: row.registryFlagBlocks, mediumOverdueBlocks: row.mediumOverdueBlocks, overrideChatButton: row.overrideChatButton })
  return { ok: true, data: values }
}

// ---------- /admin/risk/tiers ----------

export interface RiskTierRowView {
  readonly code: RiskTierCode
  readonly nameTh: string
  readonly nameEn: string
  readonly inEffect: RiskTierDef
  readonly confirmedAt: Date | null
  readonly pending: TierChange | null
  readonly pendingByName: string | null
  readonly pendingByMe: boolean
  readonly pendingAt: Date | null
  readonly version: number
}

export interface RiskPolicyView {
  readonly inEffect: z.infer<typeof PolicyValues>
  readonly confirmed: boolean
  readonly pending: PolicyChange | null
  readonly pendingByName: string | null
  readonly pendingByMe: boolean
  readonly pendingAt: Date | null
  readonly version: number
}

/** The page: the three tiers and the policy, each with what waits for someone else to confirm (admin.riskTiers) */
export async function riskTiersAdminView(ctx: Ctx): Promise<Result<{ tiers: RiskTierRowView[]; policy: RiskPolicyView | null }>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await tiersGuard(tx, ctx)
    if (!who.ok) return who
    const rows = await tx.riskTier.findMany({ include: { pendingBy: { select: { displayNameTh: true } } } })
    const order = (c: RiskTierCode) => RISK_TIER_CODES.indexOf(c)
    const tiers = rows
      .sort((a, b) => order(a.code) - order(b.code))
      .map((r) => ({
        code: r.code,
        nameTh: r.nameTh,
        nameEn: r.nameEn,
        inEffect: defOf(r),
        confirmedAt: r.confirmedAt,
        pending: r.pendingChange === null ? null : PendingTierChange.parse(r.pendingChange),
        pendingByName: r.pendingBy?.displayNameTh ?? null,
        pendingByMe: r.pendingById === who.memberId,
        pendingAt: r.pendingAt,
        version: r.version,
      }))
    const p = await tx.riskPolicy.findFirst({ include: { pendingBy: { select: { displayNameTh: true } } } })
    const policy: RiskPolicyView | null = p
      ? {
          inEffect: PolicyValues.parse({ screeningTierMap: p.screeningTierMap, highRiskCategories: p.highRiskCategories, registryFlagBlocks: p.registryFlagBlocks, mediumOverdueBlocks: p.mediumOverdueBlocks, overrideChatButton: p.overrideChatButton }),
          confirmed: p.confirmedById !== null,
          pending: p.pendingChange === null ? null : PendingPolicyChange.parse(p.pendingChange),
          pendingByName: p.pendingBy?.displayNameTh ?? null,
          pendingByMe: p.pendingById === who.memberId,
          pendingAt: p.pendingAt,
          version: p.version,
        }
      : null
    return { ok: true as const, data: { tiers, policy } }
  })
}

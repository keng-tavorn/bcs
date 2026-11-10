import { z } from 'zod'
import { agreementDay } from '@/core/pricing'
import type { AppError } from '@/core/result'
import { preferredWindow } from '@/core/sourcing'
import { MS_PER_DAY, REASON_MAX_LENGTH } from '@/lib/constants'
import { sourcingSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { supplierRiskStatus } from './risk-link'

// Preferred suppliers (S10-11 S10-13 · ADR-207 · BR-RFX-14 · BR-FORM-12 · §8.12 FR-SRC-204 AC6 AC7 · OQ-210 · GC-SRC-29 30
// 38): a supplier preferred for a category over [validFrom, validTo), Thai calendar days. An approved award makes one per
// winner of its RFx's category from the Thai day of the approval for preferredSupplierDays (upsertPreferredFromAward); a
// pair (category, supplier) whose row still runs into that period is extended to its end instead of made again, so the
// rows of a pair never overlap — pairs of other suppliers of the same category may (a split award, several RFx).
// PROCUREMENT sets one itself (MANUAL, with a reason) while SOURCING is on, and ends one early (endedAt: from then on it is
// not in effect). A row in effect fills the request form's supplier before the latest one (BR-FORM-02), and a request
// sent to another supplier carries the requester's reason (checkPreferredOverride) — unless, with RISK on, the preferred
// one is overdue or due for reassessment at S11 or flagged by the registry (CEASED VAT_CANCELLED): S11 would stop its PO,
// so whoever steers clear of it is not asked why. A row never follows the supplier's risk by itself; procurement ends it.
// Switching SOURCING off keeps the rows filling the form (BR-RFX-16), only no new one is set. Only a supplier that is
// ACTIVE is preferred in effect: the form offers no other, so nobody is asked to explain not choosing one they could not.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`)
const addDays = (day: string, n: number) => dayOf(new Date(dateOf(day).getTime() + n * MS_PER_DAY))
const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

/** BR-RFX-14: the risk of a preferred supplier that releases the requester from giving a reason (with RISK on) */
export const PREFERRED_RISK_STATUSES = ['OVERDUE', 'REASSESS_REQUIRED'] as const
export const PREFERRED_RISK_FLAGS = ['CEASED', 'VAT_CANCELLED'] as const
/** BR-RFX-14: with RISK on, the preferred supplier S11 would stop — a requester who leaves it is not asked why */
export function isRiskExempt(risk: PreferredRisk | null): boolean {
  return risk !== null && ((PREFERRED_RISK_STATUSES as readonly string[]).includes(risk.status ?? '') || (PREFERRED_RISK_FLAGS as readonly string[]).includes(risk.registryFlag))
}
/** The job warns PROCUREMENT this many days before validTo, once per row and end (BR-RFX-14) */
export const PREFERRED_EXPIRY_WARNING_DAYS = 30

// ---------- from an approved award (S10-11 calls it inside the decision's transaction) ----------

/** The preferred-supplier rows of an approved award, inside its decision's transaction (ctx: the award's submitter) */
export async function upsertPreferredFromAward(
  tx: TenantTx,
  ctx: Ctx,
  input: { readonly awardDecisionId: string; readonly categoryCode: string; readonly supplierIds: readonly string[] },
): Promise<{ readonly preferredSupplierIds: string[]; readonly events: EventDraft[] }> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const window = preferredWindow(ctx.now, sourcingSettingsOf(org.settings).preferredSupplierDays)
  // one supplier's rows at a time, so two awards approved together (or an award and a MANUAL row) never make two rows of
  // one pair that overlap
  const suppliers = await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [...new Set(input.supplierIds)])
  const preferredSupplierIds: string[] = []
  const events: EventDraft[] = []
  for (const supplierId of suppliers) {
    const overlapping = await tx.preferredSupplier.findMany({
      where: { categoryCode: input.categoryCode, supplierId, endedAt: null, validFrom: { lt: dateOf(window.validTo) }, validTo: { gt: dateOf(window.validFrom) } },
      orderBy: { validTo: 'desc' },
      select: { id: true, validTo: true },
    })
    const latest = overlapping[0]
    if (latest) {
      preferredSupplierIds.push(latest.id)
      const from = dayOf(latest.validTo)
      if (from < window.validTo) {
        await tx.preferredSupplier.update({ where: { id: latest.id }, data: { validTo: dateOf(window.validTo) } })
        events.push({ type: 'preferred_supplier.extended', aggregateType: 'PreferredSupplier', aggregateId: latest.id, data: { categoryCode: input.categoryCode, supplierId, from, to: window.validTo, awardDecisionId: input.awardDecisionId } })
      }
      continue
    }
    const row = await tx.preferredSupplier.create({
      data: { organizationId: ctx.organizationId, categoryCode: input.categoryCode, supplierId, validFrom: dateOf(window.validFrom), validTo: dateOf(window.validTo), source: 'SOURCING', awardDecisionId: input.awardDecisionId, createdById: memberOf(ctx) },
      select: { id: true },
    })
    preferredSupplierIds.push(row.id)
    events.push({ type: 'preferred_supplier.created', aggregateType: 'PreferredSupplier', aggregateId: row.id, data: { categoryCode: input.categoryCode, supplierId, validFrom: window.validFrom, validTo: window.validTo, source: 'SOURCING', awardDecisionId: input.awardDecisionId } })
  }
  return { preferredSupplierIds, events }
}

// ---------- reading what is in effect ----------

export interface PreferredRisk {
  /** S11's tier, or null without an assessment */
  readonly tier: string | null
  /** S11's assessment status (CURRENT EXPIRING OVERDUE REASSESS_REQUIRED …), or null */
  readonly status: string | null
  /** Supplier.registryFlag (NONE CEASED VAT_CANCELLED NOT_FOUND) */
  readonly registryFlag: string
}

export interface PreferredSupplierEntry {
  readonly id: string
  readonly categoryCode: string
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: { readonly th: string; readonly en: string | null }
  readonly source: 'SOURCING' | 'MANUAL'
  /** AWD-… of the award it came from; null for MANUAL */
  readonly awardNumber: string | null
  readonly validFrom: string
  /** Not included */
  readonly validTo: string
  /** With RISK on: the supplier's risk (S11's provider and the registry); null with RISK off */
  readonly risk: PreferredRisk | null
  /** BR-RFX-14: with RISK on, a requester who chooses another supplier is not asked why */
  readonly riskExempt: boolean
}

/** Whether the organization has RISK on: the preferred suppliers then carry their risk (BR-RFX-14) */
export async function riskOn(tx: TenantTx, ctx: Ctx): Promise<boolean> {
  return (await requireModule(ctx, 'RISK', tx)).ok
}

/**
 * The preferred suppliers in effect on a Thai calendar day for the categories given (all of them when `categoryCodes` is
 * left out), each category's rows latest validFrom first (the one the form fills, BR-FORM-12). Not ended, of an ACTIVE
 * supplier, validFrom ≤ day < validTo. With RISK on each carries the supplier's risk.
 */
export async function preferredInEffect(tx: TenantTx, ctx: Ctx, options: { readonly day: string; readonly categoryCodes?: readonly string[] }): Promise<PreferredSupplierEntry[]> {
  if (options.categoryCodes && options.categoryCodes.length === 0) return []
  const date = dateOf(options.day)
  const rows = await tx.preferredSupplier.findMany({
    where: {
      endedAt: null,
      validFrom: { lte: date },
      validTo: { gt: date },
      supplier: { status: 'ACTIVE' },
      ...(options.categoryCodes ? { categoryCode: { in: [...new Set(options.categoryCodes)] } } : {}),
    },
    orderBy: [{ categoryCode: 'asc' }, { validFrom: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      categoryCode: true,
      supplierId: true,
      source: true,
      validFrom: true,
      validTo: true,
      supplier: { select: { code: true, nameTh: true, nameEn: true, registryFlag: true } },
      awardDecision: { select: { number: true } },
    },
  })
  const withRisk = rows.length > 0 && (await riskOn(tx, ctx))
  const risks = new Map<string, PreferredRisk>()
  if (withRisk) {
    for (const r of rows) {
      if (risks.has(r.supplierId)) continue
      const status = await supplierRiskStatus(tx, ctx.organizationId, r.supplierId, ctx.now)
      risks.set(r.supplierId, { tier: status?.tier ?? null, status: status?.status ?? null, registryFlag: r.supplier.registryFlag })
    }
  }
  return rows.map((r) => {
    const risk = risks.get(r.supplierId) ?? null
    return {
      id: r.id,
      categoryCode: r.categoryCode,
      supplierId: r.supplierId,
      supplierCode: r.supplier.code,
      supplierName: { th: r.supplier.nameTh, en: r.supplier.nameEn },
      source: r.source,
      awardNumber: r.awardDecision?.number ?? null,
      validFrom: dayOf(r.validFrom),
      validTo: dayOf(r.validTo),
      risk,
      riskExempt: isRiskExempt(risk),
    }
  })
}

/** BR-RFX-14: the preferred suppliers of one category in effect on a Thai calendar day, latest validFrom first */
export async function preferredSuppliersFor(ctx: Ctx, categoryCode: string, day: string): Promise<PreferredSupplierEntry[]> {
  return forTenant(ctx.organizationId).$transaction((tx) => preferredInEffect(tx, ctx, { day, categoryCodes: [categoryCode] }))
}

// ---------- the request's supplier against them (BR-FORM-12) ----------

export interface PreferredOverride {
  readonly categoryCode: string
  /** The row that asks the reason: the latest validFrom not risk-exempt (the one the form fills when none is) */
  readonly preferredSupplierId: string
  readonly supplierId: string
  /** Every preferred supplier of the category is one S11 would stop (RISK on): no reason is asked */
  readonly riskExempt: boolean
}

/**
 * The categories of a request whose preferred suppliers in effect today do not include the supplier it suggests (or it
 * suggests none). The request's suggested supplier is the supplier of its lines (as for BR-PRC-06), so choosing any of a
 * category's preferred suppliers keeps to it; a reason is needed unless every preferred supplier of the category is
 * risk-exempt (BR-RFX-14).
 */
export async function preferredOverrides(tx: TenantTx, ctx: Ctx, input: { readonly categoryCodes: readonly (string | null)[]; readonly supplierId: string | null }): Promise<PreferredOverride[]> {
  const categories = [...new Set(input.categoryCodes.filter((c): c is string => Boolean(c)))]
  const rows = await preferredInEffect(tx, ctx, { day: agreementDay(ctx.now), categoryCodes: categories })
  const out: PreferredOverride[] = []
  for (const categoryCode of categories.sort()) {
    const of = rows.filter((r) => r.categoryCode === categoryCode)
    if (of.length === 0 || of.some((r) => r.supplierId === input.supplierId)) continue
    // review ข้อ 2: name the row that asks the reason, not a risk-exempt one before it
    const named = of.find((r) => !r.riskExempt) ?? of[0]!
    out.push({ categoryCode, preferredSupplierId: named.id, supplierId: named.supplierId, riskExempt: of.every((r) => r.riskExempt) })
  }
  return out
}

/**
 * At submit and resubmit (BR-FORM-12): another supplier than the preferred one needs the request's reason
 * (VALIDATION_FAILED PREFERRED_OVERRIDE_REASON); one sent with it is recorded (request.preferred_overridden, the reason a
 * Comment of the request). Nothing to explain → the reason left from an earlier choice is cleared.
 */
export async function checkPreferredOverride(
  tx: TenantTx,
  ctx: Ctx,
  request: { readonly id: string; readonly suggestedSupplierId: string | null; readonly preferredSupplierOverrideReason: string | null; readonly lines: readonly { readonly categoryCode: string | null }[] },
): Promise<Fail | { readonly ok: true; readonly events: EventDraft[] }> {
  const overrides = await preferredOverrides(tx, ctx, { categoryCodes: request.lines.map((l) => l.categoryCode), supplierId: request.suggestedSupplierId })
  const reason = (request.preferredSupplierOverrideReason ?? '').trim()
  if (overrides.length === 0) {
    if (request.preferredSupplierOverrideReason !== null) await tx.request.update({ where: { id: request.id }, data: { preferredSupplierOverrideReason: null } })
    return { ok: true, events: [] }
  }
  const asked = overrides.filter((o) => !o.riskExempt)
  if (asked.length && !reason) {
    const first = asked[0]!
    return fail('VALIDATION_FAILED', 'another supplier than the preferred one needs a reason', { field: 'preferredSupplierOverrideReason', reason: 'PREFERRED_OVERRIDE_REASON', categoryCode: first.categoryCode, preferredSupplierId: first.preferredSupplierId })
  }
  let reasonCommentId: string | undefined
  if (reason) {
    const comment = await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'Request', subjectId: request.id, authorMemberId: memberOf(ctx), body: reason }, select: { id: true } })
    reasonCommentId = comment.id
  }
  return {
    ok: true,
    events: [
      {
        type: 'request.preferred_overridden',
        aggregateType: 'Request',
        aggregateId: request.id,
        data: {
          supplierId: request.suggestedSupplierId,
          overrides: overrides.map((o) => ({ categoryCode: o.categoryCode, preferredSupplierId: o.preferredSupplierId, riskExempt: o.riskExempt })),
          ...(reasonCommentId ? { reasonCommentId } : {}),
        },
      },
    ],
  }
}

// ---------- preferredSupplier.create (MANUAL) ----------

const Day = z.iso.date()
const Reason = z.string().trim().min(3).max(REASON_MAX_LENGTH)

const CreateInput = z.strictObject({
  categoryCode: z.string().trim().min(1).max(50),
  supplierId: z.uuid(),
  /** Today when left out; never a day before today */
  validFrom: Day.optional(),
  /** Not included; validFrom + preferredSupplierDays when left out */
  validTo: Day.optional(),
  /** Why procurement prefers it (BR-RFX-14: MANUAL with a reason) */
  note: Reason,
})

/** A category procurement knows: one of the catalogue's items or of an RFx */
async function knownCategory(tx: TenantTx, categoryCode: string): Promise<boolean> {
  if (await tx.catalogItem.count({ where: { categoryCode } })) return true
  return (await tx.rfxEvent.count({ where: { categoryCode } })) > 0
}

export const createPreferredSupplierCommand = defineCommand({
  name: 'preferredSupplier.create',
  capability: 'sourcing.preferred.manage',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ preferredSupplierId: string; validFrom: string; validTo: string }>> {
    // BR-RFX-16: with SOURCING off the rows set before still fill the form, but no new one is set
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const may = await authorize(tx, ctx, 'sourcing.preferred.manage')
    if (!may.ok) return { ok: false, error: may.error }
    // the supplier's rows one change at a time (as an award's), so two set together cannot both pass the overlap check
    const [locked] = await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [input.supplierId])
    if (!locked || !(await tx.supplier.count({ where: { id: input.supplierId, status: 'ACTIVE' } }))) return fail('VALIDATION_FAILED', 'unknown or inactive supplier', { field: 'supplierId', reason: 'UNKNOWN' })
    if (!(await knownCategory(tx, input.categoryCode))) return fail('VALIDATION_FAILED', 'unknown category', { field: 'categoryCode', reason: 'UNKNOWN' })
    const today = agreementDay(ctx.now)
    const validFrom = input.validFrom ?? today
    if (validFrom < today) return fail('VALIDATION_FAILED', 'a preferred supplier starts today or later', { field: 'validFrom', reason: 'PERIOD_PAST' })
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const validTo = input.validTo ?? addDays(validFrom, sourcingSettingsOf(org.settings).preferredSupplierDays)
    if (validTo <= validFrom) return fail('VALIDATION_FAILED', 'the period ends after it starts', { field: 'validTo', reason: 'PERIOD' })
    const clash = await tx.preferredSupplier.findFirst({
      where: { categoryCode: input.categoryCode, supplierId: input.supplierId, endedAt: null, validFrom: { lt: dateOf(validTo) }, validTo: { gt: dateOf(validFrom) } },
      orderBy: { validTo: 'desc' },
      select: { id: true, validTo: true },
    })
    if (clash) return fail('PREFERRED_OVERLAP', 'the supplier is preferred for this category over these days already', { preferredSupplierId: clash.id, validTo: dayOf(clash.validTo), lastDay: addDays(dayOf(clash.validTo), -1) })
    const row = await tx.preferredSupplier.create({
      data: { organizationId: ctx.organizationId, categoryCode: input.categoryCode, supplierId: input.supplierId, validFrom: dateOf(validFrom), validTo: dateOf(validTo), source: 'MANUAL', note: input.note, createdById: memberOf(ctx) },
      select: { id: true },
    })
    return {
      ok: true,
      result: { preferredSupplierId: row.id, validFrom, validTo },
      events: [{ type: 'preferred_supplier.created', aggregateType: 'PreferredSupplier', aggregateId: row.id, data: { categoryCode: input.categoryCode, supplierId: input.supplierId, validFrom, validTo, source: 'MANUAL' } }],
    }
  },
})

export function createPreferredSupplier(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createPreferredSupplierCommand, input, options)
}

// ---------- preferredSupplier.end ----------

const EndInput = z.strictObject({ preferredSupplierId: z.uuid(), reason: Reason })

export const endPreferredSupplierCommand = defineCommand({
  name: 'preferredSupplier.end',
  capability: 'sourcing.preferred.manage',
  input: EndInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ preferredSupplierId: string }>> {
    // no module check: ending one only narrows what fills the form, which stays possible with SOURCING off (BR-RFX-16)
    const may = await authorize(tx, ctx, 'sourcing.preferred.manage')
    if (!may.ok) return { ok: false, error: may.error }
    const found = await tx.preferredSupplier.findFirst({ where: { id: input.preferredSupplierId }, select: { supplierId: true } })
    if (!found) return fail('NOT_FOUND', 'preferred supplier not found')
    await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [found.supplierId])
    const row = await tx.preferredSupplier.findUniqueOrThrow({ where: { id: input.preferredSupplierId } })
    if (row.endedAt) return fail('INVALID_STATE_TRANSITION', 'the preferred supplier was ended already', { reason: 'ALREADY_ENDED' })
    if (dayOf(row.validTo) <= agreementDay(ctx.now)) return fail('INVALID_STATE_TRANSITION', 'the preferred supplier is over already', { reason: 'EXPIRED' })
    await tx.preferredSupplier.update({ where: { id: row.id }, data: { endedAt: ctx.now, endedById: memberOf(ctx), endReason: input.reason } })
    return {
      ok: true,
      result: { preferredSupplierId: row.id },
      events: [{ type: 'preferred_supplier.ended', aggregateType: 'PreferredSupplier', aggregateId: row.id, data: { categoryCode: row.categoryCode, supplierId: row.supplierId, validTo: dayOf(row.validTo), reason: input.reason } }],
    }
  },
})

export function endPreferredSupplier(ctx: Ctx, input: z.input<typeof EndInput>, options: RunOptions) {
  return runCommand(ctx, endPreferredSupplierCommand, input, options)
}

// ---------- the expiry warning (job preferred-supplier-expiry) ----------

/**
 * Once a day for an organization with SOURCING on: every row in effect whose validTo is at most 30 days away and that was
 * not warned for this validTo yet → preferred_supplier.expiring and a DIGEST notice to PROCUREMENT. The row itself does
 * not change (whether it is in effect is read from the day). A row extended by an award is warned again before its new
 * end. NOT_FOUND when there is nothing to warn of (INV-EVT-02: no command succeeds without an event).
 */
export const remindPreferredExpiryCommand = defineCommand({
  name: 'preferredSupplier.remind_expiry',
  capability: 'sourcing.preferred.manage',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ warned: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'only the scheduled job warns of preferred suppliers ending')
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const today = agreementDay(ctx.now)
    const rows = await tx.preferredSupplier.findMany({
      where: { endedAt: null, validFrom: { lte: dateOf(today) }, validTo: { gt: dateOf(today), lte: dateOf(addDays(today, PREFERRED_EXPIRY_WARNING_DAYS)) } },
      orderBy: [{ validTo: 'asc' }, { categoryCode: 'asc' }],
      select: { id: true, categoryCode: true, supplierId: true, validTo: true, supplier: { select: { code: true, nameTh: true } }, awardDecision: { select: { number: true } } },
    })
    if (rows.length === 0) return fail('NOT_FOUND', 'no preferred supplier ends soon')
    const sent = await tx.event.findMany({ where: { type: 'preferred_supplier.expiring', aggregateType: 'PreferredSupplier', aggregateId: { in: rows.map((r) => r.id) } }, select: { aggregateId: true, data: true } })
    const warned = new Set(sent.map((e) => `${e.aggregateId}:${String((e.data as { validTo?: unknown }).validTo)}`))
    const due = rows.filter((r) => !warned.has(`${r.id}:${dayOf(r.validTo)}`))
    if (due.length === 0) return fail('NOT_FOUND', 'every warning due was sent already')
    const procurement = [...new Set((await tx.roleAssignment.findMany({ where: { role: 'PROCUREMENT', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })).map((r) => r.memberId))]
    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    for (const r of due) {
      const validTo = dayOf(r.validTo)
      events.push({ type: 'preferred_supplier.expiring', aggregateType: 'PreferredSupplier', aggregateId: r.id, data: { categoryCode: r.categoryCode, supplierId: r.supplierId, validTo } })
      const data = { preferredSupplierId: r.id, categoryCode: r.categoryCode, supplierCode: r.supplier.code, supplierName: r.supplier.nameTh, awardNumber: r.awardDecision?.number ?? null, validTo }
      for (const recipientMemberId of procurement) {
        notifications.push({ recipientMemberId, templateKey: 'preferred_supplier.expiring', data, urgency: 'DIGEST', dedupeKey: `preferred_supplier.expiring:${r.id}:${validTo}:${recipientMemberId}`, subjectType: 'PREFERRED_SUPPLIER', subjectId: r.id })
      }
    }
    return { ok: true, result: { warned: due.length }, events, notifications }
  },
})

/** What the job preferred-supplier-expiry runs for one organization on one day; the day is the idempotency key */
export function runPreferredSupplierExpiry(organizationId: string, now: Date) {
  return runCommand(systemCtx(organizationId, now, 'preferred-supplier-expiry'), remindPreferredExpiryCommand, {}, { idempotencyKey: `preferred-supplier-expiry:${agreementDay(now)}` })
}

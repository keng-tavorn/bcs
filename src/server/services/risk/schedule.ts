import { z } from 'zod'
import type { AppError } from '@/core/result'
import { addCalendarDays, riskStatusAt, type RiskTierCode } from '@/core/risk'
import { RISK_OVERRIDE_MACHINE, RISK_REVIEW_MACHINE, transition } from '@/core/state-machines'
import { dateIn } from '@/core/supplier-docs'
import { MS_PER_DAY } from '@/lib/constants'
import { systemCtx, type Ctx } from '@/server/context'
import { organizationsWithRisk } from '@/server/db/risk'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandDefinition, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { contextOf, createAssessment, inviteToAnswer, openAssessmentOf, refreshSupplierRisk, RISK_TIMEZONE } from './assessments'
import { questionnaireInEffect, supersedeDueQuestionnaires } from './questionnaire'
import { riskPolicyInEffect, riskTiersInEffect } from './tiers'

// Reassessment and the registry's flags (S11-09 · FR-RSK-205 · BR-RSK-12 BR-RSK-13 BR-RSK-14 · ADR-227):
// - risk-review-daily (07:15 Asia/Bangkok, every organization with RISK on, the day the idempotency key): a COMPLETED
//   assessment at its remindOn gets a RiskReview SCHEDULED and a new assessment opened for the supplier (its context
//   copied, certificates filling what they answer, the old answers not copied · OQ-226) with the reminder e-mail; an
//   APPROVED override within seven days of its last day is told to its requester and PROCUREMENT once, past it EXPIRED
//   (and a RiskReview OVERRIDE_EXPIRED when no valid assessment stands behind the supplier); a questionnaire version whose
//   time has come supersedes the one before; open reviews of a supplier no longer ACTIVE are cancelled; the suppliers
//   whose state moves with the day (CURRENT → EXPIRING → OVERDUE) get their projection and, overdue, PROCUREMENT's notice.
// - risk-status-changed (applyRiskRegistryFlag): a registry flag other than NONE opens a RiskReview STATUS_CHANGED and
//   puts the supplier in REASSESS_REQUIRED at once, NONE cancels it (BR-RSK-12). The one function the seed and the
//   trigger use; S11-19 [go-live] binds it to S9-14's supplier.registry_status_changed. S11 never sets registryFlag.
// Every change goes through runCommand as SYSTEM (system.risk) and checks RISK itself (BR-RSK-16).

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
/** Nothing to do for this subject today (the job's prefilter raced a command): no event, nothing kept */
const nothing = (why: string) => fail('VALIDATION_FAILED', 'nothing to do', { reason: why })

const iso = (d: Date) => d.toISOString().slice(0, 10)
/** The dueAt of a day: 17:30 Asia/Bangkok, the end of its working day (the RiskReview table of docs/sub-specs/S11.md) */
const endOfDay = (day: string) => new Date(`${day}T17:30:00+07:00`)
/** How many days before an override's last day its requester is told (the notices table: "จะหมดอายุใน 7 วัน") */
export const OVERRIDE_EXPIRY_NOTICE_DAYS = 7

async function procurementIds(tx: TenantTx): Promise<string[]> {
  const rows = await tx.roleAssignment.findMany({ where: { role: 'PROCUREMENT', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true }, distinct: ['memberId'], orderBy: { memberId: 'asc' } })
  return rows.map((r) => r.memberId)
}

async function onRisk(tx: TenantTx, ctx: Ctx): Promise<Fail | null> {
  const on = await requireModule(ctx, 'RISK', tx)
  return on.ok ? null : { ok: false, error: on.error }
}

type ReviewReason = 'SCHEDULED' | 'STATUS_CHANGED' | 'OVERRIDE_EXPIRED'
type Flag = 'CEASED' | 'VAT_CANCELLED' | 'NOT_FOUND'

interface Supplier {
  readonly id: string
  readonly code: string
  readonly status: string
  readonly riskTier: RiskTierCode | null
  readonly payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'
  readonly isForeign: boolean
  readonly portalEnabled: boolean
}
const SUPPLIER_SELECT = { id: true, code: true, status: true, riskTier: true, payeeType: true, isForeign: true, portalEnabled: true } as const

/** The supplier locked FOR UPDATE (the order of every command of S11 that opens or closes a supplier's reviews) */
async function lockedSupplier(tx: TenantTx, ctx: Ctx, supplierId: string): Promise<Supplier | null> {
  const [locked] = await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [supplierId])
  if (!locked) return null
  return (await tx.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: SUPPLIER_SELECT })) as Supplier
}

/**
 * A RiskReview OPEN of the reason (one per reason per supplier · risk_review_one_open), its event and PROCUREMENT's notice:
 * DIGEST in-app (risk.review_due), a registry flag at once by LINE then e-mail (risk.status_changed · BR-NOTI-12)
 */
async function openReview(
  tx: TenantTx,
  ctx: Ctx,
  supplier: Supplier,
  input: {
    reason: ReviewReason
    tier: RiskTierCode | null
    dueAt: Date
    sourceAssessmentId?: string
    sourceOverrideId?: string
    registryFlag?: Flag
    /** The assessment this command opened for the review (the event says so) */
    openedAssessmentId?: string | null
    /** The assessment the notice links to: the one opened, or the one already open */
    linkAssessmentId?: string | null
  },
): Promise<{ id: string; events: EventDraft[]; notifications: NotificationDraft[] }> {
  const row = await tx.riskReview.create({
    data: {
      organizationId: ctx.organizationId,
      supplierId: supplier.id,
      tier: input.tier,
      reason: input.reason,
      dueAt: input.dueAt,
      remindedAt: input.reason === 'SCHEDULED' ? ctx.now : null,
      sourceAssessmentId: input.sourceAssessmentId ?? null,
      sourceOverrideId: input.sourceOverrideId ?? null,
      registryFlag: input.registryFlag ?? null,
    },
    select: { id: true },
  })
  const flagged = input.reason === 'STATUS_CHANGED'
  const notifications: NotificationDraft[] = (await procurementIds(tx)).map((memberId) => ({
    recipientMemberId: memberId,
    templateKey: flagged ? 'risk.status_changed' : 'risk.review_due',
    data: { reviewId: row.id, supplierId: supplier.id, supplierCode: supplier.code, reason: input.reason, dueOn: dateIn(input.dueAt, RISK_TIMEZONE), tier: input.tier, registryFlag: input.registryFlag ?? null, to: flagged ? 'REASSESS_REQUIRED' : null, assessmentId: input.linkAssessmentId ?? input.openedAssessmentId ?? null },
    urgency: flagged ? 'IMMEDIATE' : 'DIGEST',
    dedupeKey: `risk.review:${row.id}:${memberId}`,
    subjectType: 'Supplier',
    subjectId: supplier.id,
  }))
  return {
    id: row.id,
    events: [
      {
        type: 'risk_review.scheduled',
        aggregateType: 'RiskReview',
        aggregateId: row.id,
        data: {
          supplierId: supplier.id,
          reason: input.reason,
          tier: input.tier,
          dueAt: input.dueAt.toISOString(),
          sourceAssessmentId: input.sourceAssessmentId ?? null,
          sourceOverrideId: input.sourceOverrideId ?? null,
          registryFlag: input.registryFlag ?? null,
          openedAssessmentId: input.openedAssessmentId ?? null,
        },
      },
    ],
    notifications,
  }
}

/**
 * Whether a new PO of the supplier is blocked once its assessment is OVERDUE (the gate's rule · BR-RSK-09 ข้อ 5): its tier
 * blocks POs, or it is MEDIUM and the policy blocks a lapsed MEDIUM (RiskPolicy.mediumOverdueBlocks)
 */
async function overdueBlocks(tx: TenantTx, tier: RiskTierCode | null): Promise<boolean> {
  if (!tier) return false
  const tiers = await riskTiersInEffect(tx)
  const policy = await riskPolicyInEffect(tx)
  const def = tiers.ok ? tiers.data.find((t) => t.code === tier) : undefined
  return Boolean(def?.blocksPo) || (tier === 'MEDIUM' && policy.ok && policy.data.mediumOverdueBlocks)
}

/**
 * The supplier's projection and, when it turned OVERDUE in this command (by this refresh or by one the command ran
 * before it, given as `earlier` — createAssessment refreshes too), the reviews past their dueAt (risk_review.overdue,
 * the state stays OPEN) and PROCUREMENT's DIGEST notice
 */
async function projectionOf(tx: TenantTx, ctx: Ctx, supplier: Supplier, earlier: readonly EventDraft[] = []): Promise<{ events: EventDraft[]; notifications: NotificationDraft[] }> {
  const events = await refreshSupplierRisk(tx, ctx, supplier.id)
  const changes = [...earlier, ...events].filter((e) => e.type === 'supplier.risk_status_changed')
  const to = (changes.at(-1)?.data as { to?: string } | undefined)?.to
  if (to !== 'OVERDUE') return { events, notifications: [] }
  const due = await tx.riskReview.findMany({ where: { supplierId: supplier.id, status: 'OPEN', dueAt: { lte: ctx.now } }, select: { id: true, status: true, dueAt: true }, orderBy: { id: 'asc' } })
  for (const r of due) {
    const t = transition(RISK_REVIEW_MACHINE, r.status, 'risk_review.overdue')
    if (t.ok) events.push({ type: 'risk_review.overdue', aggregateType: 'RiskReview', aggregateId: r.id, data: { dueAt: r.dueAt.toISOString() } })
  }
  const blocks = await overdueBlocks(tx, supplier.riskTier)
  const notifications: NotificationDraft[] = (await procurementIds(tx)).map((memberId) => ({
    recipientMemberId: memberId,
    templateKey: 'risk.status_changed',
    data: { supplierId: supplier.id, supplierCode: supplier.code, to, tier: supplier.riskTier, blocks },
    urgency: 'DIGEST',
    dedupeKey: `risk.status_changed:${supplier.id}:${to}:${dateIn(ctx.now, RISK_TIMEZONE)}:${memberId}`,
    subjectType: 'Supplier',
    subjectId: supplier.id,
  }))
  return { events, notifications }
}

// ---------- the reassessment at remindOn (BR-RSK-13 · FR-RSK-205 AC2) ----------

const scheduleCommand = defineCommand({
  name: 'riskReview.schedule',
  capability: 'system.risk',
  input: z.strictObject({ assessmentId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ reviewId: string; openedAssessmentId: string | null }>> {
    const off = await onRisk(tx, ctx)
    if (off) return off
    const head = await tx.riskAssessment.findFirst({ where: { id: input.assessmentId }, select: { supplierId: true } })
    if (!head) return fail('NOT_FOUND', 'assessment not found')
    const supplier = await lockedSupplier(tx, ctx, head.supplierId)
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    const a = await tx.riskAssessment.findUniqueOrThrow({
      where: { id: input.assessmentId },
      select: { id: true, status: true, tier: true, validUntil: true, remindOn: true, screening: true, categoryCodes: true, payeeType: true, workScopes: true, openedById: true },
    })
    const today = dateIn(ctx.now, RISK_TIMEZONE)
    if (a.status !== 'COMPLETED' || !a.remindOn || !a.validUntil || iso(a.remindOn) > today) return nothing('NOT_DUE')
    if (supplier.status !== 'ACTIVE') return nothing('SUPPLIER_INACTIVE')
    if (await tx.riskReview.findFirst({ where: { supplierId: supplier.id, reason: 'SCHEDULED', status: 'OPEN' }, select: { id: true } })) return nothing('REVIEW_OPEN')
    // once per completed assessment: a review of it DONE, or cancelled by a person, is not opened again; one the job
    // cancelled while the supplier was not ACTIVE is, once the supplier is ACTIVE again
    const before = await tx.riskReview.findFirst({ where: { sourceAssessmentId: a.id, reason: 'SCHEDULED', NOT: { status: 'CANCELLED', cancelReason: 'SUPPLIER_INACTIVE' } }, select: { id: true } })
    if (before) return nothing('REVIEWED')

    // the new assessment, unless one is open already (INV-RSK-02): the old one's work, the version and policy of today
    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    const outbox: OutboxDraft[] = []
    let openedAssessmentId: string | null = null
    const open = await openAssessmentOf(tx, supplier.id)
    if (open) {
      // the open one is what the supplier answers: the reminder e-mail names it (a new link)
      if (open.status === 'DRAFT' || open.status === 'RETURNED') {
        const invite = await inviteToAnswer(tx, ctx, { assessmentId: open.id, number: open.number ?? '', supplierId: supplier.id, portalEnabled: supplier.portalEnabled, memberId: null, reminder: true })
        events.push(...invite.events)
        notifications.push(...invite.notifications)
        outbox.push(...invite.outbox)
      }
    } else {
      const questionnaire = await questionnaireInEffect(tx, ctx.now)
      const policy = await riskPolicyInEffect(tx)
      // no version or policy in effect: the review still stands and PROCUREMENT opens the assessment once they are
      if (questionnaire && policy.ok) {
        const context = contextOf({ screening: a.screening, categoryCodes: a.categoryCodes, payeeType: supplier.payeeType, supplier })
        const opened = await createAssessment(tx, ctx, {
          supplier,
          context,
          questionnaire,
          policy: policy.data,
          workScopes: a.workScopes,
          // who opened the one it renews owns the new one (the opener never reviews it · BR-SOD-16)
          openedById: a.openedById,
          triggerRequestId: null,
          triggerPoId: null,
          reminder: true,
        })
        openedAssessmentId = opened.result.assessmentId
        events.push(...opened.events)
        notifications.push(...opened.notifications)
        outbox.push(...opened.outbox)
      }
    }
    const review = await openReview(tx, ctx, supplier, { reason: 'SCHEDULED', tier: a.tier as RiskTierCode | null, dueAt: endOfDay(iso(a.validUntil)), sourceAssessmentId: a.id, openedAssessmentId, linkAssessmentId: openedAssessmentId ?? open?.id ?? null })
    // the day may already be past validUntil (a job that missed days): the refresh inside createAssessment saw it first
    const projection = await projectionOf(tx, ctx, supplier, events)
    return {
      ok: true,
      result: { reviewId: review.id, openedAssessmentId },
      events: [...review.events, ...events, ...projection.events],
      notifications: [...review.notifications, ...notifications, ...projection.notifications],
      outbox,
    }
  },
})

// ---------- an override's last day (BR-RSK-10 · FR-RSK-203 AC3) ----------

const overrideNotices = async (tx: TenantTx, row: { id: string; number: string | null; requestedById: string; expiresOn: Date }, expired: boolean): Promise<NotificationDraft[]> =>
  [...new Set([row.requestedById, ...(await procurementIds(tx))])].map((memberId) => ({
    recipientMemberId: memberId,
    templateKey: 'risk.override_expiring',
    data: { overrideId: row.id, number: row.number, expiresOn: iso(row.expiresOn), expired },
    urgency: 'DIGEST',
    dedupeKey: `risk.override_expiring:${row.id}:${expired ? 'EXPIRED' : 'SOON'}:${memberId}`,
    subjectType: 'RISK_OVERRIDE',
    subjectId: row.id,
  }))

const OVERRIDE_SELECT = { id: true, number: true, status: true, supplierId: true, requestedById: true, expiresOn: true, usedCount: true, usedGrossSatang: true } as const

const remindExpiryCommand = defineCommand({
  name: 'riskOverride.remindExpiry',
  capability: 'system.risk',
  input: z.strictObject({ overrideId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ daysLeft: number }>> {
    const off = await onRisk(tx, ctx)
    if (off) return off
    await lockRowsForUpdate(tx, 'RiskOverride', ctx.organizationId, [input.overrideId])
    const row = await tx.riskOverride.findFirst({ where: { id: input.overrideId }, select: OVERRIDE_SELECT })
    if (!row) return fail('NOT_FOUND', 'risk override not found')
    const today = dateIn(ctx.now, RISK_TIMEZONE)
    const last = iso(row.expiresOn)
    if (row.status !== 'APPROVED' || last < today || last > addCalendarDays(today, OVERRIDE_EXPIRY_NOTICE_DAYS)) return nothing('NOT_EXPIRING')
    // told once, whichever of the seven days the job first saw it
    if ((await tx.event.count({ where: { aggregateId: row.id, type: 'risk_override.expiring' } })) > 0) return nothing('TOLD')
    const daysLeft = Math.round((Date.parse(last) - Date.parse(today)) / MS_PER_DAY)
    return {
      ok: true,
      result: { daysLeft },
      events: [{ type: 'risk_override.expiring', aggregateType: 'RiskOverride', aggregateId: row.id, data: { number: row.number, expiresOn: last, daysLeft } }],
      notifications: await overrideNotices(tx, row, false),
    }
  },
})

const expireCommand = defineCommand({
  name: 'riskOverride.expire',
  capability: 'system.risk',
  input: z.strictObject({ overrideId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ reviewId: string | null }>> {
    const off = await onRisk(tx, ctx)
    if (off) return off
    const head = await tx.riskOverride.findFirst({ where: { id: input.overrideId }, select: { supplierId: true } })
    if (!head) return fail('NOT_FOUND', 'risk override not found')
    // the supplier first, then the override (every command of S11 that opens a supplier's reviews locks the supplier)
    const supplier = await lockedSupplier(tx, ctx, head.supplierId)
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    await lockRowsForUpdate(tx, 'RiskOverride', ctx.organizationId, [input.overrideId])
    const row = await tx.riskOverride.findUniqueOrThrow({ where: { id: input.overrideId }, select: OVERRIDE_SELECT })
    const today = dateIn(ctx.now, RISK_TIMEZONE)
    if (row.status !== 'APPROVED' || iso(row.expiresOn) >= today) return nothing('NOT_EXPIRED')
    const t = transition(RISK_OVERRIDE_MACHINE, row.status, 'riskOverride.expire')
    if (!t.ok) return fail('INVALID_STATE_TRANSITION', `riskOverride.expire is not allowed from ${row.status}`, { from: row.status })
    await tx.riskOverride.update({ where: { id: row.id }, data: { status: t.to, version: { increment: 1 } } })
    const events: EventDraft[] = []
    const notifications = await overrideNotices(tx, row, true)
    const outbox: OutboxDraft[] = []
    // no valid assessment behind the supplier: a reassessment is due (BR-RSK-10 · the RiskOverride table)
    const current = await tx.riskAssessment.findFirst({ where: { supplierId: supplier.id, status: 'COMPLETED' }, select: { validUntil: true } })
    const valid = current?.validUntil ? iso(current.validUntil) >= today : false
    let reviewId: string | null = null
    if (!valid && supplier.status === 'ACTIVE' && !(await tx.riskReview.findFirst({ where: { supplierId: supplier.id, reason: 'OVERRIDE_EXPIRED', status: 'OPEN' }, select: { id: true } }))) {
      const open = await openAssessmentOf(tx, supplier.id)
      const review = await openReview(tx, ctx, supplier, { reason: 'OVERRIDE_EXPIRED', tier: supplier.riskTier, dueAt: endOfDay(iso(row.expiresOn)), sourceOverrideId: row.id, openedAssessmentId: null, linkAssessmentId: open?.id ?? null })
      reviewId = review.id
      events.push(...review.events)
      notifications.push(...review.notifications)
      // the supplier answers the assessment open now, if any (supplier.risk_reminder · the notices table)
      if (open && (open.status === 'DRAFT' || open.status === 'RETURNED')) {
        const invite = await inviteToAnswer(tx, ctx, { assessmentId: open.id, number: open.number ?? '', supplierId: supplier.id, portalEnabled: supplier.portalEnabled, memberId: null, reminder: true })
        events.push(...invite.events)
        notifications.push(...invite.notifications)
        outbox.push(...invite.outbox)
      }
    }
    const projection = await projectionOf(tx, ctx, supplier)
    return {
      ok: true,
      result: { reviewId },
      events: [
        { type: 'risk_override.expired', aggregateType: 'RiskOverride', aggregateId: row.id, data: { number: row.number, expiresOn: iso(row.expiresOn), usedCount: row.usedCount, usedGrossSatang: row.usedGrossSatang.toString(), reviewScheduled: reviewId !== null } },
        ...events,
        ...projection.events,
      ],
      notifications: [...notifications, ...projection.notifications],
      outbox,
    }
  },
})

// ---------- reviews of a supplier no longer ACTIVE (the RiskReview table: OPEN → CANCELLED) ----------

const cancelInactiveCommand = defineCommand({
  name: 'risk_review.cancel_inactive',
  capability: 'system.risk',
  input: z.strictObject({ supplierId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ cancelled: number }>> {
    const off = await onRisk(tx, ctx)
    if (off) return off
    const supplier = await lockedSupplier(tx, ctx, input.supplierId)
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    if (supplier.status === 'ACTIVE') return nothing('SUPPLIER_ACTIVE')
    const events = await cancelReviews(tx, supplier.id, { status: 'OPEN' }, 'SUPPLIER_INACTIVE')
    if (events.length === 0) return nothing('NO_OPEN_REVIEW')
    events.push(...(await refreshSupplierRisk(tx, ctx, supplier.id)))
    return { ok: true, result: { cancelled: events.filter((e) => e.type === 'risk_review.cancelled').length }, events }
  },
})

async function cancelReviews(tx: TenantTx, supplierId: string, where: { status: 'OPEN'; reason?: ReviewReason }, why: 'SUPPLIER_INACTIVE' | 'REGISTRY_CLEARED'): Promise<EventDraft[]> {
  const rows = await tx.riskReview.findMany({ where: { supplierId, ...where }, select: { id: true, status: true }, orderBy: { id: 'asc' } })
  const events: EventDraft[] = []
  for (const r of rows) {
    const t = transition(RISK_REVIEW_MACHINE, r.status, 'riskReview.cancel')
    if (!t.ok) continue
    await tx.riskReview.update({ where: { id: r.id }, data: { status: t.to, cancelReason: why } })
    events.push({ type: 'risk_review.cancelled', aggregateType: 'RiskReview', aggregateId: r.id, data: { reason: why } })
  }
  return events
}

// ---------- the state of the day (BR-RSK-13 BR-RSK-14) ----------

const refreshCommand = defineCommand({
  name: 'supplierRisk.refresh',
  capability: 'system.risk',
  input: z.strictObject({ supplierId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ status: string }>> {
    const off = await onRisk(tx, ctx)
    if (off) return off
    const supplier = await lockedSupplier(tx, ctx, input.supplierId)
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    const projection = await projectionOf(tx, ctx, supplier)
    if (projection.events.length === 0) return nothing('UNCHANGED')
    const now = await tx.supplier.findUniqueOrThrow({ where: { id: supplier.id }, select: { riskStatus: true } })
    return { ok: true, result: { status: now.riskStatus }, events: projection.events, notifications: projection.notifications }
  },
})

// ---------- the daily run ----------

export interface RiskReviewDailyResult {
  readonly questionnairesSuperseded: number
  readonly overridesExpiring: number
  readonly overridesExpired: number
  readonly reviewsScheduled: number
  readonly reviewsCancelled: number
  readonly suppliersRefreshed: number
}

/**
 * risk-review-daily for one organization on the day of `now` (Asia/Bangkok): each subject a command of its own with the
 * day (or the subject alone, for what happens once) as its idempotency key, so a run again the same day does nothing more
 */
export async function runRiskReviewDaily(organizationId: string, now: Date, options: Pick<RunOptions, 'sender'> = {}): Promise<RiskReviewDailyResult> {
  const ctx = systemCtx(organizationId, now, 'risk-review-daily')
  const db = forTenant(organizationId)
  const today = dateIn(now, RISK_TIMEZONE)
  const run = <I, R>(command: CommandDefinition<I, R>, input: I, key: string) => runCommand(ctx, command, input, { idempotencyKey: `risk-review-daily:${key}`, ...options })

  const questionnairesSuperseded = await supersedeDueQuestionnaires(organizationId, now)

  let overridesExpiring = 0
  let overridesExpired = 0
  const approved = await db.riskOverride.findMany({ where: { status: 'APPROVED' }, select: { id: true, expiresOn: true }, orderBy: { id: 'asc' } })
  for (const o of approved) {
    const last = iso(o.expiresOn)
    if (last < today) {
      if ((await run(expireCommand, { overrideId: o.id }, `expire:${o.id}`)).ok) overridesExpired++
    } else if (last <= addCalendarDays(today, OVERRIDE_EXPIRY_NOTICE_DAYS)) {
      // once per override, whichever day of the seven the job first sees it
      if ((await run(remindExpiryCommand, { overrideId: o.id }, `expiring:${today}:${o.id}`)).ok) overridesExpiring++
    }
  }

  let reviewsCancelled = 0
  const inactive = await db.riskReview.findMany({ where: { status: 'OPEN', supplier: { status: { not: 'ACTIVE' } } }, select: { supplierId: true }, distinct: ['supplierId'], orderBy: { supplierId: 'asc' } })
  for (const r of inactive) {
    const done = await run(cancelInactiveCommand, { supplierId: r.supplierId }, `cancel:${today}:${r.supplierId}`)
    if (done.ok) reviewsCancelled += done.data.cancelled
  }

  let reviewsScheduled = 0
  const due = await db.riskAssessment.findMany({
    where: { status: 'COMPLETED', remindOn: { lte: new Date(`${today}T00:00:00Z`) }, supplier: { status: 'ACTIVE', riskReviews: { none: { reason: 'SCHEDULED', status: 'OPEN' } } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  for (const a of due) if ((await run(scheduleCommand, { assessmentId: a.id }, `schedule:${today}:${a.id}`)).ok) reviewsScheduled++

  // the state of the day where it moves: CURRENT → EXPIRING at remindOn (a review opened above already did it), EXPIRING
  // → OVERDUE after validUntil; IN_PROGRESS of a supplier assessed before is the rule before S11-09, corrected here
  let suppliersRefreshed = 0
  const assessed = await db.supplier.findMany({
    where: { riskStatus: { in: ['CURRENT', 'EXPIRING', 'IN_PROGRESS'] }, currentRiskAssessment: { isNot: null } },
    select: { id: true, riskStatus: true, currentRiskAssessment: { select: { validUntil: true, remindOn: true } } },
    orderBy: { id: 'asc' },
  })
  for (const s of assessed) {
    const c = s.currentRiskAssessment
    if (!c?.validUntil || !c.remindOn) continue
    if (riskStatusAt({ validUntil: iso(c.validUntil), remindOn: iso(c.remindOn), today }) === s.riskStatus) continue
    if ((await run(refreshCommand, { supplierId: s.id }, `refresh:${today}:${s.id}`)).ok) suppliersRefreshed++
  }
  return { questionnairesSuperseded, overridesExpiring, overridesExpired, reviewsScheduled, reviewsCancelled, suppliersRefreshed }
}

/** The organizations risk-review-daily runs for (RISK on): one step each in the job */
export const riskReviewOrganizations = (): Promise<string[]> => organizationsWithRisk()

// ---------- the registry's flag (BR-RSK-12 · FR-RSK-205 AC3 · job risk-status-changed) ----------

const registryCommand = defineCommand({
  name: 'riskReview.registryFlag',
  capability: 'system.risk',
  input: z.strictObject({ supplierId: z.uuid(), flag: z.enum(['NONE', 'CEASED', 'VAT_CANCELLED', 'NOT_FOUND']) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ reviewId: string | null; cancelled: number }>> {
    const off = await onRisk(tx, ctx)
    if (off) return off
    const supplier = await lockedSupplier(tx, ctx, input.supplierId)
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    const open = await tx.riskReview.findFirst({ where: { supplierId: supplier.id, reason: 'STATUS_CHANGED', status: 'OPEN' }, select: { id: true, registryFlag: true } })
    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    let reviewId: string | null = null
    let cancelled = 0
    if (input.flag === 'NONE') {
      // the flag cleared: the review it opened is no longer due (BR-RSK-12)
      if (!open) return nothing('NO_OPEN_REVIEW')
      const closed = await cancelReviews(tx, supplier.id, { status: 'OPEN', reason: 'STATUS_CHANGED' }, 'REGISTRY_CLEARED')
      cancelled = closed.length
      events.push(...closed)
    } else {
      // one open per supplier: a second flag while one is open changes nothing (the first is still to be reassessed)
      if (open) return nothing('REVIEW_OPEN')
      const review = await openReview(tx, ctx, supplier, { reason: 'STATUS_CHANGED', tier: supplier.riskTier, dueAt: ctx.now, registryFlag: input.flag })
      reviewId = review.id
      events.push(...review.events)
      notifications.push(...review.notifications)
    }
    events.push(...(await refreshSupplierRisk(tx, ctx, supplier.id)))
    return { ok: true, result: { reviewId, cancelled }, events, notifications }
  },
})

/**
 * The supplier's registry flag became `flag` (S9-14's supplier.registry_status_changed through job risk-status-changed in
 * S11-19 · the seed's flags in the demo tier): a flag opens a RiskReview STATUS_CHANGED and REASSESS_REQUIRED, NONE cancels it
 */
export async function applyRiskRegistryFlag(organizationId: string, supplierId: string, flag: 'NONE' | Flag, now: Date, options: Partial<RunOptions> = {}) {
  return runCommand(systemCtx(organizationId, now, 'risk-status-changed'), registryCommand, { supplierId, flag }, { idempotencyKey: `risk-status-changed:${supplierId}:${flag}:${now.toISOString()}`, ...options })
}

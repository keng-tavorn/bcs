import { z } from 'zod'
import { RETENTION_MACHINE, transition, type RetentionState } from '@/core/state-machines'
import { taxDateOf } from '@/core/vat'
import { MS_PER_DAY } from '@/lib/constants'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { dueRetentions } from '@/server/db/sql/retentions'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { fail, type Fail } from './common'
import { holdDaysOf } from './milestones'

// Performance retention (ADR-124, BR-RET-03, BR-RET-04, FR-AP-106 AC3 AC4): an invoice with retention leaves a Retention
// HELD when it is ready for payment; its due date is set when the PO's last milestone is received — the posting time of
// that goods receipt (OQ-170, not the phone's clock) plus the PO's hold days. FINANCE releases it from that day
// (RELEASABLE; before → RETENTION_NOT_DUE); the job retention-due tells FINANCE once when the day comes. S9 pays a
// RELEASABLE retention like an invoice, through holdRetentionsForPayment, releaseRetentionsFromPayment and
// recordInvoicePayment. A retention moves no budget: the whole invoice was actualized when it was ready.

const dayAfter = (at: Date, days: number) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) + days * MS_PER_DAY)

/** The due date of a PO's retentions: its last goods receipt's posting day (Thai calendar) plus the hold days; null until it is received in full */
async function dueDateOf(tx: TenantTx, poId: string): Promise<Date | null> {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { status: true, retentionHoldDays: true } })
  if (po.status !== 'RECEIVED' && po.status !== 'CLOSED') return null
  const last = await tx.goodsReceipt.findFirst({ where: { poId, status: 'POSTED' }, orderBy: { postedAt: 'desc' }, select: { postedAt: true } })
  if (!last?.postedAt) return null
  return dayAfter(new Date(`${taxDateOf(last.postedAt)}T00:00:00Z`), holdDaysOf(po))
}

/** When an invoice with retention becomes ready (match or variance approval): its Retention, HELD */
export async function holdRetentionOfInvoice(tx: TenantTx, ctx: Ctx, invoice: { readonly id: string; readonly poId: string; readonly supplierId: string; readonly retentionSatang: bigint }): Promise<EventDraft[]> {
  if (invoice.retentionSatang === 0n) return []
  const releaseDueOn = await dueDateOf(tx, invoice.poId)
  const row = await tx.retention.create({ data: { organizationId: ctx.organizationId, invoiceId: invoice.id, poId: invoice.poId, supplierId: invoice.supplierId, amountSatang: invoice.retentionSatang, releaseDueOn }, select: { id: true } })
  return [{ type: 'retention.held', aggregateType: 'Retention', aggregateId: row.id, data: { invoiceId: invoice.id, amountSatang: invoice.retentionSatang.toString(), releaseDueOn: releaseDueOn?.toISOString().slice(0, 10) ?? null } }]
}

/** gr.post: when the PO is received in full, its HELD retentions get their due date (BR-RET-04) */
export async function setRetentionsDue(tx: TenantTx, poId: string): Promise<void> {
  const due = await dueDateOf(tx, poId)
  if (due) await tx.retention.updateMany({ where: { poId, status: 'HELD', releaseDueOn: null }, data: { releaseDueOn: due } })
}

// ---------- retention.release (FINANCE) ----------

const ReleaseInput = z.strictObject({ retentionId: z.uuid(), version: z.number().int().min(0) })

export const releaseRetentionCommand = defineCommand({
  name: 'retention.release',
  capability: 'retention.release',
  input: ReleaseInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ retentionId: string }>> {
    const allowed = await authorize(tx, ctx, 'retention.release')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return { ok: false, error: pay.error }
    const [id] = await lockRowsForUpdate(tx, 'Retention', ctx.organizationId, [input.retentionId])
    if (!id) return fail('NOT_FOUND', 'retention not found')
    const retention = await tx.retention.findUniqueOrThrow({ where: { id } })
    const moved = transition(RETENTION_MACHINE, retention.status as RetentionState, 'retention.release')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `retention.release is not allowed from ${retention.status}`, { from: retention.status, command: 'retention.release' })
    if (retention.version !== input.version) return fail('CONFLICT_VERSION', 'the retention changed since it was read', { version: retention.version })
    const today = taxDateOf(ctx.now)
    const due = retention.releaseDueOn?.toISOString().slice(0, 10) ?? null
    if (!due || today < due) return fail('RETENTION_NOT_DUE', 'the retention is not due yet', { date: due ?? '-' })
    await tx.retention.update({ where: { id }, data: { status: moved.to, releasedById: allowed.data.memberId, releasedAt: ctx.now, version: { increment: 1 } } })
    return { ok: true, result: { retentionId: id }, events: [{ type: 'retention.released', aggregateType: 'Retention', aggregateId: id, data: { invoiceId: retention.invoiceId, amountSatang: retention.amountSatang.toString(), releaseDueOn: due } }] }
  },
})

// ---------- retention-due (the job) ----------

const RETENTION_DUE_BATCH = 200
const DueInput = z.strictObject({ retentionIds: z.array(z.uuid()).min(1).max(RETENTION_DUE_BATCH) })

/** SYSTEM marks retentions whose day has come, once each, and FINANCE hears of them in the digest */
export const markRetentionsDueCommand = defineCommand({
  name: 'retention.mark_due',
  capability: 'retention.release',
  input: DueInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ marked: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'the job marks retentions due')
    const today = taxDateOf(ctx.now)
    const rows = await tx.retention.findMany({ where: { id: { in: input.retentionIds }, status: 'HELD', releaseDueOn: { lte: new Date(`${today}T00:00:00Z`) } }, select: { id: true, invoiceId: true, amountSatang: true, releaseDueOn: true } })
    const told = await tx.event.findMany({ where: { type: 'retention.release_due', aggregateId: { in: rows.map((r) => r.id) } }, select: { aggregateId: true } })
    const fresh = rows.filter((r) => !told.some((t) => t.aggregateId === r.id))
    if (fresh.length === 0) return fail('CONFLICT_VERSION', 'nothing is newly due', { reason: 'NOTHING_DUE' })
    const finance = await tx.roleAssignment.findMany({ where: { role: 'FINANCE', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true }, distinct: ['memberId'] })
    const events: EventDraft[] = fresh.map((r) => ({ type: 'retention.release_due', aggregateType: 'Retention', aggregateId: r.id, data: { invoiceId: r.invoiceId, amountSatang: r.amountSatang.toString(), releaseDueOn: r.releaseDueOn!.toISOString().slice(0, 10) } }))
    const notifications: NotificationDraft[] = finance.flatMap((f) => fresh.map((r) => ({ recipientMemberId: f.memberId, templateKey: 'retention.due', data: { retentionId: r.id, amountSatang: r.amountSatang.toString() }, urgency: 'DIGEST' as const, dedupeKey: `retention.due:${r.id}:${f.memberId}`, subjectType: 'RETENTION', subjectId: r.id })))
    return { ok: true, result: { marked: fresh.length }, events, notifications }
  },
})

/** Job retention-due (daily 08:00): every organization's retentions whose day has come */
export async function markDueRetentions(now: Date): Promise<number> {
  let marked = 0
  const due = await dueRetentions(new Date(`${taxDateOf(now)}T00:00:00Z`))
  const byOrg = new Map<string, string[]>()
  for (const r of due) byOrg.set(r.organizationId, [...(byOrg.get(r.organizationId) ?? []), r.id])
  for (const [organizationId, ids] of byOrg) {
    // in batches the command takes, every one of them each day
    for (let from = 0; from < ids.length; from += RETENTION_DUE_BATCH) {
      const batch = ids.slice(from, from + RETENTION_DUE_BATCH)
      const r = await runCommand(systemCtx(organizationId, now, 'retention-due'), markRetentionsDueCommand, { retentionIds: batch }, { idempotencyKey: `retention-due:${taxDateOf(now)}:${organizationId}:${batch[0]}` })
      if (r.ok) marked += r.data.marked
    }
  }
  return marked
}

// ---------- what S9 does to retentions (ADR-127, BR-AP-12) ----------

type Moved = { ok: true; events: EventDraft[] } | Fail

async function lockRetentions(tx: TenantTx, ctx: Ctx, retentionIds: readonly string[], command: 'retention.hold_for_payment' | 'retention.release_from_payment' | 'retention.record_payment') {
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false as const, error: pay.error }
  const ids = [...new Set(retentionIds)].sort()
  if (ids.length === 0 || ids.length !== retentionIds.length) return fail('VALIDATION_FAILED', 'name each retention once', { field: 'retentionIds', reason: ids.length ? 'TWICE' : 'REQUIRED' })
  const locked = await lockRowsForUpdate(tx, 'Retention', ctx.organizationId, ids)
  if (locked.length !== ids.length) return fail('NOT_FOUND', 'retention not found')
  const rows = await tx.retention.findMany({ where: { id: { in: ids } }, include: { invoice: { select: { number: true } } }, orderBy: { id: 'asc' } })
  for (const r of rows) if (!transition(RETENTION_MACHINE, r.status as RetentionState, command).ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${r.status}`, { from: r.status, command, retentionId: r.id })
  return { ok: true as const, rows }
}
export { lockRetentions }

export async function holdRetentionsForPayment(tx: TenantTx, ctx: Ctx, input: { readonly retentionIds: readonly string[]; readonly paymentRunId: string }): Promise<Moved> {
  const locked = await lockRetentions(tx, ctx, input.retentionIds, 'retention.hold_for_payment')
  if (!locked.ok) return locked
  await tx.retention.updateMany({ where: { id: { in: locked.rows.map((r) => r.id) } }, data: { status: 'IN_PAYMENT_RUN', version: { increment: 1 } } })
  return { ok: true, events: locked.rows.map((r) => ({ type: 'retention.payment_held', aggregateType: 'Retention', aggregateId: r.id, data: { paymentRunId: input.paymentRunId } })) }
}

export async function releaseRetentionsFromPayment(tx: TenantTx, ctx: Ctx, input: { readonly retentionIds: readonly string[]; readonly reason: string }): Promise<Moved> {
  if (!input.reason.trim()) return fail('VALIDATION_FAILED', 'a reason is needed', { field: 'reason', reason: 'REQUIRED' })
  const locked = await lockRetentions(tx, ctx, input.retentionIds, 'retention.release_from_payment')
  if (!locked.ok) return locked
  await tx.retention.updateMany({ where: { id: { in: locked.rows.map((r) => r.id) } }, data: { status: 'RELEASABLE', version: { increment: 1 } } })
  return { ok: true, events: locked.rows.map((r) => ({ type: 'retention.payment_released', aggregateType: 'Retention', aggregateId: r.id, data: { reason: input.reason.trim() } })) }
}

export function releaseRetention(ctx: Ctx, input: z.input<typeof ReleaseInput>, options: RunOptions) {
  return runCommand(ctx, releaseRetentionCommand, input, options)
}

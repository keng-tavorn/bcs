import { z } from 'zod'
import { consolidate } from '@/core/consolidation'
import { documentTotals, lineNet } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { latestSlot, localDay, parseCron } from '@/core/schedule'
import { rateFor, taxDateOf } from '@/core/vat'
import { newId } from '@/lib/ids'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { draftBlock, freeLines, POOL_REQUEST_STATUSES, releasableFor, type FreeLine } from './pool'
import { defaultRetentionOf } from '../ap/milestones'

// The consolidation round (spec §7.10, BR-CONS-01 to BR-CONS-05, FR-P2P-002): the free request lines PROCUREMENT has
// chosen a supplier for become draft POs, one per (supplier, delivery site, goods or service) and in the order of
// request number then line number (core/consolidation). Lines of an urgent request do not wait for the round: they
// make their own drafts as soon as their supplier is chosen (BR-CONS-02). A round runs on the organization's cron
// (settings consolidation.cron, OQ-13 default on business days), by hand ("รวมตอนนี้"), or for an urgent request, and
// is recorded as a ConsolidationRun even when it drafts nothing.
//
// A draft orders all that is left of each line at the request's unit price, which is before VAT; each PO line keeps its
// source request line with what it gives back when the PO is approved (PoLineSource, BR-BUD-05, BR-CONS-04). The VAT
// of the draft uses today's rate for display; the PO takes its rate again when it is sent for approval (§6.4). Lines of
// a request whose prices include VAT are never drafted: they stay in the pool, with the reason shown, until the user
// decides how such prices become PO lines (draftBlock, NEW-50) — so no PO amount differs from what was approved.

export type ConsolidationTrigger = 'SCHEDULED' | 'MANUAL' | 'URGENT'

export interface ConsolidationOutcome {
  readonly runId: string
  readonly purchaseOrderIds: readonly string[]
  readonly events: readonly EventDraft[]
}

/** Requests in the pool that have lines with a supplier, locked in id order so two rounds never order a line twice */
async function lockPoolRequests(tx: TenantTx, ctx: Ctx, requestIds?: readonly string[]): Promise<string[]> {
  const candidates = await tx.request.findMany({
    where: {
      documentType: 'PURCHASE_REQUEST',
      status: { in: [...POOL_REQUEST_STATUSES] },
      lines: { some: { supplierId: { not: null } } },
      ...(requestIds ? { id: { in: [...requestIds] } } : {}),
    },
    select: { id: true },
  })
  return lockRowsForUpdate(
    tx,
    'Request',
    ctx.organizationId,
    candidates.map((c) => c.id),
  )
}

/** Drafts the POs of one round inside the caller's transaction (the caller has locked nothing yet) */
export async function consolidateInTx(
  tx: TenantTx,
  ctx: Ctx,
  options: { trigger: ConsolidationTrigger; scheduledFor?: Date | null; requestIds?: readonly string[] },
): Promise<ConsolidationOutcome> {
  const locked = await lockPoolRequests(tx, ctx, options.requestIds)
  // TODO(NEW-50): lines of a request whose prices include VAT wait in the pool
  const lines = locked.length ? (await freeLines(tx, { requestIds: locked, withSupplierOnly: true })).filter((l) => draftBlock(l) === null) : []
  const byId = new Map(lines.map((l) => [l.requestLineId, l]))
  const grouped = consolidate(
    lines.map((l) => ({ ref: l.requestLineId, requestNo: l.requestNo, lineNo: l.lineNo, supplierId: l.supplierId, siteId: l.deliverySiteId, kind: l.kind, urgent: l.urgent })),
  )
  // An urgent round drafts only what does not wait; the other rounds draft everything ready (urgent lines too)
  const groups = options.trigger === 'URGENT' ? grouped.immediate : [...grouped.cycleGroups, ...grouped.immediate]
  const rate = rateFor(taxDateOf(ctx.now), await listTaxRates())
  const rateBp = rate.ok ? rate.rateBp : null
  const runId = newId()
  const drafts = groups.map((refs) => ({ id: newId(), lines: refs.map((ref) => byId.get(ref)!) }))
  await tx.consolidationRun.create({
    data: {
      id: runId,
      organizationId: ctx.organizationId,
      trigger: options.trigger,
      scheduledFor: options.scheduledFor ?? null,
      ranAt: ctx.now,
      status: 'COMPLETED',
      createdPoIds: drafts.map((d) => d.id),
      triggeredById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
    },
  })
  const events: EventDraft[] = []
  for (const draft of drafts) events.push(await createDraft(tx, ctx, draft.id, draft.lines, { rateBp, runId, via: 'CONSOLIDATION' }))
  events.push({
    type: 'consolidation_run.completed',
    aggregateType: 'ConsolidationRun',
    aggregateId: runId,
    data: {
      trigger: options.trigger,
      scheduledFor: options.scheduledFor?.toISOString() ?? null,
      purchaseOrderIds: drafts.map((d) => d.id),
      lineCount: drafts.reduce((n, d) => n + d.lines.length, 0),
    },
  })
  return { runId, purchaseOrderIds: drafts.map((d) => d.id), events }
}

/** One draft PO for one group of free lines (same supplier, site and kind) */
async function createDraft(
  tx: TenantTx,
  ctx: Ctx,
  poId: string,
  lines: readonly FreeLine[],
  options: { rateBp: number | null; runId: string | null; via: 'CONSOLIDATION' | 'MANUAL' },
): Promise<EventDraft> {
  const first = lines[0]!
  // A draft is priced before VAT at the request's own unit price: a price that includes VAT never gets here, or the
  // PO would need a unit price rounded outside BR-MONEY-02 (NEW-50)
  if (lines.some((l) => l.priceIncludesVat)) throw new Error('a line whose price includes VAT is never put on a draft PO (NEW-50)')
  const poLines = lines.map((l, i) => {
    const quantity = formatQuantity(l.free)
    return { id: newId(), line: l, lineNo: i + 1, quantity, netSatang: lineNet(quantity, l.unitPriceSatang) }
  })
  const totals = documentTotals(
    poLines.map((p) => ({ quantity: p.quantity, unitPriceSatang: p.line.unitPriceSatang, vatable: p.line.vatable })),
    options.rateBp ?? 0,
    false,
  )
  // S8-09 (BR-RET-03): the retention of its request type, changed while the PO is a draft
  const retention = await defaultRetentionOf(tx, lines.map((l) => l.requestLineId))
  await tx.purchaseOrder.create({
    data: {
      ...retention,
      id: poId,
      organizationId: ctx.organizationId,
      status: 'DRAFT',
      supplierId: first.supplierId!,
      deliverySiteId: first.deliverySiteId,
      kind: first.kind,
      urgency: lines.some((l) => l.urgent) ? 'URGENT' : 'NORMAL',
      priceIncludesVat: false,
      netSatang: totals.net,
      vatSatang: totals.vat,
      grossSatang: totals.gross,
      vatRateBp: options.rateBp,
      createdById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
      consolidationRunId: options.runId,
    },
  })
  await tx.poLine.createMany({
    data: poLines.map((p) => ({
      id: p.id,
      organizationId: ctx.organizationId,
      poId,
      lineNo: p.lineNo,
      description: p.line.description,
      categoryCode: p.line.categoryCode,
      quantity: p.quantity,
      uom: p.line.uom,
      unitPriceSatang: p.line.unitPriceSatang,
      netSatang: p.netSatang,
      vatable: p.line.vatable,
      budgetLineId: p.line.budgetLineId,
      serviceEndDate: p.line.serviceEndDate,
    })),
  })
  await tx.poLineSource.createMany({
    data: poLines.map((p) => ({
      organizationId: ctx.organizationId,
      poLineId: p.id,
      requestLineId: p.line.requestLineId,
      quantity: p.quantity,
      releasableSatang: releasableFor(p.line, p.line.free),
    })),
  })
  return {
    type: 'po.drafted',
    aggregateType: 'PurchaseOrder',
    aggregateId: poId,
    data: {
      supplierId: first.supplierId!,
      deliverySiteId: first.deliverySiteId,
      kind: first.kind,
      urgency: lines.some((l) => l.urgent) ? 'URGENT' : 'NORMAL',
      requestLineIds: lines.map((l) => l.requestLineId),
      netSatang: totals.net.toString(),
      consolidationRunId: options.runId,
      via: options.via,
    },
  }
}

// ---------- "รวมตอนนี้" (FR-P2P-002 AC3) ----------

export const consolidateNowCommand = defineCommand({
  name: 'procurement.consolidate_now',
  capability: 'po.create',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ runId: string; purchaseOrderIds: readonly string[] }>> {
    const ok = await authorize(tx, ctx, 'po.create')
    if (!ok.ok) return { ok: false, error: ok.error }
    const run = await consolidateInTx(tx, ctx, { trigger: 'MANUAL' })
    return { ok: true, result: { runId: run.runId, purchaseOrderIds: run.purchaseOrderIds }, events: run.events }
  },
})

export function consolidateNow(ctx: Ctx, options: RunOptions) {
  return runCommand(ctx, consolidateNowCommand, {}, options)
}

// ---------- the scheduled round (FR-P2P-002 AC2) ----------

export const scheduledConsolidationCommand = defineCommand({
  name: 'procurement.consolidate_scheduled',
  capability: 'po.create',
  input: z.strictObject({ scheduledFor: z.iso.datetime() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ runId: string; purchaseOrderIds: readonly string[] }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the scheduled job runs a scheduled round' } }
    const scheduledFor = new Date(input.scheduledFor)
    if (await tx.consolidationRun.findFirst({ where: { trigger: 'SCHEDULED', scheduledFor }, select: { id: true } })) {
      return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'this round already ran', details: { reason: 'ROUND_DONE' } } }
    }
    const run = await consolidateInTx(tx, ctx, { trigger: 'SCHEDULED', scheduledFor })
    return { ok: true, result: { runId: run.runId, purchaseOrderIds: run.purchaseOrderIds }, events: run.events }
  },
})

export type ScheduledRoundResult =
  | { readonly ran: true; readonly scheduledFor: string; readonly purchaseOrderIds: readonly string[] }
  | { readonly ran: false; readonly reason: 'NO_ROUND_DUE' | 'HOLIDAY' | 'CRON_INVALID' | 'ROUND_DONE' | string }

/**
 * Runs the organization's round that is due at `now`, once: the latest slot of its cron after the last scheduled round,
 * looking back one day, skipped on a holiday of its calendar. The job calls it every few minutes; the slot is also the
 * idempotency key, so a retry repeats nothing.
 */
export async function runScheduledConsolidation(organizationId: string, now: Date): Promise<ScheduledRoundResult> {
  const db = forTenant(organizationId)
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  const settings = OrgSettingsSchema.shape.consolidation.safeParse((org.settings as { consolidation?: unknown } | null)?.consolidation)
  const cron = settings.success ? parseCron(settings.data.cron) : null
  if (!cron) return { ran: false, reason: 'CRON_INVALID' }
  const last = await db.consolidationRun.findFirst({ where: { trigger: 'SCHEDULED' }, orderBy: { scheduledFor: 'desc' }, select: { scheduledFor: true } })
  const slot = latestSlot(cron, now, last?.scheduledFor ?? null)
  if (!slot) return { ran: false, reason: 'NO_ROUND_DUE' }
  // OQ-13: rounds run on business days only
  if (await db.holiday.findFirst({ where: { date: new Date(`${localDay(cron, slot)}T00:00:00Z`) }, select: { id: true } })) return { ran: false, reason: 'HOLIDAY' }
  const result = await runCommand(systemCtx(organizationId, now, 'consolidation'), scheduledConsolidationCommand, { scheduledFor: slot.toISOString() }, { idempotencyKey: `consolidation:${slot.toISOString()}` })
  if (!result.ok) return { ran: false, reason: (result.error.details?.reason as string | undefined) ?? result.error.code }
  return { ran: true, scheduledFor: slot.toISOString(), purchaseOrderIds: result.data.purchaseOrderIds }
}

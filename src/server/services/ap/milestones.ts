import { z } from 'zod'
import { documentTotals, parseQuantity } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { splitMilestones } from '@/core/retention'
import { BASIS_POINTS_WHOLE, BP_PER_PERCENT, LINE_NO_SHIFT, RETENTION_HOLD_MAX_DAYS } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { releasableFor, requestLineBasis } from '../procurement/pool'
import { requireModule } from '../modules'
import { fail, type Fail } from './common'
import AP_DEFAULTS from '@/lib/ap-defaults.json'

// Milestones and retention of a service PO (ADR-124, BR-RET-01, BR-RET-03, OQ-125, FR-AP-106 AC1 AC3): while the PO is
// a draft, PROCUREMENT splits a service line ordered for one request line into 2–12 milestones (the quantity by
// largest remainder, each milestone its own PO line with its own source and budget line, so each is received with a GR
// and invoiced as a service — no other table), and sets the retention each invoice holds back and the days it is held
// after the last milestone. A new PO starts with the retention of its request type (data of the organization).

// TODO(OQ-125): the days a retention is held when the request type names none
const DEFAULT_HOLD_DAYS = (AP_DEFAULTS as { retention?: { holdDays?: number } }).retention?.holdDays ?? 365

async function poGuard(tx: TenantTx, ctx: Ctx): Promise<{ ok: true } | Fail> {
  const allowed = await authorize(tx, ctx, 'po.edit')
  if (!allowed.ok) return { ok: false, error: allowed.error }
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  return { ok: true }
}

async function lockedDraft(tx: TenantTx, ctx: Ctx, poId: string, expectedVersion: number, command: string) {
  const [id] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [poId])
  if (!id) return fail('NOT_FOUND', 'purchase order not found')
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { sources: true } } } })
  if (po.status !== 'DRAFT') return fail('INVALID_STATE_TRANSITION', 'only a draft is changed', { from: po.status, command })
  if (po.version !== expectedVersion) return fail('CONFLICT_VERSION', 'the purchase order changed since it was opened', { currentVersion: po.version })
  return { ok: true as const, po }
}

/** The retention a new PO starts with: its request types' (the largest when its lines come from several) */
export async function defaultRetentionOf(tx: TenantTx, requestLineIds: readonly string[]): Promise<{ retentionBp: number; retentionHoldDays: number | null }> {
  const types = await tx.requestLine.findMany({ where: { id: { in: [...requestLineIds] } }, select: { request: { select: { requestType: { select: { defaultRetentionBp: true, defaultRetentionHoldDays: true } } } } } })
  const withRetention = types.map((t) => t.request.requestType).filter((t): t is NonNullable<typeof t> => !!t && t.defaultRetentionBp > 0)
  if (withRetention.length === 0) return { retentionBp: 0, retentionHoldDays: null }
  const top = withRetention.reduce((a, b) => (b.defaultRetentionBp > a.defaultRetentionBp ? b : a))
  return { retentionBp: top.defaultRetentionBp, retentionHoldDays: top.defaultRetentionHoldDays }
}

// ---------- po.setMilestones ----------

const MilestonesInput = z.strictObject({
  poId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  poLineId: z.uuid(),
  sharesBp: z.array(z.number().int()).min(1).max(20),
})

export const setMilestonesCommand = defineCommand({
  name: 'po.setMilestones',
  capability: 'po.edit',
  input: MilestonesInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poId: string; version: number; lineIds: string[] }>> {
    const who = await poGuard(tx, ctx)
    if (!who.ok) return who
    const locked = await lockedDraft(tx, ctx, input.poId, input.expectedVersion, 'po.setMilestones')
    if (!locked.ok) return locked
    const po = locked.po
    const line = po.lines.find((l) => l.id === input.poLineId)
    if (!line) return fail('VALIDATION_FAILED', 'the line is not on this purchase order', { field: 'poLineId', reason: 'LINE' })
    if (po.kind !== 'SERVICE') return fail('VALIDATION_FAILED', 'only a service purchase order has milestones', { field: 'poLineId', reason: 'NOT_SERVICE' })
    if (line.milestoneNo !== null) return fail('VALIDATION_FAILED', 'the line is a milestone already', { field: 'poLineId', reason: 'ALREADY_SPLIT' })
    // BR-RET-01 (as MERGED_LINE of po.edit): a line ordered for several request lines is not split
    if (line.sources.length !== 1) return fail('VALIDATION_FAILED', 'a line ordered for several request lines is not split', { field: 'poLineId', reason: 'MERGED_LINE' })
    const split = splitMilestones(line.quantity.toString(), line.unitPriceSatang, input.sharesBp)
    if (!split.ok) return fail('VALIDATION_FAILED', 'the shares are 2 to 12 parts above zero that add up to 100%', { field: 'sharesBp', reason: split.reason })

    const source = line.sources[0]!
    const basis = await requestLineBasis(tx, [source.requestLineId])
    const n = split.lines.length
    // the lines after the split line move down by n − 1: lifted out of the way first (lineNo is unique per PO)
    const after = po.lines.filter((l) => l.lineNo > line.lineNo)
    for (const l of after) await tx.poLine.update({ where: { id: l.id }, data: { lineNo: l.lineNo + LINE_NO_SHIFT } })
    for (const l of after) await tx.poLine.update({ where: { id: l.id }, data: { lineNo: l.lineNo + n - 1 } })
    const lineIds: string[] = []
    for (const [i, m] of split.lines.entries()) {
      const share = input.sharesBp[i]!
      const description = `${line.description} งวดที่ ${i + 1} (${share / BP_PER_PERCENT}%)`
      const releasable = releasableFor(basis.get(source.requestLineId)!, parseQuantity(m.qty))
      if (i === 0) {
        await tx.poLine.update({ where: { id: line.id }, data: { description, quantity: m.qty, netSatang: m.netSatang, milestoneNo: 1, milestoneShareBp: share } })
        await tx.poLineSource.update({ where: { id: source.id }, data: { quantity: m.qty, releasableSatang: releasable } })
        lineIds.push(line.id)
        continue
      }
      const created = await tx.poLine.create({
        data: {
          organizationId: ctx.organizationId,
          poId: po.id,
          lineNo: line.lineNo + i,
          description,
          categoryCode: line.categoryCode,
          quantity: m.qty,
          uom: line.uom,
          unitPriceSatang: line.unitPriceSatang,
          netSatang: m.netSatang,
          vatable: line.vatable,
          budgetLineId: line.budgetLineId,
          serviceEndDate: line.serviceEndDate,
          milestoneNo: i + 1,
          milestoneShareBp: share,
        },
        select: { id: true },
      })
      await tx.poLineSource.create({ data: { organizationId: ctx.organizationId, poLineId: created.id, requestLineId: source.requestLineId, quantity: m.qty, releasableSatang: releasable } })
      lineIds.push(created.id)
    }
    const lines = await tx.poLine.findMany({ where: { poId: po.id }, select: { quantity: true, unitPriceSatang: true, vatable: true } })
    const totals = documentTotals(
      lines.map((l) => ({ quantity: formatQuantity(parseQuantity(l.quantity.toString())), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
      po.vatRateBp ?? 0,
      false,
    )
    const saved = await tx.purchaseOrder.update({ where: { id: po.id }, data: { netSatang: totals.net, vatSatang: totals.vat, grossSatang: totals.gross, version: { increment: 1 } }, select: { version: true } })
    return {
      ok: true,
      result: { poId: po.id, version: saved.version, lineIds },
      events: [{ type: 'po.milestones_set', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { poLineId: line.id, sharesBp: input.sharesBp, lineIds, driftSatang: split.driftSatang.toString() } }],
    }
  },
})

// ---------- po.setRetention ----------

const RetentionInput = z.strictObject({
  poId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  retentionBp: z.number().int().min(0).max(BASIS_POINTS_WHOLE),
  retentionHoldDays: z.number().int().min(0).max(RETENTION_HOLD_MAX_DAYS).nullable(),
})

/** BR-RET-03: the retention of a draft PO and the days it is held after its last milestone (OQ-125) */
export const setRetentionCommand = defineCommand({
  name: 'po.setRetention',
  capability: 'po.edit',
  input: RetentionInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poId: string; version: number }>> {
    const who = await poGuard(tx, ctx)
    if (!who.ok) return who
    const locked = await lockedDraft(tx, ctx, input.poId, input.expectedVersion, 'po.setRetention')
    if (!locked.ok) return locked
    const saved = await tx.purchaseOrder.update({ where: { id: input.poId }, data: { retentionBp: input.retentionBp, retentionHoldDays: input.retentionHoldDays, version: { increment: 1 } }, select: { version: true } })
    return { ok: true, result: { poId: input.poId, version: saved.version }, events: [{ type: 'po.retention_set', aggregateType: 'PurchaseOrder', aggregateId: input.poId, data: { retentionBp: input.retentionBp, retentionHoldDays: input.retentionHoldDays } }] }
  },
})

/** The days a retention of `po` is held: the PO's, else the default of OQ-125 */
export const holdDaysOf = (po: { readonly retentionHoldDays: number | null }): number => po.retentionHoldDays ?? DEFAULT_HOLD_DAYS

export function setPoMilestones(ctx: Ctx, input: z.input<typeof MilestonesInput>, options: RunOptions) {
  return runCommand(ctx, setMilestonesCommand, input, options)
}
export function setPoRetention(ctx: Ctx, input: z.input<typeof RetentionInput>, options: RunOptions) {
  return runCommand(ctx, setRetentionCommand, input, options)
}

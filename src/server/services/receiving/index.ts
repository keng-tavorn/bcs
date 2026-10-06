import { z } from 'zod'
import { holdMore } from '@/core/budget'
import { lineNet, parseQuantity, vatFromNet, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import type { AppError } from '@/core/result'
import { PO_MACHINE, transition, type PoState } from '@/core/state-machines'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { authorize, isAllowed, loadPrincipal, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { applyBudget } from '@/server/budget/ledger'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { effectiveSodPolicy } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { startRoute } from '../approvals/route'
import { issueDocumentNumber } from '../numbering'
import { unsettledLines } from '../purchase-orders/close'
import { receivingDecision } from './access'
import { photosUsable } from './photos'
import { keepPendingByLine, receiveOnLine, shortNow, standingOf, stillToCome } from './standing'

// Receiving (spec §6.4 GR, §7.11, BR-GR-01 to BR-GR-05, FR-P2P-006, FR-P2P-007): the RECEIVER of the requesting
// department — or the requester when the DOA in effect lets requesters receive (OQ-04) — posts what came per PO line,
// with what was rejected; nobody who approved the PRs or the PO receives (BR-SOD-02). What lies beyond what is still on
// order (the ordered quantity less what a close-short gave up, ./standing.ts) is accepted at once within
// settings.receiving.overTolerancePct and held at the PO price (BR-GR-02); the rest is an OVER variance that goes back
// (RETURN_EXCESS) or waits for the GR_VARIANCE approver (ACCEPT_EXCESS). Rejected goods that are damaged are a DAMAGED
// variance with at least one photo (BR-GR-05): replaced (RETURN_REPLACE) or, once approved, kept (ACCEPT_DAMAGED) — kept
// only up to what is still to come, since damaged goods beyond the order would be an excess nobody approved or held. A
// PO that will not come in full is closed short through a CLOSE_SHORT variance per line (GC-GR-04) for what is still to
// come; the approval counts again what is missing then (NEW-32). Quantities are decimal text ×10⁴; amounts satang
// before VAT.

type Fail = { ok: false; error: AppError }
type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const
const scaled = (d: { toString(): string }) => parseQuantity(d.toString())
const Quantity = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/)
const MAX_PHOTOS = 20
const MIN_REASON_LENGTH = 3

/** The PO with its lines and the people tied to it: the requesters of its PRs and everyone who approved them or it */
async function loadPo(tx: TenantTx, ctx: Ctx, poId: string) {
  const [locked] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [poId])
  if (!locked) return null
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId } } } } } }, select: { id: true, number: true, requesterMemberId: true, requesterDepartmentId: true } })
  const decided = await tx.approvalTask.findMany({
    where: { status: 'APPROVED', step: { route: { OR: [{ subjectType: 'REQUEST', subjectId: { in: requests.map((r) => r.id) } }, { subjectType: 'PURCHASE_ORDER', subjectId: poId }] } } },
    select: { decidedByMemberId: true, principalMemberId: true },
  })
  // ADR-038 ข้อ 8: a delegate who approved and the delegator they acted for both count as approvers
  const approvers = [...new Set(decided.flatMap((t) => [t.decidedByMemberId, t.principalMemberId]).filter((m): m is string => Boolean(m)))]
  // Damaged goods waiting to be kept count as taken until they are decided (./standing.ts)
  const keepPending = await keepPendingByLine(tx, po.lines.map((l) => l.id))
  return { po, requests, approvers, keepPending }
}

type LoadedPo = NonNullable<Awaited<ReturnType<typeof loadPo>>>

/**
 * §2.4 gr.post: RECEIVER of a requesting department, or a requester of the PO's PRs when the DOA in effect lets
 * requesters receive; then BR-SOD-02 and BR-SOD-07 (GC-SOD-02, GC-SOD-05).
 */
async function mayReceive(
  tx: TenantTx,
  ctx: Ctx,
  loaded: LoadedPo,
  actor: string,
  action: 'gr.post' | 'gr.preview' = 'gr.post',
): Promise<{ ok: true; principal: Principal } | (Fail & { auditEvents?: EventDraft[] })> {
  const principal = await loadPrincipal(tx, ctx)
  const sodPolicy = await effectiveSodPolicy(tx, ctx.now)
  const decision = receivingDecision(principal, sodPolicy, loaded)
  if (decision.kind === 'NONE') return { ok: false, error: { code: 'FORBIDDEN', message: 'missing capability gr.post', details: { capability: 'gr.post' } } }
  if (decision.kind === 'SOD') {
    return {
      ok: false,
      error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: decision.rule } },
      auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: loaded.po.id, data: { rule: decision.rule, action, subjectType: 'PURCHASE_ORDER', subjectId: loaded.po.id, actorMemberId: actor } }],
    }
  }
  return { ok: true, principal }
}

/**
 * Whether the actor may read the balances of these budget lines (§2.4 budget.view): the head of the line's department
 * or an organization-wide budget role. A requester's own-line grant (SELECTED_LINE_ONLY) is for the request form only,
 * and a RECEIVER has none — a refusal for lack of budget then says so without figures.
 */
async function seesBudgetOf(tx: TenantTx, principal: Principal, budgetLineIds: readonly string[]): Promise<boolean> {
  const lines = await tx.budgetLine.findMany({ where: { id: { in: [...new Set(budgetLineIds)] } }, select: { departmentId: true } })
  return lines.length > 0 && lines.every((l) => isAllowed(principal, 'budget.view', { departmentId: l.departmentId }))
}

/** A variance that needs approval goes to the GR_VARIANCE rule, on its own amount (ADR-038 ข้อ 7) */
async function routeVariance(tx: TenantTx, ctx: Ctx, varianceId: string, label: string, amountSatang: Satang, vatRateBp: number | null, budgetLineId: string, requesterMemberId: string) {
  const departmentId = (await tx.budgetLine.findUniqueOrThrow({ where: { id: budgetLineId }, select: { departmentId: true } })).departmentId
  return startRoute(
    tx,
    ctx,
    { type: 'VARIANCE', id: varianceId, label },
    {
      documentType: 'GR_VARIANCE',
      amount: { netSatang: amountSatang, vatSatang: vatFromNet(amountSatang, vatRateBp ?? 0).vat },
      requesterMemberId,
      chargedDepartmentId: departmentId,
      conflictMemberIds: [requesterMemberId],
      at: ctx.now,
    },
  )
}

/** The PO status after receiving: every line in (or given up) → RECEIVED, else PARTIALLY_RECEIVED */
async function statusAfterReceipt(tx: TenantTx, po: { id: string; status: string }) {
  const command = (await unsettledLines(tx, po.id)).length ? 'gr.posted_partially' : 'gr.posted_fully'
  return transition(PO_MACHINE, po.status as PoState, command)
}

// ---------- post a GR (FR-P2P-006, FR-P2P-007 AC1) ----------

const PostInput = z.strictObject({
  poId: z.uuid(),
  deliveryNoteNo: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(REASON_MAX_LENGTH).nullable().optional(),
  /** Photos uploaded by the receiver (FileLink kind PHOTO); one at least when goods are damaged (BR-GR-05) */
  photoFileIds: z.array(z.uuid()).max(MAX_PHOTOS).default([]),
  lines: z
    .array(
      z.strictObject({
        poLineId: z.uuid(),
        /** What came on this delivery */
        received: Quantity,
        /** Of that, not accepted */
        rejected: Quantity.default('0'),
        /** The rejected goods are damaged: replaced by the supplier, or kept once approved */
        damagedDisposition: z.enum(['RETURN_REPLACE', 'ACCEPT_DAMAGED']).optional(),
        /** For what lies beyond what is still on order and the tolerance */
        excessDisposition: z.enum(['RETURN_EXCESS', 'ACCEPT_EXCESS']).optional(),
        remark: z.string().trim().max(REASON_MAX_LENGTH).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
})

export const postGrCommand = defineCommand({
  name: 'gr.post',
  capability: 'gr.post',
  input: PostInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ grId: string; number: string; poStatus: string; varianceIds: string[]; pendingApproval: number }>> {
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member receives goods' } }
    const loaded = await loadPo(tx, ctx, input.poId)
    if (!loaded) return fail('NOT_FOUND', 'purchase order not found')
    const { po } = loaded
    const may = await mayReceive(tx, ctx, loaded, actor)
    if (!may.ok) return may
    if (po.status !== 'SENT' && po.status !== 'PARTIALLY_RECEIVED') return fail('INVALID_STATE_TRANSITION', `gr.post is not allowed when the purchase order is ${po.status}`, { from: po.status, command: 'gr.post' })

    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const tolerancePct = OrgSettingsSchema.shape.receiving.parse((org.settings as { receiving?: unknown } | null)?.receiving).overTolerancePct
    if (!Number.isInteger(tolerancePct)) return fail('VALIDATION_FAILED', 'the receiving tolerance must be a whole percent', { reason: 'TOLERANCE' })
    if (new Set(input.lines.map((l) => l.poLineId)).size !== input.lines.length) return fail('VALIDATION_FAILED', 'a PO line appears twice', { field: 'lines', reason: 'DUPLICATE_LINE' })
    const photoIds = [...new Set(input.photoFileIds)]
    if (!(await photosUsable(tx, actor, photoIds))) return fail('VALIDATION_FAILED', 'photos must be new pictures you uploaded', { field: 'photoFileIds', reason: 'FILE' })

    const grId = newId()
    const planned: Array<{ line: (typeof po.lines)[number]; received: bigint; rejected: bigint; accepted: bigint; within: bigint; hold: Satang; variances: Array<{ id: string; type: 'OVER' | 'DAMAGED'; disposition: 'RETURN_EXCESS' | 'ACCEPT_EXCESS' | 'RETURN_REPLACE' | 'ACCEPT_DAMAGED'; quantity: bigint; amountSatang: Satang; needsApproval: boolean }> }> = []
    for (const [i, l] of input.lines.entries()) {
      const line = po.lines.find((x) => x.id === l.poLineId)
      if (!line) return fail('VALIDATION_FAILED', 'the line is not on this purchase order', { field: `lines.${i}.poLineId`, reason: 'LINE' })
      const received = parseQuantity(l.received)
      const rejected = parseQuantity(l.rejected)
      if (received <= 0n || rejected > received) return fail('VALIDATION_FAILED', 'what came must be above zero and include what was rejected', { field: `lines.${i}.received`, reason: 'QUANTITY' })
      const standing = standingOf(line, loaded.keepPending.get(line.id) ?? 0n)
      const increment = receiveOnLine(standing, { unitPriceSatang: line.unitPriceSatang, received: received - rejected, tolerancePct, disposition: l.excessDisposition })
      const variances: (typeof planned)[number]['variances'] = []
      if (increment.over) {
        if (!l.excessDisposition) return fail('VALIDATION_FAILED', 'say whether the excess goes back or is kept', { field: `lines.${i}.excessDisposition`, reason: 'EXCESS_DISPOSITION_REQUIRED', excess: formatQuantity(increment.over.quantity) })
        variances.push({ id: newId(), type: 'OVER', disposition: l.excessDisposition, quantity: increment.over.quantity, amountSatang: increment.over.amountSatang, needsApproval: increment.over.needsApproval })
      }
      if (rejected > 0n && l.damagedDisposition) {
        if (photoIds.length === 0) return fail('VALIDATION_FAILED', 'damaged goods need a photo', { field: 'photoFileIds', reason: 'PHOTO_REQUIRED' })
        // Kept damaged goods fill what is still to come; beyond it they would be an excess nobody approved or held
        const keepable = stillToCome({ ...standing, received: standing.received + increment.accepted })
        if (l.damagedDisposition === 'ACCEPT_DAMAGED' && rejected > keepable) {
          return fail('VALIDATION_FAILED', 'damaged goods beyond what is still to come go back', { field: `lines.${i}.damagedDisposition`, reason: 'DAMAGED_BEYOND_ORDER', keepable: formatQuantity(keepable) })
        }
        const amountSatang = lineNet(formatQuantity(rejected), line.unitPriceSatang)
        variances.push({ id: newId(), type: 'DAMAGED', disposition: l.damagedDisposition, quantity: rejected, amountSatang, needsApproval: l.damagedDisposition === 'ACCEPT_DAMAGED' })
      }
      planned.push({ line, received, rejected, accepted: increment.accepted, within: increment.withinTolerance, hold: increment.holdSatang, variances })
    }

    // BR-GR-02: the excess within the tolerance is held at once, or the whole GR is refused (BUDGET_INSUFFICIENT)
    const holding = planned.filter((p) => p.hold > 0n)
    const budget = holding.length
      ? await applyBudget(
          tx,
          ctx,
          holding.map((p) => ({ budgetLineId: p.line.budgetLineId, document: { type: 'PURCHASE_ORDER' as const, id: po.id }, run: (s) => holdMore(s, p.line.id, p.hold) })),
        )
      : { ok: true as const, events: [] as EventDraft[] }
    if (!budget.ok) {
      // The balance and the shortfall are budget figures: only for those who may view the budget line (§2.4 budget.view)
      const lineIds = holding.map((p) => p.line.budgetLineId)
      if (budget.error.code === 'BUDGET_INSUFFICIENT' && !(await seesBudgetOf(tx, may.principal, lineIds))) return { ok: false, error: { code: 'BUDGET_INSUFFICIENT', message: budget.error.message } }
      return budget
    }

    const number = await issueDocumentNumber(tx, ctx, { document: 'GR' })
    await tx.goodsReceipt.create({
      data: { id: grId, organizationId: ctx.organizationId, number, poId: po.id, status: 'POSTED', receivedAt: ctx.now, receiverMemberId: actor, deliveryNoteNo: input.deliveryNoteNo ?? null, notes: input.notes ?? null, postedAt: ctx.now },
    })
    await tx.grLine.createMany({
      data: planned.map((p, i) => ({
        organizationId: ctx.organizationId,
        grId,
        poLineId: p.line.id,
        receivedQuantity: formatQuantity(p.received),
        acceptedQuantity: formatQuantity(p.accepted),
        rejectedQuantity: formatQuantity(p.received - p.accepted),
        remark: input.lines[i]!.remark ?? null,
      })),
    })
    for (const p of planned) {
      await tx.poLine.update({ where: { id: p.line.id }, data: { receivedQuantity: formatQuantity(scaled(p.line.receivedQuantity) + p.accepted), acceptedExtraQuantity: formatQuantity(scaled(p.line.acceptedExtraQuantity) + p.within) } })
    }
    if (photoIds.length) await tx.fileLink.createMany({ data: photoIds.map((fileId) => ({ organizationId: ctx.organizationId, fileId, subjectType: 'GoodsReceipt', subjectId: grId, kind: 'PHOTO' as const })) })

    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    const varianceIds: string[] = []
    for (const p of planned) {
      for (const v of p.variances) {
        let routeId: string | null = null
        if (v.needsApproval) {
          const route = await routeVariance(tx, ctx, v.id, `${number} · ${p.line.description}`, v.amountSatang, po.vatRateBp, p.line.budgetLineId, actor)
          if (!route.ok) return { ok: false, error: route.error }
          routeId = route.data.routeId
          events.push(...route.data.events)
          notifications.push(...route.data.notifications)
        }
        await tx.variance.create({
          data: {
            id: v.id,
            organizationId: ctx.organizationId,
            poId: po.id,
            poLineId: p.line.id,
            grId,
            type: v.type,
            quantity: formatQuantity(v.quantity),
            amountSatang: v.amountSatang,
            disposition: v.disposition,
            status: v.needsApproval ? 'PENDING_APPROVAL' : 'RECORDED',
            createdById: actor,
            currentRouteId: routeId,
          },
        })
        varianceIds.push(v.id)
        events.push({
          type: 'variance.recorded',
          aggregateType: 'Variance',
          aggregateId: v.id,
          data: { poId: po.id, poLineId: p.line.id, grId, type: v.type, disposition: v.disposition, status: v.needsApproval ? 'PENDING_APPROVAL' : 'RECORDED', quantity: formatQuantity(v.quantity), amountSatang: v.amountSatang.toString(), routeId },
        })
      }
    }
    const moved = await statusAfterReceipt(tx, po)
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `gr.post is not allowed when the purchase order is ${po.status}`, { from: po.status, command: 'gr.post' })
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: moved.to, version: { increment: 1 } } })
    events.unshift({
      type: 'gr.posted',
      aggregateType: 'GoodsReceipt',
      aggregateId: grId,
      data: { number, poId: po.id, lines: planned.map((p) => ({ poLineId: p.line.id, received: formatQuantity(p.received), accepted: formatQuantity(p.accepted), rejected: formatQuantity(p.received - p.accepted) })), varianceIds, poStatus: moved.to },
    })
    events.push(...budget.events)
    // §10.1 gr.posted: the requesters and PROCUREMENT (the PO's creator), in the digest
    for (const recipient of new Set([...loaded.requests.map((r) => r.requesterMemberId), ...(po.createdById ? [po.createdById] : [])])) {
      if (recipient === actor) continue
      notifications.push({ recipientMemberId: recipient, templateKey: 'gr.posted', data: { grId, number, poId: po.id, poNumber: po.number }, urgency: 'DIGEST', dedupeKey: `gr.posted:${grId}:${recipient}`, subjectType: 'PURCHASE_ORDER', subjectId: po.id })
    }
    // pendingApproval: the variances of this receipt that wait for the GR_VARIANCE approver, for the screen's confirmation
    const pendingApproval = planned.reduce((n, p) => n + p.variances.filter((v) => v.needsApproval).length, 0)
    return { ok: true, result: { grId, number, poStatus: moved.to, varianceIds, pendingApproval }, events, notifications }
  },
})

export function postGoodsReceipt(ctx: Ctx, input: z.input<typeof PostInput>, options: RunOptions) {
  return runCommand(ctx, postGrCommand, input, options)
}

// ---------- a preview refused by separation of duties (FR-DOA-007 AC2) ----------

/**
 * FR-DOA-007 AC2: every violation is blocked and recorded — a preview of a receipt too (src/server/services/receiving/
 * view.ts), the way ADR-042 records a refused preview of an authority change. The rule is checked again here; the
 * command never changes anything and never succeeds: it leaves the security.sod_blocked event (action gr.preview), once
 * per idempotency key (a resend of the same attempt replays it).
 */
export const recordPreviewSodBlockCommand = defineCommand({
  name: 'gr.preview_sod_blocked',
  capability: 'gr.post',
  input: z.strictObject({ poId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<never>> {
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member receives goods' } }
    const loaded = await loadPo(tx, ctx, input.poId)
    if (!loaded) return fail('NOT_FOUND', 'purchase order not found')
    const may = await mayReceive(tx, ctx, loaded, actor, 'gr.preview')
    return may.ok ? fail('VALIDATION_FAILED', 'no separation-of-duties refusal to record', { reason: 'NO_SOD_VIOLATION' }) : may
  },
})

export function recordGrPreviewSodBlock(ctx: Ctx, poId: string, options: RunOptions) {
  return runCommand(ctx, recordPreviewSodBlockCommand, { poId }, options)
}

// ---------- close short (GC-GR-04, FR-P2P-010 AC2) ----------

const CloseShortInput = z.strictObject({ poId: z.uuid(), reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH) })

export const closeShortCommand = defineCommand({
  name: 'po.close_short',
  capability: 'po.close',
  input: CloseShortInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ varianceIds: string[] }>> {
    const allowed = await authorize(tx, ctx, 'po.close')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member closes a PO short' } }
    const loaded = await loadPo(tx, ctx, input.poId)
    if (!loaded) return fail('NOT_FOUND', 'purchase order not found')
    const { po } = loaded
    if (po.status !== 'SENT' && po.status !== 'PARTIALLY_RECEIVED') return fail('INVALID_STATE_TRANSITION', `closing short is not allowed when the purchase order is ${po.status}`, { from: po.status, command: 'po.close_short' })
    if (await tx.variance.count({ where: { poId: po.id, disposition: 'CLOSE_SHORT', status: 'PENDING_APPROVAL' } })) return fail('INVALID_STATE_TRANSITION', 'a close-short is waiting for approval', { from: po.status, command: 'po.close_short', reason: 'CLOSE_SHORT_PENDING' })
    // What is still to come per line; damaged goods waiting to be kept are not given up (they may still be kept)
    const lines = po.lines.map((line) => ({ line, standing: standingOf(line, loaded.keepPending.get(line.id) ?? 0n) }))
    const unsettled = lines.filter((l) => l.standing.received + l.standing.cancelled < l.standing.ordered)
    if (unsettled.length === 0) return fail('VALIDATION_FAILED', 'every line came in full', { reason: 'NOTHING_SHORT' })
    const short = unsettled.map((l) => ({ line: l.line, ...shortNow(l.standing, l.line.unitPriceSatang) })).filter((s) => s.quantity > 0n)
    if (short.length === 0) return fail('INVALID_STATE_TRANSITION', 'what is still to come waits for a decision on damaged goods', { from: po.status, command: 'po.close_short', reason: 'DAMAGED_PENDING' })
    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    const varianceIds: string[] = []
    const reasonCommentId = newId()
    await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: 'PurchaseOrder', subjectId: po.id, authorMemberId: actor, body: input.reason } })
    for (const s of short) {
      const id = newId()
      const route = await routeVariance(tx, ctx, id, `${po.number ?? ''} · ${s.line.description}`, s.amountSatang, po.vatRateBp, s.line.budgetLineId, actor)
      if (!route.ok) return { ok: false, error: route.error }
      await tx.variance.create({
        data: { id, organizationId: ctx.organizationId, poId: po.id, poLineId: s.line.id, grId: null, type: 'SHORT', quantity: formatQuantity(s.quantity), amountSatang: s.amountSatang, disposition: 'CLOSE_SHORT', status: 'PENDING_APPROVAL', reason: input.reason, createdById: actor, currentRouteId: route.data.routeId },
      })
      varianceIds.push(id)
      events.push(
        { type: 'variance.recorded', aggregateType: 'Variance', aggregateId: id, data: { poId: po.id, poLineId: s.line.id, grId: null, type: 'SHORT', disposition: 'CLOSE_SHORT', status: 'PENDING_APPROVAL', quantity: formatQuantity(s.quantity), amountSatang: s.amountSatang.toString(), routeId: route.data.routeId } },
        ...route.data.events,
      )
      notifications.push(...route.data.notifications)
    }
    return { ok: true, result: { varianceIds }, events, notifications }
  },
})

export function requestCloseShort(ctx: Ctx, input: z.input<typeof CloseShortInput>, options: RunOptions) {
  return runCommand(ctx, closeShortCommand, input, options)
}

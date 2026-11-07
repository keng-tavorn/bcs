import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import { dateIn } from '@/core/supplier-docs'
import { presignDownload } from '@/integrations/storage'
import { isAllowed, loadPrincipal } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { PORTAL_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-portal'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { sentRecipients } from '../purchase-orders/send'

// The supplier acknowledges a PO and says when it delivers (S7-11 · FR-SUP-105 · BR-SUP ข้อ 14 · ADR-188): once per
// revision of a PO SENT or PARTIALLY_RECEIVED, with the delivery date it promises (today or later, Bangkok); a later
// date is a DELIVERY_UPDATE row with its reason. The PO itself never changes here (a change of it is S8's PO_CHANGE);
// PurchaseOrder.supplierAckStatus is a projection of the latest row of the current revision, and a new revision sent to
// the supplier (po.revision_sent of S8) puts it back to NOT_ACKNOWLEDGED (job po-ack-reset). The requesters of the
// source requests and the receivers hear of an acknowledgement in their digest; of a new date at once, with the buyer
// who made the PO — the words name the PO's number and the dates, never a price (BR-NOTI-01).

const TIMEZONE = 'Asia/Bangkok'
const ACKNOWLEDGEABLE = ['SENT', 'PARTIALLY_RECEIVED'] as const
const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const NOTE_MAX = 500
const MIN_REASON = 3

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const isoOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`)

/** The contact of an ACTIVE supplier on the portal, acting on a PO of its own supplier (portal.po.acknowledge) */
async function lockedPoOfContact(tx: TenantTx, ctx: Ctx, poId: string) {
  if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL') return fail('FORBIDDEN', 'not a portal request')
  const on = await requireModule(ctx, 'SUPPLIER', tx)
  if (!on.ok) return { ok: false as const, error: on.error }
  const refused = fail('FORBIDDEN', 'a contact acknowledges the POs of its own supplier only', { action: 'portal.po.acknowledge' })
  if (!ctx.actor.supplierId) return refused
  const contact = await tx.supplierContact.findUnique({ where: { id: ctx.actor.supplierContactId }, select: { status: true, supplierId: true, supplier: { select: { status: true } } } })
  if (!contact || contact.status !== 'ACTIVE' || contact.supplierId !== ctx.actor.supplierId || contact.supplier?.status !== 'ACTIVE') return refused
  const [locked] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [poId])
  const po = locked ? await tx.purchaseOrder.findUnique({ where: { id: poId }, select: { id: true, number: true, status: true, supplierId: true, revisionNo: true, createdById: true, supplierAckStatus: true, supplierPromisedDeliveryOn: true } }) : null
  // another supplier's PO is not found, as one that does not exist (INV-SUP-01)
  if (!po || po.supplierId !== ctx.actor.supplierId || !['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(po.status)) return fail('NOT_FOUND', 'purchase order not found')
  if (!(ACKNOWLEDGEABLE as readonly string[]).includes(po.status)) return fail('INVALID_STATE_TRANSITION', 'the purchase order takes no acknowledgement now', { status: po.status })
  return { ok: true as const, po, contactId: ctx.actor.supplierContactId }
}

/** Who hears: the requesters of the source requests and the receivers of their departments; the buyer too for a new date */
async function told(tx: TenantTx, ctx: Ctx, po: { id: string; number: string | null; createdById: string | null }, templateKey: 'po.acknowledged' | 'po.delivery_changed', data: Record<string, unknown>, key: string): Promise<NotificationDraft[]> {
  const people = new Set((await sentRecipients(tx, ctx, po.id)).map((r) => r.memberId))
  if (templateKey === 'po.delivery_changed' && po.createdById) people.add(po.createdById)
  return [...people].map((memberId) => ({
    recipientMemberId: memberId,
    templateKey,
    data: { poId: po.id, number: po.number, ...data },
    urgency: templateKey === 'po.acknowledged' ? ('DIGEST' as const) : ('IMMEDIATE' as const),
    dedupeKey: `${templateKey}:${po.id}:${key}:${memberId}`,
    subjectType: 'PURCHASE_ORDER',
    subjectId: po.id,
  }))
}

// ---------- po.acknowledge ----------

const AckInput = z.strictObject({ poId: z.uuid(), promisedDeliveryOn: ISO.nullable().optional(), note: z.string().trim().max(NOTE_MAX).nullable().optional() })

export const acknowledgePoCommand = defineCommand({
  name: 'po.acknowledge',
  capability: 'portal.po.acknowledge',
  input: AckInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poId: string; revisionNo: number }>> {
    const found = await lockedPoOfContact(tx, ctx, input.poId)
    if (!found.ok) return found
    const { po, contactId } = found
    if (await tx.poAcknowledgement.findFirst({ where: { poId: po.id, revisionNo: po.revisionNo, kind: 'ACK' }, select: { id: true } })) return fail('INVALID_STATE_TRANSITION', 'this revision is acknowledged already', { revisionNo: po.revisionNo })
    const promised = input.promisedDeliveryOn ?? null
    if (promised && promised < dateIn(ctx.now, TIMEZONE)) return fail('VALIDATION_FAILED', 'the delivery date is in the past', { field: 'promisedDeliveryOn', reason: 'PAST_DATE' })
    await tx.poAcknowledgement.create({ data: { organizationId: ctx.organizationId, poId: po.id, revisionNo: po.revisionNo, supplierId: po.supplierId, contactId, kind: 'ACK', acknowledgedAt: ctx.now, promisedDeliveryOn: promised ? dateOf(promised) : null, note: input.note ?? null } })
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { supplierAckStatus: 'ACKNOWLEDGED', supplierAcknowledgedAt: ctx.now, supplierPromisedDeliveryOn: promised ? dateOf(promised) : null } })
    // the supplier gets its own confirmation, at its contact's address (BR-NOTI ข้อ 09)
    const confirm = await enqueueSupplierNotice(tx, ctx, { templateKey: PORTAL_SUPPLIER_TEMPLATES.poDeliveryAck, supplierId: po.supplierId, contactId, subjectType: 'PurchaseOrder', subjectId: po.id, dedupeKey: `${PORTAL_SUPPLIER_TEMPLATES.poDeliveryAck}:${po.id}:${po.revisionNo}`, data: { number: po.number, promisedDeliveryOn: promised } })
    return {
      ok: true,
      result: { poId: po.id, revisionNo: po.revisionNo },
      events: [{ type: 'po.acknowledged', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { revisionNo: po.revisionNo, promisedDeliveryOn: promised } }, ...confirm.events],
      notifications: [...(await told(tx, ctx, po, 'po.acknowledged', { promisedDeliveryOn: promised }, `r${po.revisionNo}`)), ...confirm.notifications],
      outbox: confirm.outbox,
    }
  },
})

// ---------- po.updateDelivery ----------

const DeliveryInput = z.strictObject({ poId: z.uuid(), promisedDeliveryOn: ISO, reason: z.string().trim().min(MIN_REASON).max(NOTE_MAX) })

export const updatePoDeliveryCommand = defineCommand({
  name: 'po.updateDelivery',
  capability: 'portal.po.acknowledge',
  input: DeliveryInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ poId: string; revisionNo: number }>> {
    const found = await lockedPoOfContact(tx, ctx, input.poId)
    if (!found.ok) return found
    const { po, contactId } = found
    if (po.supplierAckStatus === 'NOT_ACKNOWLEDGED') return fail('INVALID_STATE_TRANSITION', 'acknowledge the purchase order first', { status: po.supplierAckStatus })
    if (input.promisedDeliveryOn < dateIn(ctx.now, TIMEZONE)) return fail('VALIDATION_FAILED', 'the delivery date is in the past', { field: 'promisedDeliveryOn', reason: 'PAST_DATE' })
    const from = isoOf(po.supplierPromisedDeliveryOn)
    if (from === input.promisedDeliveryOn) return fail('VALIDATION_FAILED', 'the delivery date is the same', { field: 'promisedDeliveryOn', reason: 'NO_CHANGE' })
    await tx.poAcknowledgement.create({ data: { organizationId: ctx.organizationId, poId: po.id, revisionNo: po.revisionNo, supplierId: po.supplierId, contactId, kind: 'DELIVERY_UPDATE', acknowledgedAt: ctx.now, promisedDeliveryOn: dateOf(input.promisedDeliveryOn), previousPromisedOn: po.supplierPromisedDeliveryOn, note: input.reason } })
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { supplierAckStatus: 'DELIVERY_UPDATED', supplierPromisedDeliveryOn: dateOf(input.promisedDeliveryOn) } })
    return {
      ok: true,
      result: { poId: po.id, revisionNo: po.revisionNo },
      events: [{ type: 'po.delivery_date_changed', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { revisionNo: po.revisionNo, from, to: input.promisedDeliveryOn } }],
      notifications: await told(tx, ctx, po, 'po.delivery_changed', { from, to: input.promisedDeliveryOn }, `d${input.promisedDeliveryOn}`),
    }
  },
})

export const acknowledgePo = (ctx: Ctx, input: z.input<typeof AckInput>, opts: RunOptions) => runCommand(ctx, acknowledgePoCommand, input, opts)
export const updatePoDelivery = (ctx: Ctx, input: z.input<typeof DeliveryInput>, opts: RunOptions) => runCommand(ctx, updatePoDeliveryCommand, input, opts)

// ---------- po-ack-reset (job · AC4) ----------

const ResetInput = z.strictObject({ poId: z.uuid(), revisionNo: z.int().min(1) })

export const resetPoAckCommand = defineCommand({
  name: 'po.ackReset',
  capability: 'system.supplierPortal',
  input: ResetInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ reset: boolean }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'only the job resets an acknowledgement')
    const [locked] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [input.poId])
    const po = locked ? await tx.purchaseOrder.findUnique({ where: { id: input.poId }, select: { revisionNo: true, supplierAckStatus: true } }) : null
    if (!po) return fail('NOT_FOUND', 'purchase order not found')
    // an older event, or a revision acknowledged already since: nothing to do
    if (po.revisionNo !== input.revisionNo || (await tx.poAcknowledgement.count({ where: { poId: input.poId, revisionNo: input.revisionNo } })) > 0) return fail('INVALID_STATE_TRANSITION', 'nothing to reset', { reason: 'CURRENT' })
    if (po.supplierAckStatus === 'NOT_ACKNOWLEDGED') return fail('INVALID_STATE_TRANSITION', 'nothing to reset', { reason: 'NOT_ACKNOWLEDGED' })
    await tx.purchaseOrder.update({ where: { id: input.poId }, data: { supplierAckStatus: 'NOT_ACKNOWLEDGED', supplierAcknowledgedAt: null, supplierPromisedDeliveryOn: null } })
    return { ok: true, result: { reset: true }, events: [{ type: 'po.ack_reset', aggregateType: 'PurchaseOrder', aggregateId: input.poId, data: { revisionNo: input.revisionNo } }] }
  },
})

/** Job po-ack-reset: a new revision sent to the supplier is not acknowledged yet */
export async function resetPoAck(organizationId: string, poId: string, revisionNo: number, now: Date): Promise<boolean> {
  const r = await runCommand(systemCtx(organizationId, now, 'po-ack-reset'), resetPoAckCommand, { poId, revisionNo }, { idempotencyKey: `po-ack-reset:reset:${poId}:${revisionNo}` })
  return r.ok && r.data.reset
}

// ---------- the PO's PDF for the supplier (AC1 · a POST answers a URL of five minutes) ----------

/** The PDF of the current revision of a PO of the contact's own supplier, as a short-lived address */
export async function poPdfUrlForContact(ctx: Ctx, poId: string): Promise<Result<{ url: string }>> {
  if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL' || !ctx.actor.supplierId) return { ok: false, error: { code: 'FORBIDDEN', message: 'not a portal request' } }
  const supplierId = ctx.actor.supplierId
  const po = await forTenant(ctx.organizationId).purchaseOrder.findFirst({ where: { id: poId, supplierId, status: { in: ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] } }, select: { number: true, pdfFile: { select: { storageKey: true, fileName: true } } } })
  if (!po?.pdfFile) return { ok: false, error: { code: 'NOT_FOUND', message: 'purchase order not found' } }
  return { ok: true, data: { url: await presignDownload(po.pdfFile.storageKey, { fileName: po.pdfFile.fileName, contentType: 'application/pdf', inline: true }) } }
}

// ---------- the board's list (AC4) ----------

export interface PoAwaitingAckRow {
  readonly id: string
  readonly number: string | null
  readonly supplierName: string
  readonly sentAt: string | null
}

/** The POs sent and not acknowledged yet, oldest first — for readers of every PO; empty for others */
export async function listPosAwaitingAck(ctx: Ctx): Promise<PoAwaitingAckRow[]> {
  const db = forTenant(ctx.organizationId)
  const principal = await db.$transaction((tx) => loadPrincipal(tx, ctx))
  if (!isAllowed(principal, 'po.view', {})) return []
  const rows = await db.purchaseOrder.findMany({
    where: { status: { in: ['SENT', 'PARTIALLY_RECEIVED'] }, supplierAckStatus: 'NOT_ACKNOWLEDGED', supplier: { portalEnabled: true } },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    take: 50,
    select: { id: true, number: true, sentAt: true, supplier: { select: { nameTh: true } } },
  })
  return rows.map((r) => ({ id: r.id, number: r.number, supplierName: r.supplier.nameTh, sentAt: r.sentAt?.toISOString() ?? null }))
}

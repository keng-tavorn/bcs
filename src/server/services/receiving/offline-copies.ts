import { err, ok, type Result } from '@/core/result'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { bcsGoSettingsOf } from '@/lib/s17-settings'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { listReceivingCandidates, RECEIVING_PAGE_SIZE } from '@/server/queries/receiving'
import { scopedIdempotencyKey } from '../_pipeline'
import { requireModule } from '../modules'
import { receivingDecision } from './access'
import { receiverOf } from './view'

// What the BCS Go app keeps on the phone to receive without a signal (S17-12, FR-PLT-301 AC5, BR-APP-03, BR-APP-04):
// copies of the POs the member may receive now — the scope and separation of duties of gr.post, decided per PO as the
// receiving list does — SENT or PARTIALLY_RECEIVED, the oldest sent first, at most bcsGo.maxPreparedPos. A copy holds
// what the receiving form needs and nothing of money: the number, the supplier, the site, each line's description,
// unit, ordered, received and cancelled quantities, the tolerance, the PO's version (the receipt sends it back), when
// it was prepared, and the token hashes of every printed copy's QR (DocumentVerification, superseded ones too, so a
// QR on an older printout still finds it, OQ-163). No price, amount, budget, account or contact.
// Module BCS_GO: a copy is prepared only while it is on (BR-APP-13); a receipt already queued is sent by gr.post,
// which is CORE. A member who receives nothing gets an empty list, never an error that says why.

export interface OfflinePoLineCopy {
  readonly poLineId: string
  readonly description: string
  readonly uom: string
  readonly ordered: string
  readonly received: string
  readonly cancelled: string
}

export interface OfflinePoCopy {
  readonly poId: string
  readonly number: string | null
  readonly version: number
  readonly status: 'SENT' | 'PARTIALLY_RECEIVED'
  readonly sentAt: string | null
  readonly supplier: string
  readonly site: string | null
  readonly overTolerancePct: number
  readonly lines: readonly OfflinePoLineCopy[]
  /** sha256 of every token printed on this PO's QR (BR-QR-01), the superseded ones too */
  readonly tokenHashes: readonly string[]
  readonly preparedAt: string
}

export interface OfflineCopiesDto {
  readonly copies: readonly OfflinePoCopy[]
  /** More POs could be received than the organization lets a phone keep (bcsGo.maxPreparedPos) */
  readonly truncated: boolean
  /** bcsGo.offlineRetentionDays: how long a copy and a queued receipt are kept on the phone */
  readonly retentionDays: number
}

const text = (q: { toString(): string }) => q.toString()

export async function prepareOfflineCopies(ctx: Ctx): Promise<Result<OfflineCopiesDto>> {
  const bcsGo = await requireModule(ctx, 'BCS_GO')
  if (!bcsGo.ok) return bcsGo
  const db = forTenant(ctx.organizationId)
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const { maxPreparedPos, offlineRetentionDays } = bcsGoSettingsOf(org.settings)
  const receiver = await receiverOf(ctx)
  if (!receiver.ok) return receiver
  if (!receiver.data) return ok({ copies: [], truncated: false, retentionDays: offlineRetentionDays })
  const { principal, sodPolicy, filter } = receiver.data
  const chosen: string[] = []
  let truncated = false
  for (let page = 1; ; page++) {
    const candidates = await listReceivingCandidates(ctx, { ...filter, page })
    for (const c of candidates.rows) {
      if (receivingDecision(principal, sodPolicy, c.parties).kind !== 'RECEIVE') continue
      if (chosen.length === maxPreparedPos) truncated = true
      else chosen.push(c.id)
    }
    if (truncated || page * RECEIVING_PAGE_SIZE >= candidates.total) break
  }
  if (chosen.length === 0) return ok({ copies: [], truncated, retentionDays: offlineRetentionDays })
  const tolerancePct = OrgSettingsSchema.shape.receiving.parse((org.settings as { receiving?: unknown } | null)?.receiving).overTolerancePct
  const [pos, prints] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { id: { in: chosen } },
      select: {
        id: true,
        number: true,
        version: true,
        status: true,
        sentAt: true,
        supplier: { select: { nameTh: true } },
        deliverySite: { select: { nameTh: true } },
        lines: { orderBy: { lineNo: 'asc' }, select: { id: true, description: true, uom: true, quantity: true, receivedQuantity: true, cancelledQuantity: true } },
      },
    }),
    db.documentVerification.findMany({ where: { subjectType: 'PURCHASE_ORDER', subjectId: { in: chosen } }, orderBy: { issuedAt: 'asc' }, select: { subjectId: true, tokenHash: true } }),
  ])
  const byId = new Map(pos.map((p) => [p.id, p]))
  const preparedAt = ctx.now.toISOString()
  const copies = chosen.flatMap((id): OfflinePoCopy[] => {
    const p = byId.get(id)
    if (!p || (p.status !== 'SENT' && p.status !== 'PARTIALLY_RECEIVED')) return []
    return [
      {
        poId: p.id,
        number: p.number,
        version: p.version,
        status: p.status,
        sentAt: p.sentAt?.toISOString() ?? null,
        supplier: p.supplier.nameTh,
        site: p.deliverySite?.nameTh ?? null,
        overTolerancePct: tolerancePct,
        lines: p.lines.map((l) => ({ poLineId: l.id, description: l.description, uom: l.uom, ordered: text(l.quantity), received: text(l.receivedQuantity), cancelled: text(l.cancelledQuantity) })),
        tokenHashes: prints.filter((v) => v.subjectId === p.id).map((v) => v.tokenHash),
        preparedAt,
      },
    ]
  })
  return ok({ copies, truncated, retentionDays: offlineRetentionDays })
}

/**
 * GET /api/go/receiving/gr?key= (BR-APP-07): what gr.post recorded for this key of the member signed in — the key is
 * looked up in the sender's own namespace of CommandLog, so another member's key is not found (FR-PLT-301 AC5). A
 * refusal that left no record (most do) reads as not recorded, and the phone asks the user.
 */
export async function recordedReceipt(ctx: Ctx, key: string): Promise<Result<{ readonly recorded: false } | { readonly recorded: true; readonly result: unknown }>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'members only')
  const row = await forTenant(ctx.organizationId).commandLog.findFirst({ where: { idempotencyKey: scopedIdempotencyKey(ctx.actor, key), commandName: 'gr.post' }, select: { result: true } })
  return ok(row ? { recorded: true, result: row.result } : { recorded: false })
}

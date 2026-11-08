import { satangToAmount } from '@/core/money/dto'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { portalWhere } from './db'

// What a contact reads of sourcing in the portal (S10-06 · INV-RFX-01 · BR-RFX-04 06): the RFx its supplier or application
// is invited to, its lines and amendments, the questions answered to everyone (never who asked) and its own, and its own
// bid — never another supplier's, never a count or a price of others. Every read goes through portalWhere (db.ts), and
// tests/generated/portal-isolation.test.ts calls every export of this file as two suppliers and two applications.

export interface PortalRfxRow {
  readonly id: string
  readonly number: string | null
  readonly kind: string
  readonly status: string
  readonly title: string
  readonly titleEn: string | null
  readonly closesAt: Date | null
  readonly inviteStatus: string
}

/** The contact's RFx, open ones first, newest first */
export async function listPortalRfx(ctx: Ctx): Promise<PortalRfxRow[]> {
  const db = forTenant(ctx.organizationId)
  const invites = await db.rfxInvite.findMany({ where: portalWhere(ctx, 'rfxInvite'), select: { rfxEventId: true, status: true } })
  const statusOf = new Map(invites.map((i) => [i.rfxEventId, i.status]))
  const rows = await db.rfxEvent.findMany({
    where: { AND: [portalWhere(ctx, 'rfxEvent'), { id: { in: [...statusOf.keys()] } }] },
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, number: true, kind: true, status: true, title: true, titleEn: true, closesAt: true },
  })
  return rows
    .map((r) => ({ ...r, inviteStatus: statusOf.get(r.id)! }))
    .sort((a, b) => Number(b.status === 'OPEN') - Number(a.status === 'OPEN'))
}

export interface PortalRfxDetail extends PortalRfxRow {
  readonly description: string
  readonly descriptionEn: string | null
  readonly questionCutoffAt: Date | null
  readonly revisionNo: number
  readonly allowPartialBids: boolean
  readonly allowVatInclusiveBids: boolean
  readonly needsReconfirm: boolean
  readonly lines: ReadonlyArray<{ readonly id: string; readonly lineNo: number; readonly description: string; readonly descriptionEn: string | null; readonly quantity: string; readonly uom: string; readonly uomEn: string | null }>
  readonly amendments: ReadonlyArray<{ readonly revisionNo: number; readonly summary: string; readonly summaryEn: string | null; readonly createdAt: Date }>
  readonly questions: ReadonlyArray<{ readonly id: string; readonly question: string; readonly answer: string | null; readonly mine: boolean; readonly askedAt: Date }>
  readonly bid: {
    readonly id: string
    readonly status: string
    readonly version: number
    readonly submitCount: number
    readonly priceIncludesVat: boolean
    readonly net: string
    readonly vat: string
    readonly gross: string
    readonly validUntil: Date | null
    readonly lines: ReadonlyArray<{ readonly rfxLineId: string; readonly offered: boolean; readonly unitPrice: string | null }>
  } | null
}

/** One RFx of the contact with its lines, amendments, questions and the contact's own bid; the first one without an id */
export async function portalRfx(ctx: Ctx, rfxEventId?: string): Promise<PortalRfxDetail | null> {
  const db = forTenant(ctx.organizationId)
  const invite = await db.rfxInvite.findFirst({
    where: { AND: [portalWhere(ctx, 'rfxInvite'), rfxEventId ? { rfxEventId } : {}] },
    orderBy: [{ invitedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, rfxEventId: true, status: true, needsReconfirm: true },
  })
  if (!invite) return null
  const rfx = await db.rfxEvent.findFirst({ where: { AND: [portalWhere(ctx, 'rfxEvent'), { id: invite.rfxEventId }] } })
  if (!rfx) return null
  const [lines, amendments, questions, bid] = await Promise.all([
    db.rfxLine.findMany({ where: { AND: [portalWhere(ctx, 'rfxLine'), { rfxEventId: rfx.id }] }, orderBy: { lineNo: 'asc' } }),
    db.rfxAmendment.findMany({ where: { AND: [portalWhere(ctx, 'rfxAmendment'), { rfxEventId: rfx.id }] }, orderBy: { revisionNo: 'asc' } }),
    db.rfxQuestion.findMany({ where: { AND: [portalWhere(ctx, 'rfxQuestion'), { rfxEventId: rfx.id }] }, orderBy: [{ askedAt: 'asc' }, { id: 'asc' }] }),
    db.bid.findFirst({ where: { AND: [portalWhere(ctx, 'bid'), { rfxEventId: rfx.id }] } }),
  ])
  const bidLines = bid ? await db.bidLine.findMany({ where: { AND: [portalWhere(ctx, 'bidLine'), { bidId: bid.id }] } }) : []
  return {
    id: rfx.id,
    number: rfx.number,
    kind: rfx.kind,
    status: rfx.status,
    title: rfx.title,
    titleEn: rfx.titleEn,
    closesAt: rfx.closesAt,
    inviteStatus: invite.status,
    description: rfx.description,
    descriptionEn: rfx.descriptionEn,
    questionCutoffAt: rfx.questionCutoffAt,
    revisionNo: rfx.revisionNo,
    allowPartialBids: rfx.allowPartialBids,
    allowVatInclusiveBids: rfx.allowVatInclusiveBids,
    needsReconfirm: invite.needsReconfirm,
    lines: lines.map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, descriptionEn: l.descriptionEn, quantity: l.quantity.toString(), uom: l.uom, uomEn: l.uomEn })),
    amendments: amendments.map((a) => ({ revisionNo: a.revisionNo, summary: a.summary, summaryEn: a.summaryEn, createdAt: a.createdAt })),
    // who asked is never shown; the contact's own question is marked so the page can say "your question"
    questions: questions.map((q) => ({ id: q.id, question: q.question, answer: q.status === 'ANSWERED' ? q.answer : null, mine: q.inviteId === invite.id, askedAt: q.askedAt })),
    bid: bid
      ? {
          id: bid.id,
          status: bid.status,
          version: bid.version,
          submitCount: bid.submitCount,
          priceIncludesVat: bid.priceIncludesVat,
          net: satangToAmount(bid.netSatang),
          vat: satangToAmount(bid.vatSatang),
          gross: satangToAmount(bid.grossSatang),
          validUntil: bid.validUntil,
          lines: bidLines.map((l) => ({ rfxLineId: l.rfxLineId, offered: l.offered, unitPrice: l.unitPriceSatang === null ? null : satangToAmount(l.unitPriceSatang) })),
        }
      : null,
  }
}

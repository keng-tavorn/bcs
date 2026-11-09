import { satangToAmount } from '@/core/money/dto'
import { netUnitPriceCeiling } from '@/core/sourcing'
import { rateFor, taxDateOf } from '@/core/vat'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { forTenant } from '@/server/db/tenant'
import { portalWhere } from './db'

// What a contact reads of sourcing in the portal (S10-06 S10-07 · INV-RFX-01 · BR-RFX-04 06 07): the RFx its supplier or
// application is invited to, its lines, files and amendments, the questions answered to everyone (never who asked) and
// its own, its own bid with its files, and the lines awarded to it — never another supplier's, never a count or a price
// of others. Every read goes through portalWhere (db.ts), and tests/generated/portal-isolation.test.ts calls every export
// of this file as two suppliers and two applications.

/** The contact's own state on an RFx, in the words of the list (docs/sub-specs/S10.md "/portal/rfx") */
export type PortalRfxStatus = 'NOT_SUBMITTED' | 'DRAFT' | 'SUBMITTED' | 'RECONFIRM' | 'DECLINED' | 'CLOSED' | 'AWARDED' | 'NOT_AWARDED' | 'CANCELLED'

/** The states in which the contact still has something to do before the close (the home's row "RFx รอยื่น") */
export const PORTAL_RFX_TO_DO: ReadonlySet<PortalRfxStatus> = new Set(['NOT_SUBMITTED', 'DRAFT', 'RECONFIRM'])

function statusOf(
  rfx: { readonly status: string; readonly closesAt: Date | null },
  invite: { readonly status: string; readonly needsReconfirm: boolean },
  bidStatus: string | null,
  awarded: boolean,
  now: Date,
): PortalRfxStatus {
  if (rfx.status === 'CANCELLED') return 'CANCELLED'
  if (invite.status === 'DECLINED') return 'DECLINED'
  if (rfx.status === 'AWARDED') return awarded ? 'AWARDED' : bidStatus === 'SUBMITTED' || bidStatus === 'DISQUALIFIED' ? 'NOT_AWARDED' : 'CLOSED'
  // at closesAt exactly the RFx is closed for bids (BR-RFX-02), whatever the job's timing
  if (rfx.status !== 'OPEN' || !rfx.closesAt || now.getTime() >= rfx.closesAt.getTime() || invite.status === 'EXPIRED') return 'CLOSED'
  if (bidStatus === 'SUBMITTED') return invite.needsReconfirm ? 'RECONFIRM' : 'SUBMITTED'
  return bidStatus === 'DRAFT' ? 'DRAFT' : 'NOT_SUBMITTED'
}

export interface PortalRfxRow {
  readonly id: string
  readonly number: string | null
  readonly kind: string
  readonly status: string
  readonly title: string
  readonly titleEn: string | null
  readonly closesAt: Date | null
  readonly inviteStatus: string
  readonly portalStatus: PortalRfxStatus
}

/** The contact's RFx: the ones with something to do first, then open ones, newest first */
export async function listPortalRfx(ctx: Ctx): Promise<PortalRfxRow[]> {
  const db = forTenant(ctx.organizationId)
  const invites = await db.rfxInvite.findMany({ where: portalWhere(ctx, 'rfxInvite'), select: { rfxEventId: true, status: true, needsReconfirm: true } })
  const inviteOf = new Map(invites.map((i) => [i.rfxEventId, i]))
  const ids = [...inviteOf.keys()]
  const [rows, bids, awarded] = await Promise.all([
    db.rfxEvent.findMany({
      where: { AND: [portalWhere(ctx, 'rfxEvent'), { id: { in: ids } }] },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, number: true, kind: true, status: true, title: true, titleEn: true, closesAt: true },
    }),
    db.bid.findMany({ where: { AND: [portalWhere(ctx, 'bid'), { rfxEventId: { in: ids } }] }, select: { rfxEventId: true, status: true } }),
    db.awardLine.findMany({ where: { AND: [portalWhere(ctx, 'awardLine'), { awardDecision: { rfxEventId: { in: ids } } }] }, select: { awardDecision: { select: { rfxEventId: true } } } }),
  ])
  const bidOf = new Map(bids.map((b) => [b.rfxEventId, b.status]))
  const won = new Set(awarded.map((a) => a.awardDecision.rfxEventId))
  const rank = (r: PortalRfxRow) => (PORTAL_RFX_TO_DO.has(r.portalStatus) ? 0 : r.status === 'OPEN' ? 1 : 2)
  return rows
    .map((r) => {
      const invite = inviteOf.get(r.id)!
      return { ...r, inviteStatus: invite.status, portalStatus: statusOf(r, invite, bidOf.get(r.id) ?? null, won.has(r.id), ctx.now) }
    })
    .sort((a, b) => rank(a) - rank(b))
}

/** The home's row (S7's home · one row): RFx the contact is invited to, and those still waiting for its bid */
export async function portalRfxSummary(ctx: Ctx): Promise<{ readonly invited: number; readonly toDo: number }> {
  const rows = await listPortalRfx(ctx)
  return { invited: rows.length, toDo: rows.filter((r) => PORTAL_RFX_TO_DO.has(r.portalStatus)).length }
}

/**
 * Where a contact lands after signing in by the one-time link of an RFx's invite (purpose RFX_INVITE): that RFx, else
 * the list; '' when the link it used was not an RFx's
 */
export async function portalRfxLanding(ctx: Ctx): Promise<string> {
  const db = forTenant(ctx.organizationId)
  const link = await db.portalInviteLink.findFirst({ where: { AND: [portalWhere(ctx, 'portalInviteLink'), { usedAt: { not: null } }] }, orderBy: { usedAt: 'desc' }, select: { id: true, purpose: true } })
  if (link?.purpose !== 'RFX_INVITE') return ''
  const invite = await db.rfxInvite.findFirst({ where: { AND: [portalWhere(ctx, 'rfxInvite'), { linkId: link.id }, { rfxEvent: { status: { not: 'DRAFT' } } }] }, select: { rfxEventId: true } })
  return invite ? `/rfx/${invite.rfxEventId}` : '/rfx'
}

/** Who may bid: an ACTIVE supplier; the contact of an application waits for its approval (OQ-202) */
export type PortalBidder = 'SUPPLIER' | 'APPLICATION' | 'NOT_ACTIVE'

export interface PortalRfxDetail extends PortalRfxRow {
  readonly description: string
  readonly descriptionEn: string | null
  readonly questionCutoffAt: Date | null
  readonly revisionNo: number
  readonly allowPartialBids: boolean
  readonly bidValidityDays: number
  readonly needsReconfirm: boolean
  readonly bidder: PortalBidder
  /** The supplier is registered for VAT (and not cancelled by the register · BR-VAT-04) */
  readonly supplierVatRegistered: boolean
  /** The RFx takes prices with VAT included and the supplier may quote them (OQ-212 · BR-RFX-07) */
  readonly vatInclusiveAllowed: boolean
  /** The rate a bid sent now takes (0 when not registered or abroad); null when no rate covers today */
  readonly vatRateBp: number | null
  readonly lines: ReadonlyArray<{ readonly id: string; readonly lineNo: number; readonly description: string; readonly descriptionEn: string | null; readonly quantity: string; readonly uom: string; readonly uomEn: string | null; readonly requiredDeliveryOn: Date | null }>
  /** The RFx's own files (RFX_DOC) */
  readonly files: ReadonlyArray<{ readonly id: string; readonly fileName: string; readonly sizeBytes: number }>
  readonly amendments: ReadonlyArray<{ readonly revisionNo: number; readonly summary: string; readonly summaryEn: string | null; readonly createdAt: Date }>
  readonly questions: ReadonlyArray<{ readonly id: string; readonly question: string; readonly answer: string | null; readonly mine: boolean; readonly askedAt: Date }>
  readonly bid: {
    readonly id: string
    readonly status: string
    readonly version: number
    readonly submitCount: number
    readonly submittedAt: Date | null
    readonly priceIncludesVat: boolean
    readonly net: string
    readonly vat: string
    readonly gross: string
    readonly validUntil: Date | null
    readonly deliveryDays: number | null
    readonly promisedDeliveryOn: Date | null
    readonly note: string | null
    readonly lines: ReadonlyArray<{ readonly rfxLineId: string; readonly offered: boolean; readonly unitPrice: string | null }>
    readonly files: ReadonlyArray<{ readonly id: string; readonly fileName: string; readonly scanStatus: string }>
  } | null
  /** The lines an approved award gives the supplier, before VAT; empty when it won none */
  readonly awardedLines: ReadonlyArray<{ readonly lineNo: number; readonly description: string; readonly descriptionEn: string | null; readonly quantity: string; readonly uom: string; readonly uomEn: string | null; readonly unitPrice: string; readonly lineNet: string }>
  /**
   * S10-11 (OQ-212): the winner bid with VAT included and the award waits for its prices before VAT — each line it won with
   * its price as bid, the highest price before VAT it may give (⌊bid × 10000 ÷ (10000 + rate)⌋) and the one it gave;
   * null otherwise
   */
  readonly priceConfirm: {
    readonly vatRateBp: number
    readonly confirmedAt: Date | null
    readonly lines: ReadonlyArray<{ readonly rfxLineId: string; readonly lineNo: number; readonly quotedUnitPrice: string; readonly maxNetUnitPrice: string; readonly confirmedNetUnitPrice: string | null }>
  } | null
}

/** One RFx of the contact with its lines, files, amendments, questions, the contact's own bid and what it was awarded; the first one without an id */
export async function portalRfx(ctx: Ctx, rfxEventId?: string): Promise<PortalRfxDetail | null> {
  const db = forTenant(ctx.organizationId)
  const invite = await db.rfxInvite.findFirst({
    // an invite of an RFx still in DRAFT leads nowhere: the contact cannot see that RFx yet
    where: { AND: [portalWhere(ctx, 'rfxInvite'), { rfxEvent: { status: { not: 'DRAFT' } } }, rfxEventId ? { rfxEventId } : {}] },
    orderBy: [{ invitedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, rfxEventId: true, status: true, needsReconfirm: true },
  })
  if (!invite) return null
  const rfx = await db.rfxEvent.findFirst({ where: { AND: [portalWhere(ctx, 'rfxEvent'), { id: invite.rfxEventId }] } })
  if (!rfx) return null
  const [lines, amendments, questions, bid, supplier, rfxFiles, awarded] = await Promise.all([
    db.rfxLine.findMany({ where: { AND: [portalWhere(ctx, 'rfxLine'), { rfxEventId: rfx.id }] }, orderBy: { lineNo: 'asc' } }),
    db.rfxAmendment.findMany({ where: { AND: [portalWhere(ctx, 'rfxAmendment'), { rfxEventId: rfx.id }] }, orderBy: { revisionNo: 'asc' } }),
    db.rfxQuestion.findMany({ where: { AND: [portalWhere(ctx, 'rfxQuestion'), { rfxEventId: rfx.id }] }, orderBy: [{ askedAt: 'asc' }, { id: 'asc' }] }),
    db.bid.findFirst({ where: { AND: [portalWhere(ctx, 'bid'), { rfxEventId: rfx.id }] } }),
    db.supplier.findFirst({ where: portalWhere(ctx, 'supplier'), select: { status: true, isVatRegistered: true, isForeign: true, registryFlag: true } }),
    // subjectId pins the RFx read through portalWhere above (db.ts: a file link names its subject by id only)
    db.fileLink.findMany({ where: { AND: [portalWhere(ctx, 'fileLink'), { kind: 'RFX_DOC', subjectType: 'RfxEvent', subjectId: rfx.id }] }, orderBy: { createdAt: 'asc' }, select: { file: { select: { id: true, fileName: true, sizeBytes: true } } } }),
    db.awardLine.findMany({ where: { AND: [portalWhere(ctx, 'awardLine'), { awardDecision: { rfxEventId: rfx.id } }] }, include: { rfxLine: true, awardDecision: { select: { poStatus: true } } } }),
  ])
  const [bidLines, bidFiles] = bid
    ? await Promise.all([
        db.bidLine.findMany({ where: { AND: [portalWhere(ctx, 'bidLine'), { bidId: bid.id }] } }),
        db.fileLink.findMany({ where: { AND: [portalWhere(ctx, 'fileLink'), { kind: 'BID_DOC', subjectType: 'Bid', subjectId: bid.id }] }, orderBy: { createdAt: 'asc' }, select: { file: { select: { id: true, fileName: true, scanStatus: true } } } }),
      ])
    : [[], []]
  const vatRegistered = Boolean(supplier?.isVatRegistered && supplier.registryFlag !== 'VAT_CANCELLED')
  // BR-VAT-01 04: the rate of today for a registered supplier in Thailand, 0 otherwise (as bid.submit takes it)
  let vatRateBp: number | null = 0
  if (vatRegistered && !supplier?.isForeign) {
    const rate = rateFor(taxDateOf(ctx.now), await listTaxRates())
    vatRateBp = rate.ok ? rate.rateBp : null
  }
  // OQ-212: what the winner who bid with VAT confirms, while its award waits for it
  const confirming = bid?.priceIncludesVat && awarded.some((a) => a.bidId === bid.id && a.awardDecision.poStatus === 'PENDING_PRICE')
  const priceConfirm = confirming
    ? {
        vatRateBp: bid.vatRateBp ?? 0,
        confirmedAt: bid.netPricesConfirmedAt,
        lines: awarded
          .filter((a) => a.bidId === bid.id)
          .sort((a, b) => a.rfxLine.lineNo - b.rfxLine.lineNo)
          .flatMap((a) => {
            const line = bidLines.find((l) => l.rfxLineId === a.rfxLineId)
            if (!line?.unitPriceSatang) return []
            return [{ rfxLineId: a.rfxLineId, lineNo: a.rfxLine.lineNo, quotedUnitPrice: satangToAmount(line.unitPriceSatang), maxNetUnitPrice: satangToAmount(netUnitPriceCeiling(bid.vatRateBp ?? 0, line.unitPriceSatang)), confirmedNetUnitPrice: line.confirmedNetUnitPriceSatang === null ? null : satangToAmount(line.confirmedNetUnitPriceSatang) }]
          }),
      }
    : null
  const bidder: PortalBidder = ctx.actor.type === 'SUPPLIER' && !ctx.actor.supplierId ? 'APPLICATION' : supplier?.status === 'ACTIVE' ? 'SUPPLIER' : 'NOT_ACTIVE'
  return {
    id: rfx.id,
    number: rfx.number,
    kind: rfx.kind,
    status: rfx.status,
    title: rfx.title,
    titleEn: rfx.titleEn,
    closesAt: rfx.closesAt,
    inviteStatus: invite.status,
    portalStatus: statusOf(rfx, invite, bid?.status ?? null, awarded.length > 0, ctx.now),
    description: rfx.description,
    descriptionEn: rfx.descriptionEn,
    questionCutoffAt: rfx.questionCutoffAt,
    revisionNo: rfx.revisionNo,
    allowPartialBids: rfx.allowPartialBids,
    bidValidityDays: rfx.bidValidityDays,
    needsReconfirm: invite.needsReconfirm,
    bidder,
    supplierVatRegistered: vatRegistered,
    vatInclusiveAllowed: rfx.allowVatInclusiveBids && vatRegistered,
    vatRateBp,
    lines: lines.map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, descriptionEn: l.descriptionEn, quantity: l.quantity.toString(), uom: l.uom, uomEn: l.uomEn, requiredDeliveryOn: l.requiredDeliveryOn })),
    files: rfxFiles.map((f) => ({ id: f.file.id, fileName: f.file.fileName, sizeBytes: f.file.sizeBytes })),
    amendments: amendments.map((a) => ({ revisionNo: a.revisionNo, summary: a.summary, summaryEn: a.summaryEn, createdAt: a.createdAt })),
    // who asked is never shown; the contact's own question is marked so the page can say "your question"
    questions: questions.map((q) => ({ id: q.id, question: q.question, answer: q.status === 'ANSWERED' ? q.answer : null, mine: q.inviteId === invite.id, askedAt: q.askedAt })),
    bid: bid
      ? {
          id: bid.id,
          status: bid.status,
          version: bid.version,
          submitCount: bid.submitCount,
          submittedAt: bid.submittedAt,
          priceIncludesVat: bid.priceIncludesVat,
          net: satangToAmount(bid.netSatang),
          vat: satangToAmount(bid.vatSatang),
          gross: satangToAmount(bid.grossSatang),
          validUntil: bid.validUntil,
          deliveryDays: bid.deliveryDays,
          promisedDeliveryOn: bid.promisedDeliveryOn,
          note: bid.note,
          lines: bidLines.map((l) => ({ rfxLineId: l.rfxLineId, offered: l.offered, unitPrice: l.unitPriceSatang === null ? null : satangToAmount(l.unitPriceSatang) })),
          files: bidFiles.map((f) => ({ id: f.file.id, fileName: f.file.fileName, scanStatus: f.file.scanStatus })),
        }
      : null,
    awardedLines: awarded
      .sort((a, b) => a.rfxLine.lineNo - b.rfxLine.lineNo)
      .map((a) => ({
        lineNo: a.rfxLine.lineNo,
        description: a.rfxLine.description,
        descriptionEn: a.rfxLine.descriptionEn,
        quantity: a.quantity.toString(),
        uom: a.rfxLine.uom,
        uomEn: a.rfxLine.uomEn,
        unitPrice: satangToAmount(a.unitPriceSatang),
        lineNet: satangToAmount(a.lineNetSatang),
      })),
    priceConfirm,
  }
}

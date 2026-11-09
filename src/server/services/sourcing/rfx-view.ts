import { satangToAmount } from '@/core/money/dto'
import type { Result } from '@/core/result'
import { RFX_EVENT_MACHINE, transition, type RfxEventCommand, type RfxEventState } from '@/core/state-machines'
import { presignDownload } from '@/integrations/storage'
import { opensInline } from '@/lib/file-types'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { enabledModules, requireModule } from '../modules'
import { rfxReading, type RfxReading } from './access'
import { comparisonOf, type RfxComparison } from './comparison'
import { rankingOf } from './ranking'
import { supplierRiskStatus } from './risk-link'

// The internal page of one RFx (S10-12 · /sourcing/[id] · docs/sub-specs/S10.md "หน้าจอ"): its state, deadlines, lines,
// timeline, invites, questions, revisions, bids, scores and awards, read in one transaction for the page. sourcing.view
// is asked with the RFx as its resource (rfxReading · access.ts): a PRICES reader (procurement finance executives
// auditors, its evaluators and the approvers of its award) reads everything the envelope lets out — before the close of
// a sealed RFx only how many bids came and from whom (BR-RFX-06); a STATE reader (a requester of a source line) reads the
// state, the lines, the deadlines and the timeline, never a price, a reference price, a bid, a score, an invite or a
// question. The commands the page offers follow the state machine and sourcing.manage; the services check them again.
// Money as baht text, dates as ISO text: the DTO crosses to the browser as it is.

export interface NameTextDto {
  readonly th: string
  readonly en: string | null
}

export type RfxTimelineActor = { readonly kind: 'MEMBER'; readonly name: NameTextDto } | { readonly kind: 'SYSTEM' } | { readonly kind: 'SUPPLIER' }

export interface RfxDetailDto {
  readonly reading: RfxReading
  readonly rfx: {
    readonly id: string
    readonly number: string | null
    readonly kind: string
    readonly status: string
    readonly title: string
    readonly titleEn: string | null
    readonly description: string
    readonly descriptionEn: string | null
    readonly categoryCode: string
    readonly sourceKind: string
    readonly sealed: boolean
    readonly allowPartialBids: boolean
    readonly allowVatInclusiveBids: boolean
    readonly bidValidityDays: number
    readonly minInvites: number
    readonly revisionNo: number
    readonly version: number
    readonly createdAt: string
    readonly openedAt: string | null
    readonly closesAt: string | null
    readonly questionCutoffAt: string | null
    readonly closedAt: string | null
    readonly cancelledAt: string | null
    readonly cancelReason: string | null
    readonly conclusionNote: string | null
    readonly createdBy: NameTextDto | null
    readonly requestingDepartment: NameTextDto | null
    /** Before closesAt (or still a draft): invites, answers and amendments go on */
    readonly beforeClose: boolean
  }
  readonly lines: ReadonlyArray<{
    readonly id: string
    readonly lineNo: number
    readonly description: string
    readonly descriptionEn: string | null
    readonly quantity: string
    readonly uom: string
    readonly uomEn: string | null
    readonly deliverySite: { readonly code: string; readonly name: string } | null
    readonly requiredDeliveryOn: string | null
    readonly note: string | null
    /** PRICES readers only */
    readonly reference: { readonly unitPrice: string; readonly source: string | null } | null
    /** How many request lines it brings in (a need: 0) */
    readonly sourceCount: number
  }>
  readonly timeline: ReadonlyArray<{ readonly id: string; readonly type: string; readonly occurredAt: string; readonly actor: RfxTimelineActor }>
  /** PRICES readers; empty for a STATE reader */
  readonly invites: ReadonlyArray<{
    readonly id: string
    readonly status: string
    readonly name: string
    readonly supplierCode: string | null
    /** An application of S7 not approved yet when invited (OQ-202) */
    readonly application: boolean
    readonly invitedAt: string
    readonly viewedAt: string | null
    readonly declinedAt: string | null
    readonly declineReason: string | null
    readonly removedAt: string | null
    readonly removeReason: string | null
    readonly needsReconfirm: boolean
    readonly snapshot: { readonly isVatRegistered: boolean | null; readonly isForeign: boolean | null; readonly registryFlag: string | null; readonly requiredDocumentsOk: boolean | null }
    /** With RISK on: S11's tier and status of the supplier today */
    readonly risk: { readonly tier: string | null; readonly status: string | null; readonly blocked: boolean } | null
  }>
  /** PRICES readers; empty for a STATE reader */
  readonly questions: ReadonlyArray<{
    readonly id: string
    readonly status: string
    readonly question: string
    readonly askedAt: string
    readonly askerName: string
    readonly answer: string | null
    readonly answeredAt: string | null
    readonly answeredBy: NameTextDto | null
    readonly visibility: string
  }>
  readonly amendments: ReadonlyArray<{
    readonly revisionNo: number
    readonly summary: string
    readonly summaryEn: string | null
    readonly changedFields: readonly string[]
    readonly previousClosesAt: string | null
    readonly newClosesAt: string | null
    readonly createdAt: string
    readonly createdBy: NameTextDto | null
  }>
  /** PRICES readers; null for a STATE reader */
  readonly bids: {
    /** Before the close of a sealed RFx: no price, only who sent */
    readonly sealed: boolean
    readonly submitters: ReadonlyArray<{ readonly name: string; readonly needsReconfirm: boolean }>
    readonly comparison: RfxComparison | null
    /** Once the envelope is open: each bid's terms and files, for its sheet */
    readonly details: ReadonlyArray<{
      readonly bidId: string
      readonly submittedAt: string | null
      readonly submitCount: number
      readonly onBehalf: boolean
      readonly priceIncludesVat: boolean
      readonly validUntil: string | null
      readonly deliveryDays: number | null
      readonly promisedDeliveryOn: string | null
      readonly note: string | null
      readonly lines: ReadonlyArray<{ readonly rfxLineId: string; readonly brand: string | null; readonly leadTimeDays: number | null; readonly note: string | null }>
      readonly files: ReadonlyArray<{ readonly id: string; readonly name: string; readonly scan: string; readonly openable: boolean }>
    }>
  } | null
  /** PRICES readers with a scorecard; null otherwise */
  readonly scores: {
    readonly status: string
    readonly minEvaluators: number
    readonly criteria: ReadonlyArray<{ readonly code: string; readonly name: NameTextDto; readonly kind: string; readonly weightBp: number }>
    readonly evaluators: ReadonlyArray<{ readonly memberId: string; readonly name: NameTextDto; readonly status: string; readonly submittedAt: string | null }>
    /** Once REVEALED: best first */
    readonly ranking: ReadonlyArray<{ readonly bidId: string; readonly supplierName: string; readonly rank: number; readonly priceBp: number; readonly criteria: Readonly<Record<string, number>>; readonly totalBp: number }> | null
  } | null
  /** PRICES readers: every award of the RFx, newest first */
  readonly awards: ReadonlyArray<{
    readonly id: string
    readonly number: string | null
    readonly status: string
    readonly isSplit: boolean
    readonly net: string
    readonly vat: string
    readonly gross: string
    readonly poStatus: string
    readonly submittedAt: string | null
    readonly decidedAt: string | null
    readonly cancelReason: string | null
    readonly purchaseOrders: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly status: string; readonly supplierName: string; readonly gross: string }>
    readonly priceAgreements: number
  }>
  readonly modules: { readonly risk: boolean }
  /** What the reader may do now; the services check every command again */
  readonly can: {
    readonly manage: boolean
    readonly award: boolean
    /** An evaluator of its scorecard (the score page) */
    readonly score: boolean
    readonly cancel: boolean
    readonly closeEarly: boolean
    readonly conclude: boolean
    readonly amend: boolean
    readonly extend: boolean
    readonly answer: boolean
    readonly invite: boolean
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const notFound = <T>(): Result<T> => ({ ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } })
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)
const isoDay = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null)
const nameOf = (m: { displayNameTh: string; displayNameEn: string | null } | null | undefined): NameTextDto | null => (m ? { th: m.displayNameTh, en: m.displayNameEn } : null)
const allowed = (status: RfxEventState, command: RfxEventCommand) => transition(RFX_EVENT_MACHINE, status, command).ok
const BEFORE_CLOSE = new Set(['DRAFT', 'OPEN'])
/** A file a member may open: stored, and clean by S7's scan (or a member's own upload, which is not scanned) */
const OPENABLE_SCAN = new Set(['CLEAN', 'NOT_REQUIRED'])
const MEMBER = { select: { displayNameTh: true, displayNameEn: true } } as const

function snapshotOf(raw: unknown): RfxDetailDto['invites'][number]['snapshot'] {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : null)
  return { isVatRegistered: bool(s.isVatRegistered), isForeign: bool(s.isForeign), registryFlag: typeof s.registryFlag === 'string' ? s.registryFlag : null, requiredDocumentsOk: bool(s.requiredDocumentsOk) }
}

async function bidsOf(tx: TenantTx, organizationId: string, rfx: { id: string; status: string; sealed: boolean }, now: Date): Promise<NonNullable<RfxDetailDto['bids']>> {
  const sent = await tx.rfxInvite.findMany({
    where: { rfxEventId: rfx.id, status: 'BID_SUBMITTED' },
    orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
    select: { needsReconfirm: true, supplier: { select: { nameTh: true } }, application: { select: { nameTh: true } } },
  })
  const submitters = sent.map((i) => ({ name: i.supplier?.nameTh ?? i.application?.nameTh ?? '', needsReconfirm: i.needsReconfirm }))
  const comparison = await comparisonOf(tx, organizationId, rfx.id, now)
  // BR-RFX-06: nothing of a bid's terms or files before the close of a sealed RFx
  if (!comparison || comparison.sealed) return { sealed: true, submitters, comparison: null, details: [] }
  const ids = comparison.bids.map((b) => b.bidId)
  const rows = ids.length
    ? await tx.bid.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          submittedAt: true,
          submitCount: true,
          submittedByMemberId: true,
          priceIncludesVat: true,
          validUntil: true,
          deliveryDays: true,
          promisedDeliveryOn: true,
          note: true,
          lines: { select: { rfxLineId: true, brand: true, leadTimeDays: true, note: true } },
        },
      })
    : []
  const links = ids.length
    ? await tx.fileLink.findMany({ where: { subjectType: 'Bid', subjectId: { in: ids }, kind: 'BID_DOC' }, orderBy: { id: 'asc' }, select: { subjectId: true, file: { select: { id: true, fileName: true, status: true, scanStatus: true } } } })
    : []
  const byId = new Map(rows.map((b) => [b.id, b]))
  return {
    sealed: false,
    submitters,
    comparison,
    details: ids.flatMap((id) => {
      const b = byId.get(id)
      if (!b) return []
      return [
        {
          bidId: b.id,
          submittedAt: iso(b.submittedAt),
          submitCount: b.submitCount,
          onBehalf: b.submittedByMemberId !== null,
          priceIncludesVat: b.priceIncludesVat,
          validUntil: isoDay(b.validUntil),
          deliveryDays: b.deliveryDays,
          promisedDeliveryOn: isoDay(b.promisedDeliveryOn),
          note: b.note,
          lines: b.lines.map((l) => ({ rfxLineId: l.rfxLineId, brand: l.brand, leadTimeDays: l.leadTimeDays, note: l.note })),
          files: links
            .filter((l) => l.subjectId === b.id && l.file.scanStatus !== 'INFECTED')
            .map((l) => ({ id: l.file.id, name: l.file.fileName, scan: l.file.scanStatus, openable: l.file.status === 'AVAILABLE' && OPENABLE_SCAN.has(l.file.scanStatus) })),
        },
      ]
    }),
  }
}

async function scoresOf(tx: TenantTx, scorecardId: string, supplierOfBid: ReadonlyMap<string, string>): Promise<NonNullable<RfxDetailDto['scores']>> {
  const card = await tx.scorecard.findUniqueOrThrow({
    where: { id: scorecardId },
    select: {
      id: true,
      status: true,
      minEvaluators: true,
      criteria: { orderBy: { sortOrder: 'asc' }, select: { code: true, nameTh: true, nameEn: true, kind: true, weightBp: true } },
      evaluators: { orderBy: { assignedAt: 'asc' }, select: { memberId: true, status: true, submittedAt: true, member: MEMBER } },
    },
  })
  const ranking = card.status === 'REVEALED' ? (await rankingOf(tx, card.id)).rows : null
  return {
    status: card.status,
    minEvaluators: card.minEvaluators,
    criteria: card.criteria.map((c) => ({ code: c.code, name: { th: c.nameTh, en: c.nameEn }, kind: c.kind, weightBp: c.weightBp })),
    evaluators: card.evaluators.map((e) => ({ memberId: e.memberId, name: nameOf(e.member)!, status: e.status, submittedAt: iso(e.submittedAt) })),
    ranking: ranking ? ranking.map((r) => ({ bidId: r.bidId, supplierName: supplierOfBid.get(r.bidId) ?? '', rank: r.rank, priceBp: r.priceBp, criteria: r.criteria, totalBp: r.totalBp })) : null,
  }
}

async function awardsOf(tx: TenantTx, rfxEventId: string): Promise<RfxDetailDto['awards']> {
  const awards = await tx.awardDecision.findMany({
    where: { rfxEventId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, number: true, status: true, isSplit: true, netSatang: true, vatSatang: true, grossSatang: true, poStatus: true, submittedAt: true, decidedAt: true, cancelReason: true, priceAgreementIds: true },
  })
  const approved = awards.filter((a) => a.status === 'APPROVED').map((a) => a.id)
  const pos = approved.length
    ? await tx.purchaseOrder.findMany({ where: { awardDecisionId: { in: approved } }, orderBy: [{ grossSatang: 'desc' }, { id: 'asc' }], select: { id: true, number: true, status: true, grossSatang: true, awardDecisionId: true, supplier: { select: { nameTh: true } } } })
    : []
  return awards.map((a) => ({
    id: a.id,
    number: a.number,
    status: a.status,
    isSplit: a.isSplit,
    net: satangToAmount(a.netSatang),
    vat: satangToAmount(a.vatSatang),
    gross: satangToAmount(a.grossSatang),
    poStatus: a.poStatus,
    submittedAt: iso(a.submittedAt),
    decidedAt: iso(a.decidedAt),
    cancelReason: a.cancelReason,
    purchaseOrders: pos.filter((p) => p.awardDecisionId === a.id).map((p) => ({ id: p.id, number: p.number, status: p.status, supplierName: p.supplier.nameTh, gross: satangToAmount(p.grossSatang) })),
    priceAgreements: a.status === 'APPROVED' && Array.isArray(a.priceAgreementIds) ? a.priceAgreementIds.length : 0,
  }))
}

/** The page /sourcing/[id]: NOT_FOUND, MODULE_DISABLED (SOURCING off) or FORBIDDEN (neither a PRICES nor a STATE reader) */
export async function rfxDetail(ctx: Ctx, rfxEventId: string): Promise<Result<RfxDetailDto>> {
  if (!UUID.test(rfxEventId)) return notFound()
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<RfxDetailDto>> => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const rfx = await tx.rfxEvent.findUnique({
      where: { id: rfxEventId },
      include: { createdBy: MEMBER, requestingDepartment: { select: { nameTh: true, nameEn: true } } },
    })
    if (!rfx) return notFound()
    const may = await rfxReading(tx, ctx, rfx.id)
    if (!may.ok) return may
    const prices = may.data === 'PRICES'
    const now = ctx.now

    const lines = await tx.rfxLine.findMany({
      where: { rfxEventId: rfx.id },
      orderBy: { lineNo: 'asc' },
      select: {
        id: true,
        lineNo: true,
        description: true,
        descriptionEn: true,
        quantity: true,
        uom: true,
        uomEn: true,
        requiredDeliveryOn: true,
        note: true,
        refUnitPriceSatang: true,
        refSource: true,
        deliverySite: { select: { code: true, nameTh: true } },
        _count: { select: { sources: { where: { active: true } } } },
      },
    })
    // the events of the RFx itself: codes and times, never a price (the events of an RFx carry none · §16 events table)
    const events = await tx.event.findMany({
      where: { aggregateType: 'RfxEvent', aggregateId: rfx.id },
      orderBy: { seq: 'asc' },
      take: 200,
      select: { id: true, type: true, occurredAt: true, actorType: true, actorMemberId: true },
    })
    const actorIds = [...new Set(events.flatMap((e) => (e.actorMemberId ? [e.actorMemberId] : [])))]
    const actors = actorIds.length ? await tx.member.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayNameTh: true, displayNameEn: true } }) : []
    const actorOf = new Map(actors.map((m) => [m.id, nameOf(m)!]))
    const amendments = await tx.rfxAmendment.findMany({ where: { rfxEventId: rfx.id }, orderBy: { revisionNo: 'asc' }, include: { createdBy: MEMBER } })

    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    const manage = (await authorize(tx, ctx, 'sourcing.manage')).ok
    const beforeClose = rfx.status === 'DRAFT' || (rfx.closesAt !== null && now.getTime() < rfx.closesAt.getTime())
    const riskOn = prices && (await enabledModules(tx)).includes('RISK')

    let invites: RfxDetailDto['invites'] = []
    let questions: RfxDetailDto['questions'] = []
    let bids: RfxDetailDto['bids'] = null
    let scores: RfxDetailDto['scores'] = null
    let awards: RfxDetailDto['awards'] = []
    let evaluator = false
    if (prices) {
      const rows = await tx.rfxInvite.findMany({
        where: { rfxEventId: rfx.id },
        orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          supplierId: true,
          applicationId: true,
          invitedAt: true,
          viewedAt: true,
          declinedAt: true,
          declineReason: true,
          removedAt: true,
          removeReason: true,
          needsReconfirm: true,
          supplierSnapshot: true,
          supplier: { select: { code: true, nameTh: true } },
          application: { select: { nameTh: true } },
        },
      })
      invites = await Promise.all(
        rows.map(async (i) => {
          const risk = riskOn && i.supplierId ? await supplierRiskStatus(tx, ctx.organizationId, i.supplierId, now) : null
          const snapshot = snapshotOf(i.supplierSnapshot)
          const snapshotName = (i.supplierSnapshot as Record<string, unknown> | null)?.name
          return {
            id: i.id,
            status: i.status,
            name: i.supplier?.nameTh ?? i.application?.nameTh ?? (typeof snapshotName === 'string' ? snapshotName : ''),
            supplierCode: i.supplier?.code ?? null,
            application: i.supplierId === null,
            invitedAt: i.invitedAt.toISOString(),
            viewedAt: iso(i.viewedAt),
            declinedAt: iso(i.declinedAt),
            declineReason: i.declineReason,
            removedAt: iso(i.removedAt),
            removeReason: i.removeReason,
            needsReconfirm: i.needsReconfirm,
            snapshot,
            risk: risk ? { tier: risk.tier, status: risk.status ?? null, blocked: risk.blocked } : null,
          }
        }),
      )
      const inviteName = new Map(invites.map((i) => [i.id, i.name]))
      const qs = await tx.rfxQuestion.findMany({ where: { rfxEventId: rfx.id }, orderBy: [{ askedAt: 'asc' }, { id: 'asc' }], include: { answeredBy: MEMBER } })
      // BR-RFX-04: the asker is never told to the other suppliers; inside, a reader of the RFx's prices sees who asked
      questions = qs.map((q) => ({
        id: q.id,
        status: q.status,
        question: q.question,
        askedAt: q.askedAt.toISOString(),
        askerName: inviteName.get(q.inviteId) ?? '',
        answer: q.answer,
        answeredAt: iso(q.answeredAt),
        answeredBy: nameOf(q.answeredBy),
        visibility: q.visibility,
      }))
      bids = await bidsOf(tx, ctx.organizationId, rfx, now)
      const supplierOfBid = new Map((bids.comparison?.bids ?? []).map((b) => [b.bidId, b.supplierName]))
      if (rfx.scorecardId) {
        scores = await scoresOf(tx, rfx.scorecardId, supplierOfBid)
        evaluator = memberId !== null && scores.evaluators.some((e) => e.memberId === memberId)
      }
      awards = await awardsOf(tx, rfx.id)
    }
    const award = prices && (await authorize(tx, ctx, 'sourcing.award')).ok

    return {
      ok: true,
      data: {
        reading: may.data,
        rfx: {
          id: rfx.id,
          number: rfx.number,
          kind: rfx.kind,
          status: rfx.status,
          title: rfx.title,
          titleEn: rfx.titleEn,
          description: rfx.description,
          descriptionEn: rfx.descriptionEn,
          categoryCode: rfx.categoryCode,
          sourceKind: rfx.sourceKind,
          sealed: rfx.sealed,
          allowPartialBids: rfx.allowPartialBids,
          allowVatInclusiveBids: rfx.allowVatInclusiveBids,
          bidValidityDays: rfx.bidValidityDays,
          minInvites: rfx.minInvites,
          revisionNo: rfx.revisionNo,
          version: rfx.version,
          createdAt: rfx.createdAt.toISOString(),
          openedAt: iso(rfx.openedAt),
          closesAt: iso(rfx.closesAt),
          questionCutoffAt: iso(rfx.questionCutoffAt),
          closedAt: iso(rfx.closedAt),
          cancelledAt: iso(rfx.cancelledAt),
          cancelReason: prices ? rfx.cancelReason : null,
          conclusionNote: rfx.conclusionNote,
          createdBy: nameOf(rfx.createdBy),
          requestingDepartment: rfx.requestingDepartment ? { th: rfx.requestingDepartment.nameTh, en: rfx.requestingDepartment.nameEn } : null,
          beforeClose,
        },
        lines: lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          description: l.description,
          descriptionEn: l.descriptionEn,
          quantity: l.quantity.toString(),
          uom: l.uom,
          uomEn: l.uomEn,
          deliverySite: l.deliverySite ? { code: l.deliverySite.code, name: l.deliverySite.nameTh } : null,
          requiredDeliveryOn: isoDay(l.requiredDeliveryOn),
          note: l.note,
          reference: prices && l.refUnitPriceSatang !== null ? { unitPrice: satangToAmount(l.refUnitPriceSatang), source: l.refSource } : null,
          sourceCount: l._count.sources,
        })),
        timeline: events.map((e) => ({
          id: e.id,
          type: e.type,
          occurredAt: e.occurredAt.toISOString(),
          actor:
            e.actorType === 'SUPPLIER'
              ? { kind: 'SUPPLIER' as const }
              : e.actorMemberId && actorOf.has(e.actorMemberId)
                ? { kind: 'MEMBER' as const, name: actorOf.get(e.actorMemberId)! }
                : { kind: 'SYSTEM' as const },
        })),
        invites,
        questions,
        amendments: amendments.map((a) => ({
          revisionNo: a.revisionNo,
          summary: a.summary,
          summaryEn: a.summaryEn,
          changedFields: Array.isArray(a.changedFields) ? a.changedFields.filter((f): f is string => typeof f === 'string') : [],
          previousClosesAt: iso(a.previousClosesAt),
          newClosesAt: iso(a.newClosesAt),
          createdAt: a.createdAt.toISOString(),
          createdBy: nameOf(a.createdBy),
        })),
        bids,
        scores,
        awards,
        modules: { risk: riskOn },
        can: {
          manage,
          award,
          score: evaluator,
          cancel: manage && allowed(rfx.status, 'rfx.cancel'),
          closeEarly: manage && allowed(rfx.status, 'rfx.closeEarly'),
          conclude: manage && rfx.kind === 'RFI' && allowed(rfx.status, 'rfx.conclude'),
          amend: manage && allowed(rfx.status, 'rfx.amend') && beforeClose,
          extend: manage && allowed(rfx.status, 'rfx.extend') && beforeClose,
          answer: manage && rfx.status === 'OPEN' && beforeClose,
          invite: manage && allowed(rfx.status, 'rfx.invite') && beforeClose,
        },
      },
    }
  })
}

/**
 * A five-minute link to a file of a bid of the RFx, for a reader of its prices once the envelope is open (BR-RFX-06):
 * only a file of a sent bid, stored and clean by S7's scan (BR-RFX-07)
 */
export async function bidFileUrl(ctx: Ctx, rfxEventId: string, fileId: string): Promise<Result<{ readonly url: string }>> {
  if (!UUID.test(rfxEventId) || !UUID.test(fileId)) return notFound()
  const found = await forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<{ storageKey: string; fileName: string; mimeType: string }>> => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const rfx = await tx.rfxEvent.findUnique({ where: { id: rfxEventId }, select: { id: true, status: true, sealed: true } })
    if (!rfx) return notFound()
    const may = await rfxReading(tx, ctx, rfx.id)
    if (!may.ok) return may
    if (may.data !== 'PRICES') return { ok: false, error: { code: 'FORBIDDEN', message: 'a requester sees the RFx, not its bids', details: { reason: 'PRICES' } } }
    if (rfx.sealed && BEFORE_CLOSE.has(rfx.status)) return { ok: false, error: { code: 'FORBIDDEN', message: 'sealed until the close', details: { reason: 'SEALED' } } }
    const bids = await tx.bid.findMany({ where: { rfxEventId: rfx.id, status: 'SUBMITTED' }, select: { id: true } })
    const link = bids.length ? await tx.fileLink.findFirst({ where: { fileId, kind: 'BID_DOC', subjectType: 'Bid', subjectId: { in: bids.map((b) => b.id) } }, select: { file: { select: { storageKey: true, fileName: true, mimeType: true, status: true, scanStatus: true } } } }) : null
    if (!link) return { ok: false, error: { code: 'NOT_FOUND', message: 'file not found' } }
    if (link.file.status !== 'AVAILABLE' || !OPENABLE_SCAN.has(link.file.scanStatus)) return { ok: false, error: { code: 'FORBIDDEN', message: 'the file is not clean yet', details: { reason: 'NOT_CLEAN' } } }
    return { ok: true, data: { storageKey: link.file.storageKey, fileName: link.file.fileName, mimeType: link.file.mimeType } }
  })
  if (!found.ok) return found
  const url = await presignDownload(found.data.storageKey, { fileName: found.data.fileName, contentType: found.data.mimeType, inline: opensInline(found.data.mimeType) })
  return { ok: true, data: { url } }
}

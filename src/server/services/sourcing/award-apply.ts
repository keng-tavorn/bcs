import { z } from 'zod'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { consolidate } from '@/core/consolidation'
import { documentTotals, type Satang } from '@/core/money/math'
import type { AppError } from '@/core/result'
import { confirmedNetPriceCap, preferredWindow } from '@/core/sourcing'
import { BID_MACHINE, RFX_EVENT_MACHINE, transition } from '@/core/state-machines'
import { sourcingSettingsOf } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { SOURCING_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-sourcing'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { createPriceAgreementInTx, endPriceAgreementInTx } from '../catalog'
import { requireModule } from '../modules'
import { assignSupplierInTx, consolidateInTx } from '../procurement'
import { biddingSupplier, contactInvite } from './bids'
import { absorb, effects, orgCodeOf, portalLoginUrl, type Effects } from './invites'
import { awardStep, lockedAward } from './awards'
import { preferFromAward } from './preferred'
import { gate, lockedRfx, releaseSources } from './rfx'

// What an approved award does (S10-11 · FR-SRC-204 AC3 AC4 AC9 AC10 · BR-RFX-13 BR-RFX-14 · ADR-206 · OQ-203 OQ-205
// OQ-212 · INV-RFX-04), inside the transaction of its decision and under a context derived from its submitter (awardCtx:
// the POs are procurement's, the approver acts on their behalf — so the PO's creator is the submitter, and the PO's own
// route under DOA PURCHASE_ORDER neither escalates past the approver nor skips anyone · BR-SOD-03).
//
// An RFx of request lines: each winner becomes the supplier of the request lines of its RFx lines (assignSupplierInTx,
// the pool's own rules without po.create again, no urgent round), then the pool's own consolidateInTx drafts the POs of
// exactly those lines — one per supplier, delivery site and kind (BR-CONS-01) — at the awarded unit price before VAT and
// the winner's VAT rate (0 for one not registered or abroad), stamped with the award and its RFx. A sibling line of the
// same request whose supplier waits for the next round stays in the pool. The POs are drafts: procurement sends them and
// they pass DOA PURCHASE_ORDER and the budget as every PO (OQ-203 · BR-BUD-04 05), and S11's risk gate at po.submit,
// po.send and a change. An RFx of a need makes no PO: each line with a catalogue item gets an agreed price at the awarded
// price for agreementFromAwardDays from the approval, ending the same item and supplier's agreement that runs into it on
// the day before (an agreement that starts on or after that day is refused: procurement ends it first). Every winner is
// preferred in the RFx's category (preferFromAward). A winner who bid with VAT included makes nothing of the kind until it
// confirms its unit prices before VAT on the portal and procurement releases the award (award.releasePo · PENDING_PRICE):
// the system never rounds a unit price of its own (NEW-50). Any refusal rolls the whole decision back.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const isFail = <T,>(x: T | Fail): x is Fail => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false

/** BR-RFX-13: the context the approval's effects run under — the award's submitter; the approver goes into the events */
export function awardCtx(ctx: Ctx, submittedById: string): Ctx {
  return { ...ctx, actor: { type: 'USER', memberId: submittedById } }
}

/** What applyAward reads of an award */
export interface AwardRow {
  readonly id: string
  readonly rfxEventId: string
  readonly number: string | null
  readonly submittedById: string | null
  readonly version: number
}

/** What applyAward did, for award.approved */
export interface AwardApplied {
  readonly events: readonly EventDraft[]
  readonly notifications: readonly NotificationDraft[]
  readonly purchaseOrderIds: readonly string[]
  readonly priceAgreementIds: readonly string[]
  readonly preferredSupplierIds: readonly string[]
  /** RFx lines of a need with no agreed price (AC9): no catalogue item, one item twice at two prices, or an agreement of
   *  the item and the winner that procurement set to start on the approval day */
  readonly linesWithoutAgreement: readonly number[]
  /** OQ-212: PENDING_PRICE while a winner who bid with VAT has not confirmed its prices before VAT */
  readonly poStatus: 'NOT_APPLICABLE' | 'PENDING_PRICE' | 'CREATED'
}

type Rfx = { readonly id: string; readonly sourceKind: 'REQUEST_LINES' | 'NEED'; readonly number: string | null; readonly title: string; readonly titleEn: string | null }

const awardLinesOf = (tx: TenantTx, awardDecisionId: string) =>
  tx.awardLine.findMany({
    where: { awardDecisionId },
    include: { rfxLine: { select: { id: true, lineNo: true, description: true, uom: true, catalogItemId: true } }, bid: { select: { id: true, priceIncludesVat: true, netPricesConfirmedAt: true } } },
  })
type AwardLines = Awaited<ReturnType<typeof awardLinesOf>>

/** A winner who bid with VAT and has not confirmed its prices before VAT yet (OQ-212) */
const unconfirmed = (lines: AwardLines) => [...new Set(lines.filter((l) => l.bid.priceIncludesVat && l.bid.netPricesConfirmedAt === null).map((l) => l.bidId))]

interface Materialized {
  readonly purchaseOrderIds: string[]
  readonly priceAgreementIds: string[]
  readonly linesWithoutAgreement: number[]
  readonly events: EventDraft[]
}

/** The POs of an award of request lines, or the agreed prices of a need — at the prices its lines hold now */
async function materialize(tx: TenantTx, ctx: Ctx, award: { readonly id: string; readonly number: string | null }, rfx: Rfx, lines: AwardLines, onBehalfOf: string | null): Promise<Fail | Materialized> {
  const events: EventDraft[] = []
  if (rfx.sourceKind === 'NEED') return agreementsOf(tx, ctx, award, lines)
  const lineOf = new Map(lines.map((l) => [l.rfxLineId, l]))
  const sources = await tx.rfxLineSource.findMany({ where: { rfxLineId: { in: [...lineOf.keys()] }, active: true }, orderBy: { id: 'asc' }, select: { rfxLineId: true, requestLineId: true } })
  const bySupplier = new Map<string, string[]>()
  const unitPriceOverrides = new Map<string, Satang>()
  const vatRateBpOverrides = new Map<string, number>()
  for (const s of sources) {
    const a = lineOf.get(s.rfxLineId)!
    bySupplier.set(a.supplierId, [...(bySupplier.get(a.supplierId) ?? []), s.requestLineId])
    unitPriceOverrides.set(s.requestLineId, a.unitPriceSatang)
    vatRateBpOverrides.set(a.supplierId, a.vatRateBp)
  }
  const award_ = { awardDecisionId: award.id, rfxEventId: rfx.id }
  for (const supplierId of [...bySupplier.keys()].sort()) {
    const assigned = await assignSupplierInTx(tx, ctx, { requestLineIds: bySupplier.get(supplierId)!, supplierId, award: { ...award_, onBehalfOfMemberId: onBehalfOf } })
    if (!assigned.ok) return assigned
    events.push(...assigned.events)
  }
  let purchaseOrderIds: string[] = []
  if (sources.length) {
    const requestLineIds = sources.map((s) => s.requestLineId)
    const requestIds = [...new Set((await tx.requestLine.findMany({ where: { id: { in: requestLineIds } }, select: { requestId: true } })).map((l) => l.requestId))]
    const run = await consolidateInTx(tx, ctx, { trigger: 'MANUAL', requestIds, requestLineIds, unitPriceOverrides, vatRateBpOverrides, award: award_ })
    events.push(...run.events)
    purchaseOrderIds = [...run.purchaseOrderIds]
    // INV-RFX-04: every request line of the award is on one of its drafts
    const ordered = new Set((await tx.poLineSource.findMany({ where: { poLine: { poId: { in: purchaseOrderIds } } }, select: { requestLineId: true } })).map((s) => s.requestLineId))
    const missing = requestLineIds.filter((id) => !ordered.has(id))
    if (missing.length) return fail('VALIDATION_FAILED', 'a request line of the award could not be put on a purchase order', { reason: 'AWARD_LINE_NOT_ORDERED', requestLineIds: missing })
  }
  // the RFx is over: its request lines are its own no more (INV-RFX-03)
  await releaseSources(tx, { rfxEventId: rfx.id })
  return { purchaseOrderIds, priceAgreementIds: [], linesWithoutAgreement: [], events }
}

/** AC9: an agreed price per line of a need with a catalogue item, ending the one of the same item and supplier it overlaps */
async function agreementsOf(tx: TenantTx, ctx: Ctx, award: { readonly id: string; readonly number: string | null }, lines: AwardLines): Promise<Fail | Materialized> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const window = preferredWindow(ctx.now, sourcingSettingsOf(org.settings).agreementFromAwardDays)
  const events: EventDraft[] = []
  const priceAgreementIds: string[] = []
  const without: number[] = []
  // one agreement per item and supplier: the same item twice to one winner at two prices makes none (the price is theirs to choose)
  const groups = new Map<string, AwardLines>()
  for (const l of [...lines].sort((a, b) => a.rfxLine.lineNo - b.rfxLine.lineNo)) {
    if (!l.rfxLine.catalogItemId) {
      without.push(l.rfxLine.lineNo)
      continue
    }
    const key = `${l.rfxLine.catalogItemId}:${l.supplierId}`
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  for (const group of groups.values()) {
    const first = group[0]!
    if (group.some((l) => l.unitPriceSatang !== first.unitPriceSatang)) {
      without.push(...group.map((l) => l.rfxLine.lineNo))
      continue
    }
    const catalogItemId = first.rfxLine.catalogItemId!
    // the item locked before its agreements are read, as priceAgreement.create does
    await lockRowsForUpdate(tx, 'CatalogItem', ctx.organizationId, [catalogItemId])
    const overlapping = await tx.priceAgreement.findMany({
      where: { catalogItemId, supplierId: first.supplierId, validFrom: { lt: new Date(`${window.validTo}T00:00:00Z`) }, validTo: { gt: new Date(`${window.validFrom}T00:00:00Z`) } },
      orderBy: { validFrom: 'asc' },
      select: { id: true, validFrom: true },
    })
    // one that runs into the approval ends the day before it (BR-RFX-13); one procurement set to start on or after that
    // day stays as it is, and the award's runs until it starts — none at all when it starts that very day
    let validTo = window.validTo
    for (const old of overlapping) {
      const from = old.validFrom.toISOString().slice(0, 10)
      if (from >= window.validFrom) {
        if (from < validTo) validTo = from
        continue
      }
      const ended = await endPriceAgreementInTx(tx, ctx, { priceAgreementId: old.id, validTo: window.validFrom })
      if (!ended.ok) return ended
      events.push(...ended.events)
    }
    if (validTo <= window.validFrom) {
      without.push(...group.map((l) => l.rfxLine.lineNo))
      continue
    }
    const made = await createPriceAgreementInTx(tx, ctx, { catalogItemId, supplierId: first.supplierId, unitPriceSatang: first.unitPriceSatang, validFrom: window.validFrom, validTo, sourceRef: award.number, via: 'AWARD' })
    if (!made.ok) return made
    priceAgreementIds.push(made.priceAgreementId)
    events.push(...made.events)
  }
  return { purchaseOrderIds: [], priceAgreementIds, linesWithoutAgreement: without.sort((a, b) => a - b), events }
}

/** rfx.awarded to each winner (its lines and prices), rfx.not_awarded to whoever bid and won nothing, and the request to confirm */
async function mailResult(tx: TenantTx, ctx: Ctx, rfx: Rfx, award: AwardRow, lines: AwardLines, pending: ReadonlySet<string>): Promise<Effects> {
  const out = effects()
  const loginUrl = portalLoginUrl(await orgCodeOf(tx, ctx.organizationId))
  const facts = { number: rfx.number, title: rfx.title, titleEn: rfx.titleEn, loginUrl }
  const winners = new Set(lines.map((l) => l.supplierId))
  const invites = await tx.rfxInvite.findMany({ where: { rfxEventId: rfx.id, supplierId: { not: null } }, orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }], select: { id: true, contactId: true, supplierId: true } })
  const bids = new Map((await tx.bid.findMany({ where: { rfxEventId: rfx.id, status: { in: ['SUBMITTED', 'DISQUALIFIED'] } }, select: { supplierId: true } })).map((b) => [b.supplierId, true]))
  for (const invite of invites) {
    const supplierId = invite.supplierId!
    const base = { contactId: invite.contactId, supplierId, subjectType: 'RfxEvent', subjectId: rfx.id }
    if (winners.has(supplierId)) {
      const own = lines.filter((l) => l.supplierId === supplierId).sort((a, b) => a.rfxLine.lineNo - b.rfxLine.lineNo)
      const waiting = own.some((l) => pending.has(l.bidId))
      const mailed = own.map((l) => ({ lineNo: l.rfxLine.lineNo, description: l.rfxLine.description, quantity: l.quantity.toString(), uom: l.rfxLine.uom, unitPrice: waiting ? '' : satangToAmount(l.unitPriceSatang), lineNet: satangToAmount(l.lineNetSatang) }))
      absorb(out, await enqueueSupplierNotice(tx, ctx, { ...base, templateKey: SOURCING_SUPPLIER_TEMPLATES.awarded, dedupeKey: `rfx.awarded:${award.id}:${invite.id}`, data: { ...facts, lines: mailed, pendingPrice: waiting, need: rfx.sourceKind === 'NEED' } }))
      if (waiting) absorb(out, await enqueueSupplierNotice(tx, ctx, { ...base, templateKey: SOURCING_SUPPLIER_TEMPLATES.netPriceConfirmRequested, dedupeKey: `rfx.net_price_confirm_requested:${award.id}:${invite.id}`, data: facts }))
    } else if (bids.has(supplierId)) {
      absorb(out, await enqueueSupplierNotice(tx, ctx, { ...base, templateKey: SOURCING_SUPPLIER_TEMPLATES.notAwarded, dedupeKey: `rfx.not_awarded:${award.id}:${invite.id}`, data: facts }))
    }
  }
  return out
}

/** rfx.awarded_internal: the RFx's creator and evaluators (DIGEST), the requesters of its source lines (IMMEDIATE) */
async function noticeInside(tx: TenantTx, rfx: Rfx & { readonly createdById: string; readonly scorecardId: string | null }, award: AwardRow, pendingPrice: boolean): Promise<NotificationDraft[]> {
  const evaluators = rfx.scorecardId ? await tx.scorecardEvaluator.findMany({ where: { scorecardId: rfx.scorecardId }, select: { memberId: true } }) : []
  const requesters = await tx.rfxLineSource.findMany({ where: { rfxLine: { rfxEventId: rfx.id } }, select: { requestLine: { select: { request: { select: { requesterMemberId: true } } } } } })
  const immediate = new Set(requesters.map((r) => r.requestLine.request.requesterMemberId))
  const digest = new Set([rfx.createdById, ...evaluators.map((e) => e.memberId)].filter((m) => !immediate.has(m)))
  const data = { rfxEventId: rfx.id, awardDecisionId: award.id, number: rfx.number, title: rfx.title, pendingPrice }
  const of = (memberId: string, urgency: 'IMMEDIATE' | 'DIGEST'): NotificationDraft => ({ recipientMemberId: memberId, templateKey: 'rfx.awarded_internal', data, urgency, dedupeKey: `rfx.awarded_internal:${award.id}:${memberId}`, subjectType: 'RfxEvent', subjectId: rfx.id })
  return [...[...immediate].map((m) => of(m, 'IMMEDIATE')), ...[...digest].map((m) => of(m, 'DIGEST'))]
}

/**
 * BR-RFX-13: the events of what the award's effects did are the submitter's (the actor of `submitter`, the derived
 * context) on behalf of whoever approved or released it — written here, as the decision's own events are written by its
 * pipeline with the approver as actor (approvals/decide.ts is not changed · ADR-068)
 */
async function recordAsSubmitter(tx: TenantTx, submitter: Ctx, events: readonly EventDraft[], onBehalfOf: string | null): Promise<void> {
  await appendEvents(
    tx,
    submitter,
    events.map((e) => (onBehalfOf ? { ...e, onBehalfOfMemberId: onBehalfOf } : e)),
  )
}

/**
 * The effects of an approved award inside the decision's transaction (BR-RFX-13 · ADR-206), under `effects` = awardCtx of
 * its submitter; `approver` goes into the events as the one the submitter's effects were done for.
 */
export async function applyAward(tx: TenantTx, effectsCtx: Ctx, award: AwardRow, approver: string | null): Promise<Fail | ({ ok: true } & AwardApplied)> {
  const rfx = await tx.rfxEvent.findUniqueOrThrow({ where: { id: award.rfxEventId }, select: { id: true, status: true, sourceKind: true, categoryCode: true, number: true, title: true, titleEn: true, createdById: true, scorecardId: true } })
  const moved = transition(RFX_EVENT_MACHINE, rfx.status, 'rfx.award')
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `the RFx is ${rfx.status}`, { from: rfx.status, command: 'rfx.award' })
  await tx.rfxEvent.update({ where: { id: rfx.id }, data: { status: moved.to, awardDecisionId: award.id, version: { increment: 1 } } })
  const lines = await awardLinesOf(tx, award.id)
  const pending = new Set(unconfirmed(lines))
  const out = effects()
  out.events.push({ type: 'rfx.awarded', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { awardDecisionId: award.id } })
  // the RFx lines nobody won go back to the pool now (INV-RFX-03); the won ones once their POs are drafted
  const won = new Set(lines.map((l) => l.rfxLineId))
  const lost = (await tx.rfxLine.findMany({ where: { rfxEventId: rfx.id }, select: { id: true } })).filter((l) => !won.has(l.id)).map((l) => l.id)
  if (lost.length) await releaseSources(tx, { rfxEventId: rfx.id, rfxLineIds: lost })
  const preferred = await preferFromAward(tx, effectsCtx, { awardDecisionId: award.id, categoryCode: rfx.categoryCode, supplierIds: [...new Set(lines.map((l) => l.supplierId))] })
  let made: Materialized = { purchaseOrderIds: [], priceAgreementIds: [], linesWithoutAgreement: [], events: [] }
  if (pending.size === 0) {
    const m = await materialize(tx, effectsCtx, award, rfx, lines, approver)
    if (isFail(m)) return m
    made = m
  }
  await recordAsSubmitter(tx, effectsCtx, [...preferred.events, ...made.events], approver)
  absorb(out, await mailResult(tx, effectsCtx, rfx, award, lines, pending))
  out.notifications.push(...(await noticeInside(tx, rfx, award, pending.size > 0)))
  return {
    ok: true,
    events: out.events,
    notifications: out.notifications,
    purchaseOrderIds: made.purchaseOrderIds,
    priceAgreementIds: made.priceAgreementIds,
    preferredSupplierIds: preferred.preferredSupplierIds,
    linesWithoutAgreement: made.linesWithoutAgreement,
    poStatus: pending.size ? 'PENDING_PRICE' : made.purchaseOrderIds.length ? 'CREATED' : 'NOT_APPLICABLE',
  }
}

/**
 * What the POs of one winner's lines come to at these unit prices before VAT (OQ-212 · review S10-11 · 3): its RFx lines'
 * request lines grouped as consolidateInTx groups them (core/consolidation: supplier, site, kind; an urgent request on
 * its own) and priced as createDraft prices them (documentTotals: each line's amount, VAT once per PO on its VAT-able
 * lines). A need makes no PO: its lines count as one document.
 */
async function draftedTotals(tx: TenantTx, supplierId: string, lines: ReadonlyArray<{ readonly rfxLineId: string; readonly quantity: string; readonly unitPriceSatang: Satang }>, rateBp: number): Promise<{ net: Satang; vat: Satang; gross: Satang }> {
  const priceOf = new Map(lines.map((l) => [l.rfxLineId, l.unitPriceSatang]))
  const sources = await tx.rfxLineSource.findMany({
    where: { rfxLineId: { in: [...priceOf.keys()] }, active: true },
    select: { rfxLineId: true, quantity: true, requestLine: { select: { id: true, lineNo: true, kind: true, vatable: true, request: { select: { number: true, deliverySiteId: true, urgency: true } } } } },
  })
  const documents: Array<Array<{ quantity: string; unitPriceSatang: Satang; vatable: boolean }>> = []
  if (!sources.length) documents.push(lines.map((l) => ({ quantity: l.quantity, unitPriceSatang: l.unitPriceSatang, vatable: true })))
  else {
    const byRef = new Map(sources.map((x) => [x.requestLine.id, x]))
    const grouped = consolidate(sources.map((x) => ({ ref: x.requestLine.id, requestNo: x.requestLine.request.number ?? '', lineNo: x.requestLine.lineNo, supplierId, siteId: x.requestLine.request.deliverySiteId, kind: x.requestLine.kind, urgent: x.requestLine.request.urgency === 'URGENT' })))
    for (const refs of [...grouped.cycleGroups, ...grouped.immediate]) {
      documents.push(refs.map((ref) => byRef.get(ref)!).map((x) => ({ quantity: x.quantity.toString(), unitPriceSatang: priceOf.get(x.rfxLineId)!, vatable: x.requestLine.vatable })))
    }
  }
  const totals = documents.map((d) => documentTotals(d, rateBp, false))
  return { net: totals.reduce((a, t) => a + t.net, 0n), vat: totals.reduce((a, t) => a + t.vat, 0n), gross: totals.reduce((a, t) => a + t.gross, 0n) }
}

// ---------- bid.confirmNetPrices (the winner on the portal · OQ-212) ----------

const BAHT = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
const ConfirmInput = z.strictObject({ rfxEventId: z.uuid(), lines: z.array(z.strictObject({ rfxLineId: z.uuid(), unitPrice: BAHT })).min(1).max(200) })

/**
 * A winner who bid with VAT included gives each line it won its unit price before VAT (GC-SRC-41): the price plus its VAT
 * at most the price bid, line by line (confirmedNetPriceCap · whole numbers, no rounding), and the lines' amounts before
 * VAT plus VAT at most what it bid for them with VAT. It may give them again until procurement releases the award.
 */
export const confirmNetPricesCommand = defineCommand({
  name: 'bid.confirmNetPrices',
  capability: 'portal.rfx.confirmNetPrices',
  input: ConfirmInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ bidId: string; net: string; vat: string; gross: string }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    // the RFx first, then the award, then the bid (the order of the award's commands)
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    const invite = rfx ? await contactInvite(tx, ctx, rfx.id, 'portal.rfx.confirmNetPrices') : fail('NOT_FOUND', 'RFx not found')
    if (isFail(invite)) return invite
    const supplier = await biddingSupplier(tx, invite.supplierId)
    if (isFail(supplier)) return supplier
    if (rfx!.awardDecisionId) await lockRowsForUpdate(tx, 'AwardDecision', ctx.organizationId, [rfx!.awardDecisionId])
    const award = rfx!.awardDecisionId ? await tx.awardDecision.findUnique({ where: { id: rfx!.awardDecisionId } }) : null
    if (!award || award.status !== 'APPROVED' || award.poStatus !== 'PENDING_PRICE') return fail('INVALID_STATE_TRANSITION', 'no award waits for prices before VAT', { from: award?.poStatus ?? rfx!.status, command: 'bid.confirmNetPrices', reason: 'NOT_PENDING_PRICE' })
    const bid = await tx.bid.findFirst({ where: { rfxEventId: rfx!.id, supplierId: supplier.id }, select: { id: true } })
    if (!bid) return fail('NOT_FOUND', 'bid not found')
    await lockRowsForUpdate(tx, 'Bid', ctx.organizationId, [bid.id])
    const row = await tx.bid.findUniqueOrThrow({ where: { id: bid.id }, include: { lines: true } })
    const t = transition(BID_MACHINE, row.status as never, 'bid.confirmNetPrices')
    if (!t.ok) return fail('INVALID_STATE_TRANSITION', `bid.confirmNetPrices is not allowed from ${row.status}`, { from: row.status, command: 'bid.confirmNetPrices' })
    if (!row.priceIncludesVat) return fail('VALIDATION_FAILED', 'only a bid with VAT included confirms its prices before VAT', { reason: 'NOT_VAT_INCLUSIVE' })
    const won = await tx.awardLine.findMany({ where: { awardDecisionId: award.id, bidId: row.id }, include: { rfxLine: { select: { lineNo: true, quantity: true } } } })
    if (!won.length) return fail('INVALID_STATE_TRANSITION', 'the bid won no line', { from: row.status, command: 'bid.confirmNetPrices', reason: 'NOT_A_WINNER' })
    const given = new Map(input.lines.map((l) => [l.rfxLineId, amountToSatang(l.unitPrice)]))
    if (given.size !== input.lines.length || given.size !== won.length || won.some((w) => !given.has(w.rfxLineId))) return fail('VALIDATION_FAILED', 'give a price for every line the bid won, once', { field: 'lines', reason: 'LINES' })
    const rate = row.vatRateBp ?? 0
    let quoted = 0n
    for (const w of won.sort((a, b) => a.rfxLine.lineNo - b.rfxLine.lineNo)) {
      const price = given.get(w.rfxLineId)!
      const bidLine = row.lines.find((l) => l.rfxLineId === w.rfxLineId)!
      if (price <= 0n) return fail('VALIDATION_FAILED', 'a price above zero is needed', { field: `lines.${w.rfxLineId}.unitPrice`, reason: 'PRICE' })
      if (!confirmedNetPriceCap(rate, bidLine.unitPriceSatang!, price)) return fail('AWARD_PRICE_EXCEEDS_BID', 'the price before VAT plus VAT is above the price bid', { line: String(w.rfxLine.lineNo), reason: 'LINE' })
      quoted += bidLine.lineQuotedSatang ?? 0n
    }
    // the total as the POs will carry it — their lines and their VAT rounded as the release drafts them
    const { net, vat, gross } = await draftedTotals(
      tx,
      supplier.id,
      won.map((w) => ({ rfxLineId: w.rfxLineId, quantity: w.rfxLine.quantity.toString(), unitPriceSatang: given.get(w.rfxLineId)! })),
      rate,
    )
    if (gross > quoted) return fail('AWARD_PRICE_EXCEEDS_BID', 'the amounts before VAT plus VAT are above what was bid with VAT', { line: won.map((w) => w.rfxLine.lineNo).join(', '), reason: 'TOTAL', gross: satangToAmount(gross), bid: satangToAmount(quoted) })
    for (const w of won) await tx.bidLine.updateMany({ where: { bidId: row.id, rfxLineId: w.rfxLineId }, data: { confirmedNetUnitPriceSatang: given.get(w.rfxLineId)! } })
    await tx.bid.update({ where: { id: row.id }, data: { netPricesConfirmedAt: ctx.now, version: { increment: 1 } } })
    const notifications: NotificationDraft[] = award.submittedById
      ? [{ recipientMemberId: award.submittedById, templateKey: 'award.prices_confirmed', data: { rfxEventId: rfx!.id, awardDecisionId: award.id, number: award.number, title: rfx!.title }, urgency: 'IMMEDIATE', dedupeKey: `award.prices_confirmed:${row.id}:${row.version + 1}`, subjectType: 'AwardDecision', subjectId: award.id }]
      : []
    return {
      ok: true,
      result: { bidId: row.id, net: satangToAmount(net), vat: satangToAmount(vat), gross: satangToAmount(gross) },
      events: [{ type: 'bid.net_prices_confirmed', aggregateType: 'Bid', aggregateId: row.id, data: { rfxEventId: rfx!.id, awardDecisionId: award.id, lineCount: won.length, netSatang: net.toString() } }],
      notifications,
    }
  },
})

export function confirmNetPrices(ctx: Ctx, input: z.input<typeof ConfirmInput>, options: RunOptions) {
  return runCommand(ctx, confirmNetPricesCommand, input, options)
}

// ---------- award.releasePo (procurement · OQ-212) ----------

const ReleaseInput = z.strictObject({ awardDecisionId: z.uuid(), version: z.int().min(0) })

/** Once every winner who bid with VAT confirmed its prices: the POs (or the agreed prices of a need) at those prices */
export const releaseAwardPoCommand = defineCommand({
  name: 'award.releasePo',
  capability: 'sourcing.award',
  input: ReleaseInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ awardDecisionId: string; purchaseOrderIds: string[]; priceAgreementIds: string[] }>> {
    const refused = await gate(tx, ctx, 'sourcing.award')
    if (refused) return refused
    const found = await lockedAward(tx, ctx, input.awardDecisionId)
    if (!found) return fail('NOT_FOUND', 'award not found')
    const { rfx, award } = found
    const moved = awardStep(award, 'award.releasePo', input.version)
    if (isFail(moved)) return moved
    if (award.poStatus !== 'PENDING_PRICE') return fail('INVALID_STATE_TRANSITION', 'the award waits for no price', { from: award.poStatus, command: 'award.releasePo', reason: 'NOT_PENDING_PRICE' })
    const lines = await awardLinesOf(tx, award.id)
    const waiting = unconfirmed(lines)
    if (waiting.length) return fail('PO_PENDING_PRICE', 'a winner has not confirmed its prices before VAT', { bidIds: waiting })
    // AwardLine.unitPriceSatang becomes the price the winner confirmed (OQ-212); its amounts stay those approved (INV-RFX-05)
    const confirmed = await tx.bidLine.findMany({ where: { bidId: { in: [...new Set(lines.filter((l) => l.bid.priceIncludesVat).map((l) => l.bidId))] } }, select: { bidId: true, rfxLineId: true, confirmedNetUnitPriceSatang: true } })
    for (const l of lines.filter((x) => x.bid.priceIncludesVat)) {
      const price = confirmed.find((c) => c.bidId === l.bidId && c.rfxLineId === l.rfxLineId)?.confirmedNetUnitPriceSatang
      if (!price) return fail('PO_PENDING_PRICE', 'a line has no confirmed price before VAT', { bidIds: [l.bidId] })
      await tx.awardLine.update({ where: { id: l.id }, data: { unitPriceSatang: price } })
    }
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    const submitter = awardCtx(ctx, award.submittedById!)
    const made = await materialize(tx, submitter, award, rfx, await awardLinesOf(tx, award.id), actor)
    if (isFail(made)) return made
    // the last word (review S10-11 · 3): each winner who bid with VAT gets POs within what it bid for its lines with VAT
    if (made.purchaseOrderIds.length) {
      const pos = await tx.purchaseOrder.findMany({ where: { id: { in: made.purchaseOrderIds } }, select: { supplierId: true, grossSatang: true } })
      const quotedLines = await tx.bidLine.findMany({ where: { bidId: { in: [...new Set(lines.filter((l) => l.bid.priceIncludesVat).map((l) => l.bidId))] } }, select: { bidId: true, rfxLineId: true, lineQuotedSatang: true } })
      for (const bidId of new Set(lines.filter((l) => l.bid.priceIncludesVat).map((l) => l.bidId))) {
        const own = lines.filter((l) => l.bidId === bidId)
        const supplierId = own[0]!.supplierId
        const quoted = own.reduce((sum, l) => sum + (quotedLines.find((q) => q.bidId === bidId && q.rfxLineId === l.rfxLineId)?.lineQuotedSatang ?? 0n), 0n)
        const drafted = pos.filter((p) => p.supplierId === supplierId).reduce((sum, p) => sum + p.grossSatang, 0n)
        if (drafted > quoted) return fail('AWARD_PRICE_EXCEEDS_BID', 'the purchase orders at the confirmed prices are above what was bid with VAT', { line: own.map((l) => l.rfxLine.lineNo).sort((a, b) => a - b).join(', '), reason: 'TOTAL', gross: satangToAmount(drafted), bid: satangToAmount(quoted) })
      }
    }
    await recordAsSubmitter(tx, submitter, made.events, actor)
    const poStatus = made.purchaseOrderIds.length ? 'CREATED' : 'NOT_APPLICABLE'
    await tx.awardDecision.update({ where: { id: award.id }, data: { poStatus, purchaseOrderIds: made.purchaseOrderIds, priceAgreementIds: made.priceAgreementIds, version: { increment: 1 } } })
    return {
      ok: true,
      result: { awardDecisionId: award.id, purchaseOrderIds: made.purchaseOrderIds, priceAgreementIds: made.priceAgreementIds },
      events: [{ type: 'award.po_created', aggregateType: 'AwardDecision', aggregateId: award.id, data: { rfxEventId: rfx.id, number: award.number ?? '', purchaseOrderIds: made.purchaseOrderIds, priceAgreementIds: made.priceAgreementIds } }],
    }
  },
})

export function releaseAwardPo(ctx: Ctx, input: z.input<typeof ReleaseInput>, options: RunOptions) {
  return runCommand(ctx, releaseAwardPoCommand, input, options)
}

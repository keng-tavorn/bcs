import { z } from 'zod'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { lineNet } from '@/core/money/math'
import type { AppError, Result } from '@/core/result'
import { bidValidUntil, compareBids } from '@/core/sourcing'
import { BID_MACHINE, transition, type BidCommand } from '@/core/state-machines'
import { rateFor, taxDateOf } from '@/core/vat'
import { RFX_CURRENCY, RFX_QUESTION_MAX, RFX_SUMMARY_MAX, SETTINGS_MAX_DAYS } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { SOURCING_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-sourcing'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { absorb, effects, orgCodeOf, portalLoginUrl } from './invites'
import { rfxReading } from './access'
import { rankingData, rankingOf } from './ranking'
import { gate, lockedRfx } from './rfx'

// Bids (S10-06 · ADR-203 ADR-204 · BR-RFX-03 06 07 08 10 · FR-SRC-202 AC1 to AC4 AC6): the contact of an invited, ACTIVE
// supplier saves a draft, submits it (again, until the close), or withdraws it; reads its RFx (portal.rfx.view, a POST
// once per invite) or declines. Procurement records a bid received by other means on the supplier's behalf (a file is
// required), and disqualifies one after the close. Amounts come from compareBids at submit and can always be computed
// again from the unit prices as quoted (INV-RFX-05). Sealed: before the close nobody inside sees a price — a member who
// asks for a bid is refused FORBIDDEN reason SEALED and the attempt is kept (security.sealed_bid_denied); the event of a
// submit carries no amount while sealed. The rules of portal.rfx.* in src/server/portal/authz.ts are checked here too
// (services do not import the portal layer).

type Fail = { readonly ok: false; readonly error: AppError; readonly auditEvents?: readonly EventDraft[] }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
export const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false
const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

const BAHT = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
const BidLineInput = z.strictObject({
  rfxLineId: z.uuid(),
  offered: z.boolean().default(true),
  /** As quoted: before or with VAT by priceIncludesVat (BR-RFX-08) */
  unitPrice: BAHT.optional(),
  brand: z.string().trim().max(200).optional(),
  leadTimeDays: z.int().min(0).max(SETTINGS_MAX_DAYS).optional(),
  note: z.string().trim().max(RFX_SUMMARY_MAX).optional(),
})
const BidContent = {
  rfxEventId: z.uuid(),
  /** Baht only (NG-9 · BR-FORM-11): a bid in another currency is refused, never converted (CURRENCY) */
  currency: z.string().trim().max(3).optional(),
  priceIncludesVat: z.boolean().default(false),
  deliveryDays: z.int().min(0).max(SETTINGS_MAX_DAYS).optional(),
  promisedDeliveryOn: z.iso.date().optional(),
  note: z.string().trim().max(RFX_QUESTION_MAX).optional(),
  lines: z.array(BidLineInput).max(500).default([]),
}

/** The invite statuses from which a bid can still be sent (BID_MACHINE · RFX_INVITE_MACHINE) */
export const MAY_BID = new Set(['INVITED', 'VIEWED', 'BID_SUBMITTED', 'WITHDRAWN'])

/** The contact's invite on the RFx; an RFx the contact is not invited to does not exist for them (INV-RFX-01) */
export async function contactInvite(tx: TenantTx, ctx: Ctx, rfxEventId: string, action: string) {
  if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL') return fail('FORBIDDEN', 'not a portal request', { action })
  const owner = ctx.actor.supplierId ? { supplierId: ctx.actor.supplierId } : ctx.actor.applicationId ? { applicationId: ctx.actor.applicationId } : null
  const invite = owner ? await tx.rfxInvite.findFirst({ where: { rfxEventId, ...owner }, select: { id: true, status: true, supplierId: true, applicationId: true, contactId: true } }) : null
  if (!invite || invite.status === 'REMOVED') return fail('NOT_FOUND', 'RFx not found')
  return invite
}

/** A bid needs an approved, ACTIVE supplier (an application's contact waits · ADR-203 · OQ-202) */
export async function biddingSupplier(tx: TenantTx, supplierId: string | null) {
  if (!supplierId) return fail('SUPPLIER_NOT_APPROVED', 'a bid is sent once the supplier is approved')
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true, status: true, isVatRegistered: true, isForeign: true, registryFlag: true } })
  if (!supplier || supplier.status !== 'ACTIVE') return fail('SUPPLIER_NOT_APPROVED', 'a bid is sent by an active supplier')
  // BR-RFX-07 · BR-VAT-04: a supplier whose VAT registration the register says is cancelled bids without VAT
  return { id: supplier.id, status: supplier.status, isForeign: supplier.isForeign, isVatRegistered: supplier.isVatRegistered && supplier.registryFlag !== 'VAT_CANCELLED' }
}

function bidStep(status: string, command: BidCommand): Fail | null {
  const t = transition(BID_MACHINE, status as never, command)
  return t.ok ? null : fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${status}`, { from: status, command })
}

export const open = (rfx: { status: string; closesAt: Date | null }, now: Date) => rfx.status === 'OPEN' && rfx.closesAt !== null && now.getTime() < rfx.closesAt.getTime()

type Content = { currency?: string; priceIncludesVat: boolean; deliveryDays?: number; promisedDeliveryOn?: string; note?: string; lines: z.infer<typeof BidLineInput>[] }

/** Writes the bid's header and lines as given (a draft, or the values of a submit); RFx lines of another RFx are refused */
async function writeContent(tx: TenantTx, ctx: Ctx, rfx: { id: string; kind: string }, bidId: string, content: Content): Promise<Fail | null> {
  if (content.currency !== undefined && content.currency !== RFX_CURRENCY) return fail('VALIDATION_FAILED', 'prices are in Thai baht only', { field: 'currency', reason: 'CURRENCY' })
  const lines = await tx.rfxLine.findMany({ where: { rfxEventId: rfx.id }, select: { id: true } })
  const known = new Set(lines.map((l) => l.id))
  if (content.lines.some((l) => !known.has(l.rfxLineId))) return fail('VALIDATION_FAILED', 'a line of another RFx', { field: 'lines', reason: 'LINE' })
  if (new Set(content.lines.map((l) => l.rfxLineId)).size !== content.lines.length) return fail('VALIDATION_FAILED', 'a line given twice', { field: 'lines', reason: 'DUPLICATE_LINE' })
  // an RFI has no price: its answer is the note and the files (BR-RFX-02)
  if (rfx.kind === 'RFI' && (content.lines.length || content.priceIncludesVat)) return fail('VALIDATION_FAILED', 'an RFI takes no prices', { field: 'lines', reason: 'RFI_NO_PRICE' })
  for (const l of content.lines) {
    const price = l.unitPrice ? amountToSatang(l.unitPrice) : null
    if (l.offered && (price === null || price <= 0n)) return fail('VALIDATION_FAILED', 'an offered line has a price above zero', { field: `lines.${l.rfxLineId}.unitPrice`, reason: 'PRICE' })
    if (!l.offered && price !== null) return fail('VALIDATION_FAILED', 'a line not offered has no price', { field: `lines.${l.rfxLineId}.unitPrice`, reason: 'PRICE' })
  }
  await tx.bidLine.deleteMany({ where: { bidId } })
  if (content.lines.length) {
    await tx.bidLine.createMany({
      data: content.lines.map((l) => ({
        organizationId: ctx.organizationId,
        bidId,
        rfxLineId: l.rfxLineId,
        offered: l.offered,
        unitPriceSatang: l.offered ? amountToSatang(l.unitPrice!) : null,
        brand: l.brand ?? null,
        leadTimeDays: l.leadTimeDays ?? null,
        note: l.note ?? null,
      })),
    })
  }
  await tx.bid.update({
    where: { id: bidId },
    data: { priceIncludesVat: content.priceIncludesVat, deliveryDays: content.deliveryDays ?? null, promisedDeliveryOn: content.promisedDeliveryOn ? new Date(`${content.promisedDeliveryOn}T00:00:00Z`) : null, note: content.note ?? null },
  })
  return null
}

/** The bid of the supplier on the RFx, made when there is none (one per supplier per RFx · INV-RFX-02) */
export async function bidOf(tx: TenantTx, ctx: Ctx, rfxEventId: string, inviteId: string, supplierId: string) {
  const found = await tx.bid.findFirst({ where: { rfxEventId, supplierId }, select: { id: true } })
  const id = found?.id ?? (await tx.bid.create({ data: { organizationId: ctx.organizationId, rfxEventId, inviteId, supplierId }, select: { id: true } })).id
  await lockRowsForUpdate(tx, 'Bid', ctx.organizationId, [id])
  return tx.bid.findUniqueOrThrow({ where: { id } })
}

// ---------- portal.rfx.view · portal.rfx.decline ----------

const ViewInput = z.strictObject({ rfxEventId: z.uuid() })

/** The detail page POSTs this once after it loads (never its GET · §17.3): INVITED → VIEWED */
export const viewRfxCommand = defineCommand({
  name: 'portal.rfx.view',
  capability: 'portal.rfx.view',
  input: ViewInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ inviteId: string }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const invite = await contactInvite(tx, ctx, input.rfxEventId, 'portal.rfx.view')
    if (isFail(invite)) return invite
    if (invite.status !== 'INVITED') return fail('INVALID_STATE_TRANSITION', 'viewed already', { from: invite.status, command: 'portal.rfx.view' })
    await tx.rfxInvite.update({ where: { id: invite.id }, data: { status: 'VIEWED', viewedAt: ctx.now, version: { increment: 1 } } })
    return { ok: true, result: { inviteId: invite.id }, events: [{ type: 'rfx_invite.viewed', aggregateType: 'RfxInvite', aggregateId: invite.id, data: { rfxEventId: input.rfxEventId } }] }
  },
})

const DeclineInput = z.strictObject({ rfxEventId: z.uuid(), reason: z.string().trim().max(500).optional() })

export const declineRfxCommand = defineCommand({
  name: 'portal.rfx.decline',
  capability: 'portal.rfx.decline',
  input: DeclineInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ inviteId: string }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    const invite = rfx ? await contactInvite(tx, ctx, rfx.id, 'portal.rfx.decline') : fail('NOT_FOUND', 'RFx not found')
    if (isFail(invite)) return invite
    if (!open(rfx!, ctx.now)) return fail('RFX_CLOSED', 'the RFx is closed for bids', { closesAt: rfx!.closesAt?.toISOString() ?? null })
    if (invite.status !== 'INVITED' && invite.status !== 'VIEWED') return fail('INVALID_STATE_TRANSITION', `portal.rfx.decline is not allowed from ${invite.status}`, { from: invite.status, command: 'portal.rfx.decline' })
    await tx.rfxInvite.update({ where: { id: invite.id }, data: { status: 'DECLINED', declinedAt: ctx.now, declineReason: input.reason ?? null, version: { increment: 1 } } })
    return { ok: true, result: { inviteId: invite.id }, events: [{ type: 'rfx_invite.declined', aggregateType: 'RfxInvite', aggregateId: invite.id, data: { rfxEventId: rfx!.id, withReason: Boolean(input.reason) } }] }
  },
})

// ---------- bid.save · bid.submit · bid.withdraw (the contact · BR-RFX-07 08) ----------

const SaveInput = z.strictObject(BidContent)

export const saveBidCommand = defineCommand({
  name: 'bid.save',
  capability: 'portal.rfx.bid',
  input: SaveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ bidId: string; version: number }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    const invite = rfx ? await contactInvite(tx, ctx, rfx.id, 'portal.rfx.bid') : fail('NOT_FOUND', 'RFx not found')
    if (isFail(invite)) return invite
    if (!open(rfx!, ctx.now)) return fail('RFX_CLOSED', 'the RFx is closed for bids', { closesAt: rfx!.closesAt?.toISOString() ?? null })
    const supplier = await biddingSupplier(tx, invite.supplierId)
    if (isFail(supplier)) return supplier
    if (!MAY_BID.has(invite.status)) return fail('INVALID_STATE_TRANSITION', `bid.save is not allowed from the invite's ${invite.status}`, { from: invite.status, command: 'bid.save' })
    const bid = await bidOf(tx, ctx, rfx!.id, invite.id, supplier.id)
    const refused = bidStep(bid.status, 'bid.save')
    if (refused) return refused
    const wrote = await writeContent(tx, ctx, rfx!, bid.id, input)
    if (wrote) return wrote
    const saved = await tx.bid.update({ where: { id: bid.id }, data: { status: 'DRAFT', version: { increment: 1 } }, select: { version: true } })
    return { ok: true, result: { bidId: bid.id, version: saved.version }, events: [{ type: 'bid.saved', aggregateType: 'Bid', aggregateId: bid.id, data: { rfxEventId: rfx!.id, lines: input.lines.length } }] }
  },
})

interface Submitted {
  readonly bidId: string
  readonly submitCount: number
  readonly net: bigint
  readonly vat: bigint
  readonly gross: bigint
  readonly events: EventDraft[]
}

/** BR-RFX-07 08: complete unless partial bids are allowed, VAT included only where allowed, the amounts by compareBids */
async function submitInTx(
  tx: TenantTx,
  ctx: Ctx,
  rfx: NonNullable<Awaited<ReturnType<typeof lockedRfx>>>,
  bid: { id: string; status: string; submitCount: number },
  supplier: { id: string; isVatRegistered: boolean; isForeign: boolean },
  by: { contactId: string | null; memberId: string | null },
): Promise<Fail | Submitted> {
  const lines = await tx.rfxLine.findMany({ where: { rfxEventId: rfx.id }, orderBy: { lineNo: 'asc' }, select: { id: true, quantity: true, lineNo: true } })
  const offered = await tx.bidLine.findMany({ where: { bidId: bid.id }, select: { id: true, rfxLineId: true, offered: true, unitPriceSatang: true } })
  const priced = new Map(offered.filter((l) => l.offered && l.unitPriceSatang !== null).map((l) => [l.rfxLineId, l.unitPriceSatang!]))
  const header = await tx.bid.findUniqueOrThrow({ where: { id: bid.id }, select: { priceIncludesVat: true } })
  if (rfx.kind !== 'RFI') {
    const missing = lines.filter((l) => !priced.has(l.id)).map((l) => l.lineNo)
    if (priced.size === 0 || (missing.length && !rfx.allowPartialBids)) return fail('BID_INCOMPLETE', 'the bid lacks the price of some lines', { lines: missing.join(', ') })
    // OQ-212: a price with VAT included where the RFx takes one, from a supplier registered for VAT
    if (header.priceIncludesVat && (!rfx.allowVatInclusiveBids || !supplier.isVatRegistered)) return fail('VAT_INCLUSIVE_NOT_ALLOWED', 'the RFx takes prices before VAT')
  }
  // BR-VAT-01 04: the rate of the day of the submit; 0 for a supplier not registered or abroad
  let vatRateBp = 0
  if (supplier.isVatRegistered && !supplier.isForeign) {
    const rate = rateFor(taxDateOf(ctx.now), await listTaxRates())
    if (!rate.ok) return fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers today', { date: rate.date })
    vatRateBp = rate.rateBp
  }
  let net = 0n
  let vat = 0n
  let gross = 0n
  let quoted = 0n
  if (rfx.kind !== 'RFI') {
    const cmp = compareBids(
      lines.map((l) => ({ ref: l.id, quantity: l.quantity.toString() })),
      [{ ref: bid.id, priceIncludesVat: header.priceIncludesVat, vatRateBp, unitPrices: Object.fromEntries(priced) }],
    ).bids[0]!
    ;({ net, vat, gross } = cmp)
    const lineNets = new Map(cmp.lineNet)
    for (const l of lines) {
      const price = priced.get(l.id)
      if (price === undefined) continue
      // the quoted amount of the line, as compareBids counts it (BR-MONEY-02 item 1)
      const lineQuoted = lineNet(l.quantity.toString(), price)
      quoted += lineQuoted
      await tx.bidLine.updateMany({ where: { bidId: bid.id, rfxLineId: l.id }, data: { lineQuotedSatang: lineQuoted, lineNetSatang: lineNets.get(l.id)! } })
    }
  }
  const submitCount = bid.submitCount + 1
  await tx.bid.update({
    where: { id: bid.id },
    data: {
      status: 'SUBMITTED',
      isVatRegistered: supplier.isVatRegistered,
      vatRateBp,
      quotedTotalSatang: quoted,
      netSatang: net,
      vatSatang: vat,
      grossSatang: gross,
      isPartial: rfx.kind !== 'RFI' && priced.size < lines.length,
      validUntil: new Date(`${bidValidUntil(ctx.now, rfx.bidValidityDays)}T00:00:00Z`),
      submittedAt: ctx.now,
      submittedByContactId: by.contactId,
      submittedByMemberId: by.memberId,
      submitCount,
      revisionNoAtSubmit: rfx.revisionNo,
      withdrawnAt: null,
      version: { increment: 1 },
    },
  })
  await tx.rfxInvite.updateMany({ where: { rfxEventId: rfx.id, supplierId: supplier.id }, data: { status: 'BID_SUBMITTED', needsReconfirm: false } })
  const amounts = rfx.sealed ? {} : { net: satangToAmount(net), vat: satangToAmount(vat), gross: satangToAmount(gross) }
  return {
    bidId: bid.id,
    submitCount,
    net,
    vat,
    gross,
    events: [
      // no amount while sealed (BR-RFX-06 · BR-RFX-17)
      { type: 'bid.submitted', aggregateType: 'Bid', aggregateId: bid.id, data: { rfxEventId: rfx.id, submitCount, isPartial: rfx.kind !== 'RFI' && priced.size < lines.length, revisionNoAtSubmit: rfx.revisionNo, onBehalf: by.memberId !== null, ...amounts } },
    ],
  }
}

const SubmitInput = z.strictObject({ ...BidContent, expectedVersion: z.int().min(0).optional() })

export const submitBidCommand = defineCommand({
  name: 'bid.submit',
  capability: 'portal.rfx.bid',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ bidId: string; submitCount: number; net: string; vat: string; gross: string }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    const invite = rfx ? await contactInvite(tx, ctx, rfx.id, 'portal.rfx.bid') : fail('NOT_FOUND', 'RFx not found')
    if (isFail(invite)) return invite
    // at closesAt exactly the bid is late (BR-RFX-02 · GC-SRC-20)
    if (!open(rfx!, ctx.now)) return fail('RFX_CLOSED', 'the RFx is closed for bids', { closesAt: rfx!.closesAt?.toISOString() ?? null })
    const supplier = await biddingSupplier(tx, invite.supplierId)
    if (isFail(supplier)) return supplier
    if (!MAY_BID.has(invite.status)) return fail('INVALID_STATE_TRANSITION', `bid.submit is not allowed from the invite's ${invite.status}`, { from: invite.status, command: 'bid.submit' })
    const bid = await bidOf(tx, ctx, rfx!.id, invite.id, supplier.id)
    const refused = bidStep(bid.status, 'bid.submit')
    if (refused) return refused
    if (input.expectedVersion !== undefined && input.expectedVersion !== bid.version) return fail('CONFLICT_VERSION', 'the bid changed meanwhile', { expectedVersion: input.expectedVersion, version: bid.version })
    const wrote = await writeContent(tx, ctx, rfx!, bid.id, input)
    if (wrote) return wrote
    const done = await submitInTx(tx, ctx, rfx!, bid, supplier, { contactId: ctx.actor.type === 'SUPPLIER' ? ctx.actor.supplierContactId : null, memberId: null })
    if (isFail(done)) return done
    const out = effects()
    out.events.push(...done.events)
    absorb(
      out,
      await enqueueSupplierNotice(tx, ctx, {
        templateKey: SOURCING_SUPPLIER_TEMPLATES.bidReceived,
        contactId: invite.contactId,
        supplierId: supplier.id,
        subjectType: 'Bid',
        subjectId: bid.id,
        dedupeKey: `rfx.bid_received:${bid.id}:${done.submitCount}`,
        data: { number: rfx!.number, title: rfx!.title, titleEn: rfx!.titleEn, submitCount: done.submitCount, net: satangToAmount(done.net), vat: satangToAmount(done.vat), gross: satangToAmount(done.gross), rfi: rfx!.kind === 'RFI', loginUrl: portalLoginUrl(await orgCodeOf(tx, ctx.organizationId)) },
      }),
    )
    return { ok: true, result: { bidId: bid.id, submitCount: done.submitCount, net: satangToAmount(done.net), vat: satangToAmount(done.vat), gross: satangToAmount(done.gross) }, ...out }
  },
})

const WithdrawInput = z.strictObject({ rfxEventId: z.uuid(), reason: z.string().trim().max(500).optional() })

export const withdrawBidCommand = defineCommand({
  name: 'bid.withdraw',
  capability: 'portal.rfx.bid',
  input: WithdrawInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ bidId: string }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    const invite = rfx ? await contactInvite(tx, ctx, rfx.id, 'portal.rfx.bid') : fail('NOT_FOUND', 'RFx not found')
    if (isFail(invite)) return invite
    if (!open(rfx!, ctx.now)) return fail('RFX_CLOSED', 'the RFx is closed for bids', { closesAt: rfx!.closesAt?.toISOString() ?? null })
    const bid = invite.supplierId ? await tx.bid.findFirst({ where: { rfxEventId: rfx!.id, supplierId: invite.supplierId }, select: { id: true, status: true } }) : null
    if (!bid) return fail('NOT_FOUND', 'no bid to withdraw')
    await lockRowsForUpdate(tx, 'Bid', ctx.organizationId, [bid.id])
    const refused = bidStep(bid.status, 'bid.withdraw')
    if (refused) return refused
    await tx.bid.update({ where: { id: bid.id }, data: { status: 'WITHDRAWN', withdrawnAt: ctx.now, version: { increment: 1 } } })
    await tx.rfxInvite.update({ where: { id: invite.id }, data: { status: 'WITHDRAWN', version: { increment: 1 } } })
    return { ok: true, result: { bidId: bid.id }, events: [{ type: 'bid.withdrawn', aggregateType: 'Bid', aggregateId: bid.id, data: { rfxEventId: rfx!.id, withReason: Boolean(input.reason) } }] }
  },
})

// ---------- bid.recordOnBehalf · bid.disqualify (PROCUREMENT) ----------

const RecordInput = z.strictObject({ ...BidContent, supplierId: z.uuid(), fileId: z.uuid() })

/** A bid received by e-mail or on paper, recorded by procurement with its file; the recorder may not approve the award (BR-SOD-13) */
export const recordBidOnBehalfCommand = defineCommand({
  name: 'bid.recordOnBehalf',
  capability: 'sourcing.manage',
  input: RecordInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ bidId: string; submitCount: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    if (!open(rfx, ctx.now)) return fail('RFX_CLOSED', 'the RFx is closed for bids', { closesAt: rfx.closesAt?.toISOString() ?? null })
    const invite = await tx.rfxInvite.findFirst({ where: { rfxEventId: rfx.id, supplierId: input.supplierId }, select: { id: true, status: true } })
    if (!invite || invite.status === 'REMOVED') return fail('NOT_FOUND', 'the supplier is not invited')
    if (!MAY_BID.has(invite.status)) return fail('INVALID_STATE_TRANSITION', `bid.recordOnBehalf is not allowed from the invite's ${invite.status}`, { from: invite.status, command: 'bid.recordOnBehalf' })
    const supplier = await biddingSupplier(tx, input.supplierId)
    if (isFail(supplier)) return supplier
    const file = await tx.fileObject.findUnique({ where: { id: input.fileId }, select: { id: true, status: true, uploadedById: true } })
    if (!file || file.status !== 'AVAILABLE' || file.uploadedById !== memberOf(ctx)) return fail('VALIDATION_FAILED', 'the bid is recorded with its file', { field: 'fileId', reason: 'FILE' })
    // a file is the evidence of one document only
    if (await tx.fileLink.count({ where: { fileId: file.id } })) return fail('VALIDATION_FAILED', 'the file is the evidence of another document', { field: 'fileId', reason: 'FILE_LINKED' })
    // a bid the supplier made itself in the portal (a draft or sent) is never replaced by procurement (BR-RFX-07)
    const own = await tx.bid.findFirst({ where: { rfxEventId: rfx.id, supplierId: supplier.id, OR: [{ submittedByContactId: { not: null } }, { submittedByMemberId: null }] }, select: { id: true } })
    if (own) return fail('VALIDATION_FAILED', 'the supplier has its own bid in the portal', { field: 'supplierId', reason: 'BID_FROM_SUPPLIER' })
    const bid = await bidOf(tx, ctx, rfx.id, invite.id, supplier.id)
    const stepRefused = bidStep(bid.status, 'bid.submit')
    if (stepRefused) return stepRefused
    const wrote = await writeContent(tx, ctx, rfx, bid.id, input)
    if (wrote) return wrote
    const done = await submitInTx(tx, ctx, rfx, bid, supplier, { contactId: null, memberId: memberOf(ctx) })
    if (isFail(done)) return done
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: file.id, subjectType: 'Bid', subjectId: bid.id, kind: 'BID_DOC' } })
    return {
      ok: true,
      result: { bidId: bid.id, submitCount: done.submitCount },
      events: [...done.events, { type: 'bid.recorded_on_behalf', aggregateType: 'Bid', aggregateId: bid.id, data: { rfxEventId: rfx.id, memberId: memberOf(ctx)!, fileId: file.id } }],
    }
  },
})

const DisqualifyInput = z.strictObject({ bidId: z.uuid(), reason: z.string().trim().min(3).max(500) })

/** After the close, a bid that breaks the RFx's conditions is out (BR-RFX-10); refused while an award is open (AWARD_OPEN) */
export const disqualifyBidCommand = defineCommand({
  name: 'bid.disqualify',
  capability: 'sourcing.manage',
  input: DisqualifyInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ bidId: string }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const found = await tx.bid.findUnique({ where: { id: input.bidId }, select: { rfxEventId: true } })
    if (!found) return fail('NOT_FOUND', 'bid not found')
    const rfx = (await lockedRfx(tx, ctx, found.rfxEventId))!
    if (rfx.status !== 'CLOSED' && rfx.status !== 'EVALUATING') return fail('INVALID_STATE_TRANSITION', 'a bid is disqualified after the close', { from: rfx.status, command: 'bid.disqualify' })
    const award = await tx.awardDecision.findFirst({ where: { rfxEventId: rfx.id, status: { in: ['DRAFT', 'RETURNED', 'PENDING_APPROVAL'] } }, select: { id: true, number: true } })
    if (award) return fail('INVALID_STATE_TRANSITION', 'cancel the open award first', { from: rfx.status, command: 'bid.disqualify', reason: 'AWARD_OPEN', award: award.number ?? award.id })
    await lockRowsForUpdate(tx, 'Bid', ctx.organizationId, [input.bidId])
    const bid = await tx.bid.findUniqueOrThrow({ where: { id: input.bidId }, select: { id: true, status: true } })
    const stepRefused = bidStep(bid.status, 'bid.disqualify')
    if (stepRefused) return stepRefused
    const reasonCommentId = (await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'Bid', subjectId: bid.id, authorMemberId: memberOf(ctx), body: input.reason }, select: { id: true } })).id
    await tx.bid.update({ where: { id: bid.id }, data: { status: 'DISQUALIFIED', disqualifyReason: input.reason, version: { increment: 1 } } })
    const events: EventDraft[] = [{ type: 'bid.disqualified', aggregateType: 'Bid', aggregateId: bid.id, data: { rfxEventId: rfx.id, reasonCommentId } }]
    // a ranking revealed already is computed again without the bid (BR-RFX-10)
    if (rfx.scorecardId) {
      const card = await tx.scorecard.findUnique({ where: { id: rfx.scorecardId }, select: { id: true, status: true } })
      if (card?.status === 'REVEALED') {
        await tx.scorecard.update({ where: { id: card.id }, data: { version: { increment: 1 } } })
        // the ranking without the bid; the one before stays in the event of the reveal (AC6)
        const ranking = await rankingOf(tx, card.id)
        events.push({ type: 'scorecard.recomputed', aggregateType: 'Scorecard', aggregateId: card.id, data: { rfxEventId: rfx.id, bidId: bid.id, reason: 'DISQUALIFIED', ranking: rankingData(ranking) } })
      }
    }
    return { ok: true, result: { bidId: bid.id }, events }
  },
})

// ---------- the sealed envelope (BR-RFX-06 · INV-RFX-01) ----------

/** Before the close of a sealed RFx a bid's prices are nobody's inside: the refusal is kept (security.sealed_bid_denied) */
const sealedDeniedCommand = defineCommand({
  name: 'bid.readSealed',
  capability: 'sourcing.view',
  input: z.strictObject({ bidId: z.uuid(), rfxEventId: z.uuid() }),
  async execute(_tx, input, ctx): Promise<CommandOutcome<never>> {
    return {
      ok: false,
      error: { code: 'FORBIDDEN', message: 'the prices of a sealed RFx are seen after the close', details: { reason: 'SEALED' } },
      auditEvents: [{ type: 'security.sealed_bid_denied', aggregateType: 'Security', aggregateId: input.bidId, data: { rfxEventId: input.rfxEventId, bidId: input.bidId, actorMemberId: memberOf(ctx) } }],
    }
  },
})

export interface MemberBidView {
  readonly id: string
  readonly supplierId: string
  readonly status: string
  readonly priceIncludesVat: boolean
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly lines: ReadonlyArray<{ readonly rfxLineId: string; readonly offered: boolean; readonly unitPrice: string | null; readonly lineNet: string | null }>
}

/** A bid's prices for a member with sourcing.view: refused FORBIDDEN reason SEALED before the close of a sealed RFx */
export async function bidForMember(ctx: Ctx, bidId: string): Promise<Result<MemberBidView>> {
  const db = forTenant(ctx.organizationId)
  const bid = await db.bid.findUnique({ where: { id: bidId }, include: { lines: true, rfxEvent: { select: { id: true, status: true, sealed: true } } } })
  if (!bid) return { ok: false, error: { code: 'NOT_FOUND', message: 'bid not found' } }
  // sourcing.view with the RFx as its resource: only those who read its prices (S10-08 review 2 · access.ts)
  const may = await db.$transaction((tx) => rfxReading(tx, ctx, bid.rfxEventId))
  if (!may.ok) return may
  if (may.data !== 'PRICES') return { ok: false, error: { code: 'FORBIDDEN', message: 'a requester sees the RFx, not its prices', details: { reason: 'PRICES' } } }
  const beforeClose = bid.rfxEvent.status === 'DRAFT' || bid.rfxEvent.status === 'OPEN'
  if (bid.rfxEvent.sealed && beforeClose) {
    const r = await runCommand(ctx, sealedDeniedCommand, { bidId, rfxEventId: bid.rfxEvent.id }, { idempotencyKey: `bid.readSealed:${bidId}:${ctx.requestId}` })
    return r.ok ? { ok: false, error: { code: 'FORBIDDEN', message: 'sealed', details: { reason: 'SEALED' } } } : r
  }
  return {
    ok: true,
    data: {
      id: bid.id,
      supplierId: bid.supplierId,
      status: bid.status,
      priceIncludesVat: bid.priceIncludesVat,
      net: satangToAmount(bid.netSatang),
      vat: satangToAmount(bid.vatSatang),
      gross: satangToAmount(bid.grossSatang),
      lines: bid.lines.map((l) => ({ rfxLineId: l.rfxLineId, offered: l.offered, unitPrice: l.unitPriceSatang === null ? null : satangToAmount(l.unitPriceSatang), lineNet: l.lineNetSatang === null ? null : satangToAmount(l.lineNetSatang) })),
    },
  }
}

export const viewRfx = (ctx: Ctx, input: z.input<typeof ViewInput>, opts: RunOptions) => runCommand(ctx, viewRfxCommand, input, opts)
export const declineRfx = (ctx: Ctx, input: z.input<typeof DeclineInput>, opts: RunOptions) => runCommand(ctx, declineRfxCommand, input, opts)
export const saveBid = (ctx: Ctx, input: z.input<typeof SaveInput>, opts: RunOptions) => runCommand(ctx, saveBidCommand, input, opts)
export const submitBid = (ctx: Ctx, input: z.input<typeof SubmitInput>, opts: RunOptions) => runCommand(ctx, submitBidCommand, input, opts)
export const withdrawBid = (ctx: Ctx, input: z.input<typeof WithdrawInput>, opts: RunOptions) => runCommand(ctx, withdrawBidCommand, input, opts)
export const recordBidOnBehalf = (ctx: Ctx, input: z.input<typeof RecordInput>, opts: RunOptions) => runCommand(ctx, recordBidOnBehalfCommand, input, opts)
export const disqualifyBid = (ctx: Ctx, input: z.input<typeof DisqualifyInput>, opts: RunOptions) => runCommand(ctx, disqualifyBidCommand, input, opts)

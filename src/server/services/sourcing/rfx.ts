import { z } from 'zod'
import { lineNet, type Satang } from '@/core/money/math'
import { amountToSatang } from '@/core/money/dto'
import type { AppError } from '@/core/result'
import { formatQuantity } from '@/core/receiving'
import { subtractBusinessMinutes } from '@/core/sla'
import { checkSod } from '@/core/sod'
import { earliestCloseAt, minInvites as minInvitesOf, questionCutoffAt, validateScorecard, type RfxKind } from '@/core/sourcing'
import { RFX_EVENT_MACHINE, transition, type RfxEventCommand } from '@/core/state-machines'
import { rateFor, taxDateOf } from '@/core/vat'
import { BASIS_POINTS_WHOLE, RFX_LONG_TEXT_MAX, RFX_SUMMARY_MAX } from '@/lib/constants'
import { sourcingSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Capability } from '@/server/authz/permissions'
import { systemCtx, type Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import { SOURCING_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-sourcing'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { enabledModules, requireModule } from '../modules'
import { issueDocumentNumber } from '../numbering'
import { freeLines } from '../procurement/pool'
import { absorb, effects, inviteContactOf, mailInvites, orgCodeOf, sendInvitation, supplierSnapshot, type Effects, type RfxMailFacts } from './invites'

// The life of an RFx (S10-04 · ADR-201 · BR-RFX-01 to 03 05 16 18 · FR-SRC-201 AC1 AC2 AC3 AC5 AC6): PROCUREMENT makes an
// RFQ RFP or RFI from lines of the pool that have no supplier yet (one category, priced before VAT) or from a need,
// invites suppliers (or applications of S7), sets the scorecard, opens it (a number, the scorecard locked, a link and an
// e-mail to every invite), amends or extends it while open, and cancels it; the job rfx-close closes it at closesAt.
// Every command checks the module SOURCING, the capability, the state machine and the version. A request line in an RFx
// that has not ended is held there: RequestLine.rfxEventId is the projection of its active RfxLineSource, and
// procurement.assign_supplier refuses it (LINE_IN_RFX · INV-RFX-03).

type Fail = { readonly ok: false; readonly error: AppError; readonly auditEvents?: readonly EventDraft[] }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const reasonOf = (field: string, reason: string, message: string, extra: Record<string, unknown> = {}): Fail => fail('VALIDATION_FAILED', message, { field, reason, ...extra })

const REASON = z.string().trim().min(3).max(500)
const TEXT = z.string().trim().min(1).max(200)
const LONG_TEXT = z.string().trim().max(RFX_LONG_TEXT_MAX)
const BAHT = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
const QUANTITY = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/)
/** The statuses in which an RFx has not ended: its lines are held (INV-RFX-03) and it keeps SOURCING on */
export const RFX_OPEN_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'EVALUATING'] as const
const ACTIVE_INVITE = ['INVITED', 'VIEWED', 'DECLINED', 'BID_SUBMITTED', 'WITHDRAWN'] as const

const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

async function gate(tx: TenantTx, ctx: Ctx, capability: Capability): Promise<Fail | null> {
  const on = await requireModule(ctx, 'SOURCING', tx)
  if (!on.ok) return { ok: false, error: on.error }
  const may = await authorize(tx, ctx, capability)
  return may.ok ? null : { ok: false, error: may.error }
}

async function settingsOf(tx: TenantTx, ctx: Ctx) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  return sourcingSettingsOf(org.settings)
}

async function lockedRfx(tx: TenantTx, ctx: Ctx, rfxEventId: string) {
  await lockRowsForUpdate(tx, 'RfxEvent', ctx.organizationId, [rfxEventId])
  return tx.rfxEvent.findUnique({ where: { id: rfxEventId } })
}
type Rfx = NonNullable<Awaited<ReturnType<typeof lockedRfx>>>

/** The state machine and the optimistic version of the RFx; the next state on success */
function step(rfx: Rfx, command: RfxEventCommand, expectedVersion: number): Fail | { readonly to: Rfx['status'] } {
  const t = transition(RFX_EVENT_MACHINE, rfx.status, command)
  if (!t.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${rfx.status}`, { from: rfx.status, command })
  if (rfx.version !== expectedVersion) return fail('CONFLICT_VERSION', 'the RFx changed meanwhile', { expectedVersion, version: rfx.version })
  return { to: t.to }
}
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false

const mailFacts = (rfx: Pick<Rfx, 'id' | 'number' | 'title' | 'titleEn' | 'closesAt' | 'questionCutoffAt' | 'revisionNo'>): RfxMailFacts => ({
  id: rfx.id,
  number: rfx.number,
  title: rfx.title,
  titleEn: rfx.titleEn,
  closesAt: rfx.closesAt,
  questionCutoffAt: rfx.questionCutoffAt,
  revisionNo: rfx.revisionNo,
})

async function comment(tx: TenantTx, ctx: Ctx, rfxEventId: string, body: string): Promise<string> {
  const row = await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'RfxEvent', subjectId: rfxEventId, authorMemberId: memberOf(ctx), body }, select: { id: true } })
  return row.id
}

// ---------- the lines: from the pool or a need ----------

const NeedLine = z.strictObject({
  description: TEXT,
  descriptionEn: TEXT.nullable().optional(),
  quantity: QUANTITY,
  uom: z.string().trim().min(1).max(40),
  uomEn: z.string().trim().min(1).max(40).nullable().optional(),
  catalogItemId: z.uuid().nullable().optional(),
  deliverySiteId: z.uuid().nullable().optional(),
  /** A reference price typed in, before VAT (BR-RFX-11 · MANUAL) */
  refUnitPrice: BAHT.nullable().optional(),
  requiredDeliveryOn: z.iso.date().nullable().optional(),
})
const Source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('REQUEST_LINES'), requestLineIds: z.array(z.uuid()).min(1).max(200) }),
  z.strictObject({ kind: z.literal('NEED'), categoryCode: z.string().trim().min(1).max(40), lines: z.array(NeedLine).min(1).max(200) }),
])
type SourceInput = z.infer<typeof Source>

interface PlannedLine {
  readonly description: string
  readonly descriptionEn: string | null
  readonly categoryCode: string
  readonly catalogItemId: string | null
  readonly quantity: string
  readonly uom: string
  readonly uomEn: string | null
  readonly deliverySiteId: string | null
  readonly refUnitPriceSatang: Satang | null
  readonly refSource: 'AGREEMENT' | 'CATALOG' | 'MANUAL' | null
  readonly requiredDeliveryOn: Date | null
  /** The price the estimate counts when there is no reference: the request line's own, before VAT */
  readonly estimateUnitPriceSatang: Satang
  readonly source: { readonly requestLineId: string; readonly quantity: string; readonly requesterMemberId: string; readonly chargedDepartmentId: string } | null
}

/** The reference price of a catalogue item on a day: the lowest agreed price in force, else the catalogue's (BR-RFX-11) */
async function referenceOf(tx: TenantTx, catalogItemId: string | null, day: Date): Promise<{ readonly unitPriceSatang: Satang; readonly source: 'AGREEMENT' | 'CATALOG' } | null> {
  if (!catalogItemId) return null
  const agreement = await tx.priceAgreement.findFirst({
    where: { catalogItemId, validFrom: { lte: day }, validTo: { gt: day }, endedAt: null },
    orderBy: [{ unitPriceSatang: 'asc' }, { id: 'asc' }],
    select: { unitPriceSatang: true },
  })
  if (agreement && agreement.unitPriceSatang > 0n) return { unitPriceSatang: agreement.unitPriceSatang, source: 'AGREEMENT' }
  const item = await tx.catalogItem.findUnique({ where: { id: catalogItemId }, select: { refUnitPriceSatang: true } })
  return item && item.refUnitPriceSatang > 0n ? { unitPriceSatang: item.refUnitPriceSatang, source: 'CATALOG' } : null
}

const dayOf = (at: Date): Date => new Date(`${taxDateOf(at)}T00:00:00Z`)

/** BR-RFX-01: the lines of the source, one RFx line per request line (another site is another line), one category */
async function planLines(tx: TenantTx, ctx: Ctx, source: SourceInput, holdingRfxId: string | null): Promise<Fail | { readonly categoryCode: string; readonly lines: PlannedLine[] }> {
  if (source.kind === 'NEED') {
    const lines: PlannedLine[] = []
    for (const l of source.lines) {
      const typed = l.refUnitPrice ? amountToSatang(l.refUnitPrice) : null
      const ref = typed && typed > 0n ? { unitPriceSatang: typed, source: 'MANUAL' as const } : await referenceOf(tx, l.catalogItemId ?? null, dayOf(ctx.now))
      lines.push({
        description: l.description,
        descriptionEn: l.descriptionEn ?? null,
        categoryCode: source.categoryCode,
        catalogItemId: l.catalogItemId ?? null,
        quantity: l.quantity,
        uom: l.uom,
        uomEn: l.uomEn ?? null,
        deliverySiteId: l.deliverySiteId ?? null,
        refUnitPriceSatang: ref?.unitPriceSatang ?? null,
        refSource: ref?.source ?? null,
        requiredDeliveryOn: l.requiredDeliveryOn ? new Date(`${l.requiredDeliveryOn}T00:00:00Z`) : null,
        estimateUnitPriceSatang: ref?.unitPriceSatang ?? 0n,
        source: null,
      })
    }
    return { categoryCode: source.categoryCode, lines }
  }
  const ids = [...new Set(source.requestLineIds)]
  const owners = await tx.requestLine.findMany({ where: { id: { in: ids } }, select: { requestId: true } })
  if (owners.length !== ids.length) return fail('NOT_FOUND', 'request line not found')
  // the requests of the lines are locked as procurement.assign_supplier and request.cancel lock them, and the hold is
  // read after the lock, so two of them never pass each other on one line (INV-RFX-03)
  await lockRowsForUpdate(tx, 'Request', ctx.organizationId, [...new Set(owners.map((r) => r.requestId))])
  const rows = await tx.requestLine.findMany({
    where: { id: { in: ids } },
    select: { id: true, requestId: true, catalogItemId: true, rfxEventId: true, request: { select: { requesterMemberId: true, chargedDepartmentId: true, deliverySiteId: true } } },
  })
  const held = rows.filter((r) => r.rfxEventId && r.rfxEventId !== holdingRfxId).map((r) => r.id)
  if (held.length) {
    const numbers = await tx.rfxEvent.findMany({ where: { id: { in: rows.filter((r) => held.includes(r.id)).map((r) => r.rfxEventId!) } }, select: { number: true, id: true } })
    return reasonOf('requestLineIds', 'LINE_IN_RFX', 'a line is in an RFx that has not ended', { requestLineIds: held, rfx: numbers.map((n) => n.number ?? n.id) })
  }
  const free = new Map((await freeLines(tx, { requestIds: rows.map((r) => r.requestId) })).map((l) => [l.requestLineId, l]))
  const notInPool = ids.filter((id) => !free.has(id))
  if (notInPool.length) return reasonOf('requestLineIds', 'LINE_NOT_IN_POOL', 'only lines left to order in the pool go into an RFx', { requestLineIds: notInPool })
  const withSupplier = ids.filter((id) => free.get(id)!.supplierId)
  if (withSupplier.length) return reasonOf('requestLineIds', 'LINE_HAS_SUPPLIER', 'a line that has its supplier is ordered from it, not sourced', { requestLineIds: withSupplier })
  // NEW-50: a request priced with VAT has no price before VAT to compare against
  const withVat = ids.filter((id) => free.get(id)!.priceIncludesVat)
  if (withVat.length) return reasonOf('requestLineIds', 'PRICE_INCLUDES_VAT', 'a request priced with VAT does not go into an RFx (NEW-50)', { requestLineIds: withVat })
  const categories = new Set(ids.map((id) => free.get(id)!.categoryCode))
  if (categories.size !== 1 || categories.has(null)) return reasonOf('requestLineIds', 'MIXED_CATEGORY', 'an RFx takes lines of one category', { categories: [...categories] })
  const categoryCode = [...categories][0]!
  const byId = new Map(rows.map((r) => [r.id, r]))
  const lines: PlannedLine[] = []
  for (const id of ids) {
    const f = free.get(id)!
    const row = byId.get(id)!
    const ref = await referenceOf(tx, row.catalogItemId, dayOf(ctx.now))
    const quantity = formatQuantity(f.free)
    lines.push({
      description: f.description,
      descriptionEn: null,
      categoryCode,
      catalogItemId: row.catalogItemId,
      quantity,
      uom: f.uom,
      uomEn: null,
      deliverySiteId: f.deliverySiteId,
      refUnitPriceSatang: ref?.unitPriceSatang ?? null,
      refSource: ref?.source ?? null,
      requiredDeliveryOn: null,
      estimateUnitPriceSatang: ref?.unitPriceSatang ?? f.unitPriceSatang,
      source: { requestLineId: id, quantity, requesterMemberId: row.request.requesterMemberId, chargedDepartmentId: row.request.chargedDepartmentId },
    })
  }
  return { categoryCode, lines }
}

/** Writes the planned lines after the RFx's last line number and holds their request lines (INV-RFX-03) */
async function writeLines(tx: TenantTx, ctx: Ctx, rfxEventId: string, lines: readonly PlannedLine[]): Promise<string[]> {
  const last = await tx.rfxLine.findFirst({ where: { rfxEventId }, orderBy: { lineNo: 'desc' }, select: { lineNo: true } })
  let lineNo = last?.lineNo ?? 0
  const requestLineIds: string[] = []
  for (const l of lines) {
    lineNo += 1
    const row = await tx.rfxLine.create({
      data: {
        organizationId: ctx.organizationId,
        rfxEventId,
        lineNo,
        description: l.description,
        descriptionEn: l.descriptionEn,
        categoryCode: l.categoryCode,
        catalogItemId: l.catalogItemId,
        quantity: l.quantity,
        uom: l.uom,
        uomEn: l.uomEn,
        deliverySiteId: l.deliverySiteId,
        refUnitPriceSatang: l.refUnitPriceSatang,
        refSource: l.refSource,
        requiredDeliveryOn: l.requiredDeliveryOn,
      },
      select: { id: true },
    })
    if (l.source) {
      await tx.rfxLineSource.create({ data: { organizationId: ctx.organizationId, rfxLineId: row.id, requestLineId: l.source.requestLineId, quantity: l.source.quantity } })
      await tx.requestLine.update({ where: { id: l.source.requestLineId }, data: { rfxEventId } })
      requestLineIds.push(l.source.requestLineId)
    }
  }
  return requestLineIds
}

/** The estimate, minInvites and the departments of the RFx from all its lines (BR-RFX-01 · BR-RFX-12) */
async function recompute(tx: TenantTx, ctx: Ctx, rfxEventId: string, createdById: string): Promise<Fail | { readonly estimatedNetSatang: Satang; readonly minInvites: number; readonly requestingDepartmentId: string; readonly sourceDepartmentIds: string[] }> {
  const lines = await tx.rfxLine.findMany({
    where: { rfxEventId },
    select: { quantity: true, refUnitPriceSatang: true, sources: { where: { active: true }, select: { quantity: true, requestLine: { select: { unitPriceSatang: true, request: { select: { chargedDepartmentId: true } } } } } } },
  })
  let estimate = 0n
  const departments = new Set<string>()
  for (const l of lines) {
    const price = l.refUnitPriceSatang ?? l.sources[0]?.requestLine.unitPriceSatang ?? 0n
    estimate += lineNet(l.quantity.toString(), price)
    for (const s of l.sources) departments.add(s.requestLine.request.chargedDepartmentId)
  }
  const rate = rateFor(taxDateOf(ctx.now), await listTaxRates())
  if (!rate.ok) return fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers today', { date: rate.date })
  const settings = await settingsOf(tx, ctx)
  const min = minInvitesOf(estimate, rate.rateBp, { thresholdGrossSatang: amountToSatang(settings.minInvitesThresholdGross), minInvitesAboveThreshold: settings.minInvitesAboveThreshold })
  let requestingDepartmentId: string
  if (departments.size === 1) requestingDepartmentId = [...departments][0]!
  else {
    const creator = await tx.member.findUnique({ where: { id: createdById }, select: { primaryDepartmentId: true } })
    if (!creator?.primaryDepartmentId) return fail('VALIDATION_FAILED', 'the creator has no primary department for the route of the award', { reason: 'NO_DEPARTMENT' })
    requestingDepartmentId = creator.primaryDepartmentId
  }
  return { estimatedNetSatang: estimate, minInvites: min.minInvites, requestingDepartmentId, sourceDepartmentIds: [...departments].sort() }
}

// ---------- rfx.create ----------

const CreateInput = z.strictObject({
  kind: z.enum(['RFQ', 'RFP', 'RFI']),
  title: TEXT,
  titleEn: TEXT.nullable().optional(),
  description: LONG_TEXT.min(1),
  descriptionEn: LONG_TEXT.nullable().optional(),
  locale: z.enum(['TH', 'TH_EN']).optional(),
  source: Source,
  allowPartialBids: z.boolean().optional(),
  allowVatInclusiveBids: z.boolean().optional(),
})

export const createRfxCommand = defineCommand({
  name: 'rfx.create',
  capability: 'sourcing.manage',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; minInvites: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const creator = memberOf(ctx)!
    const settings = await settingsOf(tx, ctx)
    // OQ-212: a bid with VAT included is taken only where the organization allows it
    if (input.allowVatInclusiveBids && !settings.allowVatInclusiveBids) return reasonOf('allowVatInclusiveBids', 'VAT_INCLUSIVE_NOT_ALLOWED', 'the organization takes bids before VAT only (OQ-212)')
    const planned = await planLines(tx, ctx, input.source, null)
    if (isFail(planned)) return planned
    const rfx = await tx.rfxEvent.create({
      data: {
        organizationId: ctx.organizationId,
        kind: input.kind,
        title: input.title,
        titleEn: input.titleEn ?? null,
        description: input.description,
        descriptionEn: input.descriptionEn ?? null,
        locale: input.locale ?? (input.titleEn ? 'TH_EN' : 'TH'),
        categoryCode: planned.categoryCode,
        sourceKind: input.source.kind,
        // set right below from the lines
        requestingDepartmentId: (await tx.member.findUniqueOrThrow({ where: { id: creator }, select: { primaryDepartmentId: true } })).primaryDepartmentId ?? (await anyDepartment(tx)),
        createdById: creator,
        sealed: settings.sealedBids,
        allowPartialBids: input.allowPartialBids ?? false,
        allowVatInclusiveBids: input.allowVatInclusiveBids ?? false,
        bidValidityDays: settings.bidValidityDays,
        minInvites: 1,
      },
      select: { id: true },
    })
    const requestLineIds = await writeLines(tx, ctx, rfx.id, planned.lines)
    const sums = await recompute(tx, ctx, rfx.id, creator)
    if (isFail(sums)) return sums
    await tx.rfxEvent.update({ where: { id: rfx.id }, data: sums })
    return {
      ok: true,
      result: { rfxEventId: rfx.id, minInvites: sums.minInvites },
      events: [{ type: 'rfx.created', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { kind: input.kind, sourceKind: input.source.kind, categoryCode: planned.categoryCode, requestLineIds, sealed: settings.sealedBids, minInvites: sums.minInvites } }],
    }
  },
})

/** Any department of the organization: only a placeholder until recompute sets the RFx's own in the same transaction */
async function anyDepartment(tx: TenantTx): Promise<string> {
  return (await tx.department.findFirstOrThrow({ orderBy: { code: 'asc' }, select: { id: true } })).id
}

// ---------- rfx.update · .addLines · .removeLine ----------

const UpdateInput = z.strictObject({
  rfxEventId: z.uuid(),
  expectedVersion: z.int().min(0),
  title: TEXT.optional(),
  titleEn: TEXT.nullable().optional(),
  description: LONG_TEXT.min(1).optional(),
  descriptionEn: LONG_TEXT.nullable().optional(),
  locale: z.enum(['TH', 'TH_EN']).optional(),
  allowPartialBids: z.boolean().optional(),
  allowVatInclusiveBids: z.boolean().optional(),
  bidValidityDays: z.int().min(1).max(365).optional(),
  /** BR-RFX-06: an RFx whose prices are seen before it closes needs a reason, kept as a comment (UNSEAL_REASON) */
  sealed: z.boolean().optional(),
  unsealReason: REASON.optional(),
})

export const updateRfxCommand = defineCommand({
  name: 'rfx.update',
  capability: 'sourcing.manage',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.update', input.expectedVersion)
    if (isFail(next)) return next
    if (input.allowVatInclusiveBids && !(await settingsOf(tx, ctx)).allowVatInclusiveBids) return reasonOf('allowVatInclusiveBids', 'VAT_INCLUSIVE_NOT_ALLOWED', 'the organization takes bids before VAT only (OQ-212)')
    const unsealing = input.sealed === false && rfx.sealed
    if (unsealing && !input.unsealReason) return reasonOf('unsealReason', 'UNSEAL_REASON', 'prices seen before the close need a reason (BR-RFX-06)')
    if (rfx.kind === 'RFI' && input.sealed === false) return reasonOf('sealed', 'RFI_HAS_NO_PRICE', 'an RFI has no prices to unseal')
    const { rfxEventId: _id, expectedVersion: _v, unsealReason, ...fields } = input
    const changed = Object.entries(fields).filter(([k, v]) => v !== undefined && (rfx as unknown as Record<string, unknown>)[k] !== v).map(([k]) => k)
    if (changed.length === 0) return reasonOf('rfxEventId', 'NO_CHANGE', 'nothing to change')
    const updated = await tx.rfxEvent.update({ where: { id: rfx.id }, data: { ...fields, version: { increment: 1 } }, select: { version: true } })
    const events: EventDraft[] = [{ type: 'rfx.updated', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { fields: changed } }]
    if (unsealing) events.push({ type: 'rfx.unsealed', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { reasonCommentId: await comment(tx, ctx, rfx.id, unsealReason!) } })
    return { ok: true, result: { rfxEventId: rfx.id, version: updated.version }, events }
  },
})

const AddLinesInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), source: Source })

export const addRfxLinesCommand = defineCommand({
  name: 'rfx.addLines',
  capability: 'sourcing.manage',
  input: AddLinesInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; version: number; minInvites: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.addLines', input.expectedVersion)
    if (isFail(next)) return next
    if (input.source.kind !== rfx.sourceKind) return reasonOf('source.kind', 'SOURCE_KIND', `this RFx takes lines from ${rfx.sourceKind}`)
    const planned = await planLines(tx, ctx, input.source, null)
    if (isFail(planned)) return planned
    if (planned.categoryCode !== rfx.categoryCode) return reasonOf('source', 'MIXED_CATEGORY', 'an RFx takes lines of one category', { categories: [rfx.categoryCode, planned.categoryCode] })
    const requestLineIds = await writeLines(tx, ctx, rfx.id, planned.lines)
    const sums = await recompute(tx, ctx, rfx.id, rfx.createdById)
    if (isFail(sums)) return sums
    const updated = await tx.rfxEvent.update({ where: { id: rfx.id }, data: { ...sums, version: { increment: 1 } }, select: { version: true } })
    return {
      ok: true,
      result: { rfxEventId: rfx.id, version: updated.version, minInvites: sums.minInvites },
      events: [{ type: 'rfx.lines_changed', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { added: planned.lines.length, removed: 0, requestLineIds, minInvites: sums.minInvites } }],
    }
  },
})

/** Lets the request lines of these RFx lines go back to the pool (INV-RFX-03) */
async function releaseSources(tx: TenantTx, where: { readonly rfxEventId: string; readonly rfxLineId?: string }): Promise<string[]> {
  const sources = await tx.rfxLineSource.findMany({ where: { active: true, rfxLine: { rfxEventId: where.rfxEventId, ...(where.rfxLineId ? { id: where.rfxLineId } : {}) } }, select: { id: true, requestLineId: true } })
  if (sources.length === 0) return []
  await tx.rfxLineSource.updateMany({ where: { id: { in: sources.map((s) => s.id) } }, data: { active: false } })
  await tx.requestLine.updateMany({ where: { id: { in: sources.map((s) => s.requestLineId) }, rfxEventId: where.rfxEventId }, data: { rfxEventId: null } })
  return sources.map((s) => s.requestLineId)
}

const RemoveLineInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), rfxLineId: z.uuid() })

export const removeRfxLineCommand = defineCommand({
  name: 'rfx.removeLine',
  capability: 'sourcing.manage',
  input: RemoveLineInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; version: number; minInvites: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.removeLine', input.expectedVersion)
    if (isFail(next)) return next
    const line = await tx.rfxLine.findFirst({ where: { id: input.rfxLineId, rfxEventId: rfx.id }, select: { id: true } })
    if (!line) return fail('NOT_FOUND', 'RFx line not found')
    if ((await tx.rfxLine.count({ where: { rfxEventId: rfx.id } })) === 1) return reasonOf('rfxLineId', 'LAST_LINE', 'an RFx keeps one line at least; cancel it instead')
    const requestLineIds = await releaseSources(tx, { rfxEventId: rfx.id, rfxLineId: line.id })
    // a draft line has no bid yet; its sources go with it
    await tx.rfxLineSource.deleteMany({ where: { rfxLineId: line.id } })
    await tx.rfxLine.delete({ where: { id: line.id } })
    const sums = await recompute(tx, ctx, rfx.id, rfx.createdById)
    if (isFail(sums)) return sums
    const updated = await tx.rfxEvent.update({ where: { id: rfx.id }, data: { ...sums, version: { increment: 1 } }, select: { version: true } })
    return {
      ok: true,
      result: { rfxEventId: rfx.id, version: updated.version, minInvites: sums.minInvites },
      events: [{ type: 'rfx.lines_changed', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { added: 0, removed: 1, requestLineIds, minInvites: sums.minInvites } }],
    }
  },
})

// ---------- rfx.setScorecard (DRAFT: criteria, weights, evaluators · BR-RFX-09 · BR-SOD-14) ----------

const Criterion = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/),
  nameTh: TEXT,
  nameEn: TEXT.nullable().optional(),
  weightBp: z.int().min(0).max(BASIS_POINTS_WHOLE),
  kind: z.enum(['PRICE', 'QUALITY']),
  guidance: z.string().trim().max(RFX_SUMMARY_MAX).nullable().optional(),
})
const ScorecardInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), criteria: z.array(Criterion).min(1).max(20), evaluatorMemberIds: z.array(z.uuid()).max(20) })

/** Who may not score an RFx: who created or opened it and the requesters of its source lines (BR-SOD-14) */
export async function scoringConflicts(tx: TenantTx, rfx: Pick<Rfx, 'id' | 'createdById' | 'openedById'>): Promise<{ readonly rfxCreatorMemberIds: string[]; readonly sourceRequesterMemberIds: string[] }> {
  const sources = await tx.rfxLineSource.findMany({ where: { rfxLine: { rfxEventId: rfx.id } }, select: { requestLine: { select: { request: { select: { requesterMemberId: true } } } } } })
  return {
    rfxCreatorMemberIds: [rfx.createdById, ...(rfx.openedById ? [rfx.openedById] : [])],
    sourceRequesterMemberIds: [...new Set(sources.map((s) => s.requestLine.request.requesterMemberId))],
  }
}

export const setScorecardCommand = defineCommand({
  name: 'rfx.setScorecard',
  capability: 'sourcing.manage',
  input: ScorecardInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; scorecardId: string; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.setScorecard', input.expectedVersion)
    if (isFail(next)) return next
    if (rfx.kind === 'RFI') return reasonOf('rfxEventId', 'RFI_HAS_NO_SCORECARD', 'an RFI has no scorecard')
    const valid = validateScorecard(input.criteria.map((c) => ({ code: c.code, weightBp: c.weightBp, kind: c.kind })))
    if (!valid.ok) return { ok: false, error: valid.error }
    if (new Set(input.criteria.map((c) => c.code)).size !== input.criteria.length) return reasonOf('criteria', 'DUPLICATE_CODE', 'two criteria have one code')
    const evaluators = [...new Set(input.evaluatorMemberIds)]
    const members = await tx.member.findMany({ where: { id: { in: evaluators }, status: 'ACTIVE' }, select: { id: true } })
    if (members.length !== evaluators.length) return reasonOf('evaluatorMemberIds', 'MEMBER', 'an evaluator is not an active member')
    const conflicts = await scoringConflicts(tx, rfx)
    const policy = { approverMayReceive: false, requesterMayReceive: true }
    for (const memberId of evaluators) {
      const sod = checkSod({ kind: 'SCORE_RFX', actorMemberId: memberId, ...conflicts }, policy)
      if (!sod.ok) {
        return {
          ok: false,
          error: { code: 'SOD_VIOLATION', message: 'this member may not score the RFx', details: { rule: sod.rule, memberId } },
          auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: rfx.id, data: { rule: sod.rule, action: 'rfx.setScorecard', subjectType: 'RFX_EVENT', subjectId: rfx.id, actorMemberId: memberId } }],
        }
      }
    }
    const settings = await settingsOf(tx, ctx)
    const existing = await tx.scorecard.findUnique({ where: { organizationId_rfxEventId: { organizationId: ctx.organizationId, rfxEventId: rfx.id } }, select: { id: true } })
    const scorecardId = existing?.id ?? (await tx.scorecard.create({ data: { organizationId: ctx.organizationId, rfxEventId: rfx.id, minEvaluators: settings.minEvaluators }, select: { id: true } })).id
    await tx.scoreCriterion.deleteMany({ where: { scorecardId } })
    await tx.scorecardEvaluator.deleteMany({ where: { scorecardId } })
    await tx.scoreCriterion.createMany({
      data: input.criteria.map((c, i) => ({ organizationId: ctx.organizationId, scorecardId, code: c.code, nameTh: c.nameTh, nameEn: c.nameEn ?? null, weightBp: c.weightBp, kind: c.kind, guidance: c.guidance ?? null, sortOrder: i })),
    })
    await tx.scorecardEvaluator.createMany({ data: evaluators.map((memberId) => ({ organizationId: ctx.organizationId, scorecardId, memberId, assignedAt: ctx.now })) })
    const price = input.criteria.find((c) => c.kind === 'PRICE')
    await tx.scorecard.update({ where: { id: scorecardId }, data: { priceCriterionCode: price?.code ?? null, version: { increment: 1 } } })
    const updated = await tx.rfxEvent.update({ where: { id: rfx.id }, data: { scorecardId, version: { increment: 1 } }, select: { version: true } })
    return {
      ok: true,
      result: { rfxEventId: rfx.id, scorecardId, version: updated.version },
      events: [{ type: 'scorecard.updated', aggregateType: 'Scorecard', aggregateId: scorecardId, data: { rfxEventId: rfx.id, criteria: input.criteria.map((c) => ({ code: c.code, weightBp: c.weightBp, kind: c.kind })), evaluatorMemberIds: evaluators } }],
    }
  },
})

// ---------- rfx.invite · rfx.uninvite (DRAFT, or OPEN before closesAt · BR-RFX-03) ----------

const InviteInput = z.strictObject({
  rfxEventId: z.uuid(),
  expectedVersion: z.int().min(0),
  supplierId: z.uuid().optional(),
  /** An application of S7 not yet a supplier (ADR-203) */
  applicationId: z.uuid().optional(),
})

const beforeClose = (rfx: Rfx, now: Date) => rfx.status === 'DRAFT' || (rfx.closesAt !== null && now.getTime() < rfx.closesAt.getTime())

export const inviteToRfxCommand = defineCommand({
  name: 'rfx.invite',
  capability: 'sourcing.manage',
  input: InviteInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ inviteId: string; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    if (Boolean(input.supplierId) === Boolean(input.applicationId)) return reasonOf('supplierId', 'ONE_OWNER', 'invite a supplier or an application')
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.invite', input.expectedVersion)
    if (isFail(next)) return next
    if (!beforeClose(rfx, ctx.now)) return fail('INVALID_STATE_TRANSITION', 'the RFx closes for bids already', { from: rfx.status, command: 'rfx.invite', reason: 'PAST_CLOSE' })
    const riskOn = (await enabledModules(tx)).includes('RISK')
    let owner: Parameters<typeof supplierSnapshot>[2]
    if (input.supplierId) {
      const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, nameTh: true, isVatRegistered: true, isForeign: true, registryFlag: true, status: true, portalEnabled: true } })
      if (!supplier) return fail('NOT_FOUND', 'supplier not found')
      if (supplier.status !== 'ACTIVE') return reasonOf('supplierId', 'SUPPLIER_INACTIVE', 'the supplier is not active')
      if (supplier.registryFlag === 'CEASED' || supplier.registryFlag === 'VAT_CANCELLED') return fail('SUPPLIER_FLAGGED', 'the registry flags this supplier', { flag: supplier.registryFlag })
      if (!supplier.portalEnabled) return reasonOf('supplierId', 'PORTAL_NOT_ENABLED', 'the supplier does not use the portal yet')
      owner = { supplier }
    } else {
      const application = await tx.supplierApplication.findUnique({ where: { id: input.applicationId! }, select: { kind: true, status: true, nameTh: true, isVatRegistered: true, payeeType: true, approvedSupplierId: true } })
      if (!application) return fail('NOT_FOUND', 'application not found')
      if (application.kind !== 'NEW' || ['REJECTED', 'EXPIRED', 'CANCELLED', 'APPROVED'].includes(application.status)) {
        return reasonOf('applicationId', 'APPLICATION_NOT_OPEN', 'only an open application of a new supplier is invited; an approved one is invited as its supplier')
      }
      owner = { application }
    }
    const already = await tx.rfxInvite.findFirst({ where: { rfxEventId: rfx.id, ...(input.supplierId ? { supplierId: input.supplierId } : { applicationId: input.applicationId }) }, select: { id: true } })
    if (already) return fail('ALREADY_INVITED', 'invited to this RFx already', { inviteId: already.id })
    const contactId = await inviteContactOf(tx, { supplierId: input.supplierId ?? null, applicationId: input.applicationId ?? null })
    if (!contactId) return reasonOf('supplierId', 'NO_CONTACT', 'no active contact to send the invitation to')
    const snapshot = await supplierSnapshot(tx, ctx, owner, riskOn)
    const invite = await tx.rfxInvite.create({
      data: {
        organizationId: ctx.organizationId,
        rfxEventId: rfx.id,
        supplierId: input.supplierId ?? null,
        applicationId: input.applicationId ?? null,
        contactId,
        invitedById: memberOf(ctx)!,
        invitedAt: ctx.now,
        supplierSnapshot: snapshot as unknown as object,
      },
      select: { id: true },
    })
    const updated = await tx.rfxEvent.update({ where: { id: rfx.id }, data: { version: { increment: 1 } }, select: { version: true } })
    const out = effects()
    out.events.push({ type: 'rfx_invite.created', aggregateType: 'RfxInvite', aggregateId: invite.id, data: { rfxEventId: rfx.id, supplierId: input.supplierId ?? null, applicationId: input.applicationId ?? null, afterOpen: rfx.status === 'OPEN', riskBlocked: snapshot.risk?.blocked ?? null } })
    // invited after the RFx opened: the link and the e-mail go now, in this transaction (BR-RFX-03)
    if (rfx.status === 'OPEN') {
      const sent = await sendInvitation(tx, ctx, mailFacts(rfx), { id: invite.id, contactId, supplierId: input.supplierId ?? null, applicationId: input.applicationId ?? null })
      absorb(out, sent)
    }
    return { ok: true, result: { inviteId: invite.id, version: updated.version }, ...out }
  },
})

const UninviteInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), inviteId: z.uuid(), reason: REASON })

export const uninviteFromRfxCommand = defineCommand({
  name: 'rfx.uninvite',
  capability: 'sourcing.manage',
  input: UninviteInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ inviteId: string; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.uninvite', input.expectedVersion)
    if (isFail(next)) return next
    if (!beforeClose(rfx, ctx.now)) return fail('INVALID_STATE_TRANSITION', 'the RFx closes for bids already', { from: rfx.status, command: 'rfx.uninvite', reason: 'PAST_CLOSE' })
    await lockRowsForUpdate(tx, 'RfxInvite', ctx.organizationId, [input.inviteId])
    const invite = await tx.rfxInvite.findFirst({ where: { id: input.inviteId, rfxEventId: rfx.id }, select: { id: true, status: true, linkId: true, supplierId: true } })
    if (!invite) return fail('NOT_FOUND', 'invite not found')
    if (invite.status === 'REMOVED' || invite.status === 'EXPIRED') return fail('INVALID_STATE_TRANSITION', `rfx.uninvite is not allowed from ${invite.status}`, { from: invite.status, command: 'rfx.uninvite' })
    const reasonCommentId = await comment(tx, ctx, rfx.id, input.reason)
    await tx.rfxInvite.update({ where: { id: invite.id }, data: { status: 'REMOVED', removedAt: ctx.now, removeReason: input.reason, version: { increment: 1 } } })
    if (invite.linkId) await tx.portalInviteLink.updateMany({ where: { id: invite.linkId, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
    const events: EventDraft[] = [{ type: 'rfx_invite.removed', aggregateType: 'RfxInvite', aggregateId: invite.id, data: { rfxEventId: rfx.id, reasonCommentId } }]
    // a bid it sent is out of the comparison (BR-RFX-10)
    const bid = invite.supplierId ? await tx.bid.findFirst({ where: { rfxEventId: rfx.id, supplierId: invite.supplierId, status: 'SUBMITTED' }, select: { id: true } }) : null
    if (bid) {
      await tx.bid.update({ where: { id: bid.id }, data: { status: 'DISQUALIFIED', disqualifyReason: input.reason, version: { increment: 1 } } })
      events.push({ type: 'bid.disqualified', aggregateType: 'Bid', aggregateId: bid.id, data: { rfxEventId: rfx.id, reasonCommentId } })
    }
    const updated = await tx.rfxEvent.update({ where: { id: rfx.id }, data: { version: { increment: 1 } }, select: { version: true } })
    return { ok: true, result: { inviteId: invite.id, version: updated.version }, events }
  },
})

// ---------- rfx.open (BR-RFX-01 02 · FR-SRC-201 AC2 AC3) ----------

const OpenInput = z.strictObject({
  rfxEventId: z.uuid(),
  expectedVersion: z.int().min(0),
  closesAt: z.iso.datetime({ offset: true }),
  /** Fewer invites than minInvites need a reason the approver of the award sees (FEWER_INVITES_REASON) */
  fewerInvitesReason: REASON.optional(),
})

export const openRfxCommand = defineCommand({
  name: 'rfx.open',
  capability: 'sourcing.manage',
  input: OpenInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; number: string; questionCutoffAt: string; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.open', input.expectedVersion)
    if (isFail(next)) return next
    if ((await tx.rfxLine.count({ where: { rfxEventId: rfx.id } })) === 0) return reasonOf('rfxEventId', 'NO_LINES', 'an RFx opens with one line at least')
    const invites = await tx.rfxInvite.findMany({ where: { rfxEventId: rfx.id, status: 'INVITED' }, orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }], select: { id: true, contactId: true, supplierId: true, applicationId: true } })
    if (invites.length === 0) return reasonOf('rfxEventId', 'NO_INVITES', 'an RFx opens with one invite at least')
    if (invites.length < rfx.minInvites && !input.fewerInvitesReason) {
      return reasonOf('fewerInvitesReason', 'FEWER_INVITES_REASON', `${invites.length} invites, at least ${rfx.minInvites} without a reason`, { invites: invites.length, minInvites: rfx.minInvites })
    }
    const settings = await settingsOf(tx, ctx)
    const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
    const closesAt = new Date(input.closesAt)
    const earliest = earliestCloseAt(ctx.now, settings.minOpenBusinessDays[rfx.kind as RfxKind], calendar)
    if (closesAt.getTime() < earliest.getTime()) return reasonOf('closesAt', 'CLOSE_TOO_SOON', `the RFx closes at ${earliest.toISOString()} at the earliest`, { earliest: earliest.toISOString() })
    let scorecardId: string | null = null
    if (rfx.kind !== 'RFI') {
      const card = rfx.scorecardId ? await tx.scorecard.findUnique({ where: { id: rfx.scorecardId }, select: { id: true, minEvaluators: true, criteria: { select: { code: true, weightBp: true, kind: true } }, evaluators: { where: { status: 'ASSIGNED' }, select: { memberId: true } } } }) : null
      const valid = card ? validateScorecard(card.criteria) : null
      if (!card || !valid?.ok || card.evaluators.length < card.minEvaluators) {
        return fail('SCORECARD_INCOMPLETE', 'the scorecard needs its criteria and evaluators', { min: card?.minEvaluators ?? settings.minEvaluators, evaluators: card?.evaluators.length ?? 0, weights: valid?.ok ?? false })
      }
      // BR-SOD-14 again with the lines and people of now: lines added after the scorecard bring their requesters, and the
      // opener is a creator too
      const conflicts = await scoringConflicts(tx, { ...rfx, openedById: memberOf(ctx) })
      for (const e of card.evaluators) {
        const sod = checkSod({ kind: 'SCORE_RFX', actorMemberId: e.memberId, ...conflicts }, { approverMayReceive: false, requesterMayReceive: true })
        if (!sod.ok) {
          return {
            ok: false,
            error: { code: 'SOD_VIOLATION', message: 'an evaluator may not score this RFx', details: { rule: sod.rule, memberId: e.memberId } },
            auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: rfx.id, data: { rule: sod.rule, action: 'rfx.open', subjectType: 'RFX_EVENT', subjectId: rfx.id, actorMemberId: e.memberId } }],
          }
        }
      }
      scorecardId = card.id
      await tx.scorecard.update({ where: { id: card.id }, data: { status: 'LOCKED', lockedAt: ctx.now, version: { increment: 1 } } })
    }
    const number = await issueDocumentNumber(tx, ctx, { document: 'RFX' })
    const cutoff = questionCutoffAt(closesAt, settings.questionCutoffBusinessDays, calendar)
    const reasonCommentId = input.fewerInvitesReason && invites.length < rfx.minInvites ? await comment(tx, ctx, rfx.id, input.fewerInvitesReason) : null
    const opened = await tx.rfxEvent.update({
      where: { id: rfx.id },
      data: { status: 'OPEN', number, openedAt: ctx.now, openedById: memberOf(ctx), closesAt, questionCutoffAt: cutoff, version: { increment: 1 } },
    })
    const out = effects()
    out.events.push({
      type: 'rfx.opened',
      aggregateType: 'RfxEvent',
      aggregateId: rfx.id,
      data: { number, closesAt: closesAt.toISOString(), questionCutoffAt: cutoff.toISOString(), inviteCount: invites.length, minInvites: rfx.minInvites, fewerInvitesReasonCommentId: reasonCommentId, sealed: rfx.sealed },
    })
    if (scorecardId) out.events.push({ type: 'scorecard.locked', aggregateType: 'Scorecard', aggregateId: scorecardId, data: { rfxEventId: rfx.id } })
    const orgCode = await orgCodeOf(tx, ctx.organizationId)
    for (const i of invites) absorb(out, await sendInvitation(tx, ctx, mailFacts(opened), i, orgCode))
    return { ok: true, result: { rfxEventId: rfx.id, number, questionCutoffAt: cutoff.toISOString(), version: opened.version }, ...out }
  },
})

// ---------- rfx.amend · rfx.extend (OPEN · BR-RFX-05 · BR-RFX-18) ----------

const AmendInput = z.strictObject({
  rfxEventId: z.uuid(),
  expectedVersion: z.int().min(0),
  summary: z.string().trim().min(3).max(RFX_SUMMARY_MAX),
  summaryEn: z.string().trim().min(3).max(RFX_SUMMARY_MAX).nullable().optional(),
  title: TEXT.optional(),
  titleEn: TEXT.nullable().optional(),
  description: LONG_TEXT.min(1).optional(),
  descriptionEn: LONG_TEXT.nullable().optional(),
  /** Later only (CLOSE_NOT_LATER) */
  closesAt: z.iso.datetime({ offset: true }).optional(),
})

/** Moves the close later: the question cut-off with it, and the expiry of every link not used yet (BR-RFX-05) */
async function moveClose(tx: TenantTx, ctx: Ctx, rfx: Rfx, closesAt: Date): Promise<Fail | { readonly questionCutoffAt: Date }> {
  if (!rfx.closesAt || closesAt.getTime() <= rfx.closesAt.getTime()) return reasonOf('closesAt', 'CLOSE_NOT_LATER', 'the close moves later only', { closesAt: rfx.closesAt?.toISOString() ?? null })
  const settings = await settingsOf(tx, ctx)
  const cutoff = questionCutoffAt(closesAt, settings.questionCutoffBusinessDays, await loadBusinessCalendar(tx, ctx.organizationId))
  const links = await tx.rfxInvite.findMany({ where: { rfxEventId: rfx.id, linkId: { not: null } }, select: { linkId: true } })
  if (links.length) await tx.portalInviteLink.updateMany({ where: { id: { in: links.map((l) => l.linkId!) }, usedAt: null, revokedAt: null }, data: { expiresAt: closesAt } })
  return { questionCutoffAt: cutoff }
}

export const amendRfxCommand = defineCommand({
  name: 'rfx.amend',
  capability: 'sourcing.manage',
  input: AmendInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; revisionNo: number; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.amend', input.expectedVersion)
    if (isFail(next)) return next
    if (!beforeClose(rfx, ctx.now)) return fail('INVALID_STATE_TRANSITION', 'the RFx closes for bids already', { from: rfx.status, command: 'rfx.amend', reason: 'PAST_CLOSE' })
    const texts = { title: input.title, titleEn: input.titleEn, description: input.description, descriptionEn: input.descriptionEn }
    const changedFields = Object.entries(texts).filter(([k, v]) => v !== undefined && (rfx as unknown as Record<string, unknown>)[k] !== v).map(([k]) => k)
    let moved: { readonly questionCutoffAt: Date } | null = null
    const closesAt = input.closesAt ? new Date(input.closesAt) : null
    if (closesAt) {
      const r = await moveClose(tx, ctx, rfx, closesAt)
      if (isFail(r)) return r
      moved = r
      changedFields.push('closesAt')
    }
    if (changedFields.length === 0) return reasonOf('rfxEventId', 'NO_CHANGE', 'nothing to amend')
    const revisionNo = rfx.revisionNo + 1
    await tx.rfxAmendment.create({
      data: {
        organizationId: ctx.organizationId,
        rfxEventId: rfx.id,
        revisionNo,
        summary: input.summary,
        summaryEn: input.summaryEn ?? null,
        changedFields,
        previousClosesAt: closesAt ? rfx.closesAt : null,
        newClosesAt: closesAt,
        createdById: memberOf(ctx)!,
        notifiedAt: ctx.now,
      },
    })
    const fields = Object.fromEntries(Object.entries(texts).filter(([, v]) => v !== undefined))
    const amended = await tx.rfxEvent.update({
      where: { id: rfx.id },
      data: { ...fields, revisionNo, ...(closesAt ? { closesAt, questionCutoffAt: moved!.questionCutoffAt } : {}), version: { increment: 1 } },
    })
    // a bid sent before this revision is confirmed or sent again (BR-RFX-05)
    await tx.rfxInvite.updateMany({ where: { rfxEventId: rfx.id, status: 'BID_SUBMITTED' }, data: { needsReconfirm: true } })
    const out = effects()
    out.events.push({ type: 'rfx.amended', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { revisionNo, changedFields, closesAt: amended.closesAt?.toISOString() ?? null } })
    absorb(out, await mailInvites(tx, ctx, mailFacts(amended), ['INVITED', 'VIEWED', 'BID_SUBMITTED', 'WITHDRAWN'], SOURCING_SUPPLIER_TEMPLATES.amended, `r${revisionNo}`, { summary: input.summary, summaryEn: input.summaryEn ?? null }))
    return { ok: true, result: { rfxEventId: rfx.id, revisionNo, version: amended.version }, ...out }
  },
})

const ExtendInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), closesAt: z.iso.datetime({ offset: true }) })

export const extendRfxCommand = defineCommand({
  name: 'rfx.extend',
  capability: 'sourcing.manage',
  input: ExtendInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; closesAt: string; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.extend', input.expectedVersion)
    if (isFail(next)) return next
    if (!beforeClose(rfx, ctx.now)) return fail('INVALID_STATE_TRANSITION', 'the RFx closes for bids already', { from: rfx.status, command: 'rfx.extend', reason: 'PAST_CLOSE' })
    const closesAt = new Date(input.closesAt)
    const moved = await moveClose(tx, ctx, rfx, closesAt)
    if (isFail(moved)) return moved
    const extended = await tx.rfxEvent.update({ where: { id: rfx.id }, data: { closesAt, questionCutoffAt: moved.questionCutoffAt, version: { increment: 1 } } })
    const out = effects()
    out.events.push({ type: 'rfx.extended', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { from: rfx.closesAt!.toISOString(), to: closesAt.toISOString(), closesAt: closesAt.toISOString() } })
    absorb(out, await mailInvites(tx, ctx, mailFacts(extended), ['INVITED', 'VIEWED', 'BID_SUBMITTED', 'WITHDRAWN'], SOURCING_SUPPLIER_TEMPLATES.extended, `x${extended.version}`, { previousClosesAt: rfx.closesAt!.toISOString() }))
    return { ok: true, result: { rfxEventId: rfx.id, closesAt: closesAt.toISOString(), version: extended.version }, ...out }
  },
})

// ---------- closing: the job at closesAt (rfx.close) and procurement early (rfx.closeEarly) ----------

async function closeNow(tx: TenantTx, ctx: Ctx, rfx: Rfx, early: boolean): Promise<Effects & { readonly bidCount: number }> {
  const out = effects()
  const expiring = await tx.rfxInvite.findMany({ where: { rfxEventId: rfx.id, status: { in: ['INVITED', 'VIEWED'] } }, select: { id: true } })
  if (expiring.length) await tx.rfxInvite.updateMany({ where: { id: { in: expiring.map((i) => i.id) } }, data: { status: 'EXPIRED', version: { increment: 1 } } })
  for (const i of expiring) out.events.push({ type: 'rfx_invite.expired', aggregateType: 'RfxInvite', aggregateId: i.id, data: { rfxEventId: rfx.id } })
  const bidCount = await tx.bid.count({ where: { rfxEventId: rfx.id, status: 'SUBMITTED' } })
  const declinedCount = await tx.rfxInvite.count({ where: { rfxEventId: rfx.id, status: 'DECLINED' } })
  const closed = await tx.rfxEvent.update({ where: { id: rfx.id }, data: { status: 'CLOSED', closedAt: ctx.now, version: { increment: 1 } } })
  out.events.push({ type: 'rfx.closed', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { bidCount, declinedCount, early } })
  // an RFQ priced only (one PRICE criterion) needs no evaluator: its ranking is the price, seen at the close (BR-RFX-09)
  if (rfx.scorecardId) {
    const card = await tx.scorecard.findUnique({ where: { id: rfx.scorecardId }, select: { id: true, status: true, criteria: { select: { kind: true } } } })
    if (card && card.status === 'LOCKED' && card.criteria.every((c) => c.kind === 'PRICE')) {
      await tx.scorecard.update({ where: { id: card.id }, data: { status: 'REVEALED', revealedAt: ctx.now, version: { increment: 1 } } })
      out.events.push({ type: 'scorecard.revealed', aggregateType: 'Scorecard', aggregateId: card.id, data: { rfxEventId: rfx.id, priceOnly: true } })
    }
  }
  absorb(out, await mailInvites(tx, ctx, { ...mailFacts(closed) }, ['BID_SUBMITTED'], SOURCING_SUPPLIER_TEMPLATES.closed, 'closed', { closedAt: ctx.now.toISOString() }))
  return { ...out, bidCount }
}

const CloseEarlyInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), reason: REASON })

export const closeRfxEarlyCommand = defineCommand({
  name: 'rfx.closeEarly',
  capability: 'sourcing.manage',
  input: CloseEarlyInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; bidCount: number; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.closeEarly', input.expectedVersion)
    if (isFail(next)) return next
    // every invite has answered: a bid, a decline, or it was removed (BR-RFX-02)
    const waiting = await tx.rfxInvite.count({ where: { rfxEventId: rfx.id, status: { in: ['INVITED', 'VIEWED', 'WITHDRAWN'] } } })
    if (waiting) return reasonOf('rfxEventId', 'INVITES_WAITING', `${waiting} invites have not answered yet`, { waiting })
    const reasonCommentId = await comment(tx, ctx, rfx.id, input.reason)
    const closed = await closeNow(tx, ctx, rfx, true)
    closed.events.unshift({ type: 'rfx.updated', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { fields: ['closeEarlyReason'], reasonCommentId } })
    return { ok: true, result: { rfxEventId: rfx.id, bidCount: closed.bidCount, version: rfx.version + 1 }, events: closed.events, notifications: closed.notifications, outbox: closed.outbox }
  },
})

const CloseInput = z.strictObject({ rfxEventId: z.uuid() })

/** The job rfx-close at closesAt (SYSTEM): reads the latest state and does nothing when the RFx is not due any more */
export const closeRfxCommand = defineCommand({
  name: 'rfx.close',
  capability: 'system.sourcing',
  input: CloseInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ closed: boolean; bidCount: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'the job closes an RFx at its time')
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    // a no-op is a refusal, never a success without an event (INV-EVT-02): not open any more, or not due yet
    if (!rfx || rfx.status !== 'OPEN' || !rfx.closesAt || ctx.now.getTime() < rfx.closesAt.getTime()) {
      return fail('INVALID_STATE_TRANSITION', 'the RFx is not due to close', { reason: rfx?.status === 'OPEN' ? 'NOT_DUE' : 'NOT_OPEN' })
    }
    const closed = await closeNow(tx, ctx, rfx, false)
    return { ok: true, result: { closed: true, bidCount: closed.bidCount }, events: closed.events, notifications: closed.notifications, outbox: closed.outbox }
  },
})

// ---------- rfx.cancel · rfx.reopen (BR-RFX-16 · FR-SRC-201 AC6) ----------

const CancelInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), reason: REASON })

async function cancelInTx(tx: TenantTx, ctx: Ctx, rfx: Rfx, reason: string): Promise<Fail | (Effects & { readonly requestLineIds: string[] })> {
  // an award not yet decided is cancelled first (award.cancel · AWARD_OPEN)
  const award = await tx.awardDecision.findFirst({ where: { rfxEventId: rfx.id, status: { in: ['DRAFT', 'RETURNED', 'PENDING_APPROVAL'] } }, select: { id: true, number: true } })
  if (award) return fail('INVALID_STATE_TRANSITION', 'cancel the open award first', { from: rfx.status, command: 'rfx.cancel', reason: 'AWARD_OPEN', award: award.number ?? award.id })
  const reasonCommentId = await comment(tx, ctx, rfx.id, reason)
  const requestLineIds = await releaseSources(tx, { rfxEventId: rfx.id })
  const out = effects()
  // the suppliers who were told hear of it; a draft told no one (BR-NOTI-11)
  if (rfx.status !== 'DRAFT') absorb(out, await mailInvites(tx, ctx, mailFacts(rfx), ACTIVE_INVITE, SOURCING_SUPPLIER_TEMPLATES.cancelled, 'cancelled', {}))
  const removing = await tx.rfxInvite.findMany({ where: { rfxEventId: rfx.id, status: { in: ['INVITED', 'VIEWED', 'DECLINED', 'BID_SUBMITTED', 'WITHDRAWN'] } }, select: { id: true, linkId: true } })
  if (removing.length) {
    await tx.rfxInvite.updateMany({ where: { id: { in: removing.map((i) => i.id) } }, data: { status: 'REMOVED', removedAt: ctx.now, removeReason: reason, version: { increment: 1 } } })
    const links = removing.flatMap((i) => (i.linkId ? [i.linkId] : []))
    if (links.length) await tx.portalInviteLink.updateMany({ where: { id: { in: links }, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
  }
  await tx.rfxEvent.update({ where: { id: rfx.id }, data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: ctx.now, version: { increment: 1 } } })
  out.events.unshift(
    { type: 'rfx.cancelled', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { reasonCommentId, requestLineIds } },
    ...removing.map((i): EventDraft => ({ type: 'rfx_invite.removed', aggregateType: 'RfxInvite', aggregateId: i.id, data: { rfxEventId: rfx.id, reasonCommentId } })),
  )
  return { ...out, requestLineIds }
}

export const cancelRfxCommand = defineCommand({
  name: 'rfx.cancel',
  capability: 'sourcing.manage',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; requestLineIds: string[] }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.cancel', input.expectedVersion)
    if (isFail(next)) return next
    const done = await cancelInTx(tx, ctx, rfx, input.reason)
    if (isFail(done)) return done
    return { ok: true, result: { rfxEventId: rfx.id, requestLineIds: done.requestLineIds }, events: done.events, notifications: done.notifications, outbox: done.outbox }
  },
})

const ReopenInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), reason: REASON })

/** A closed RFx no one bid on starts again as a new DRAFT with its lines and scorecard; the old one is cancelled */
export const reopenRfxCommand = defineCommand({
  name: 'rfx.reopen',
  capability: 'sourcing.manage',
  input: ReopenInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; fromRfxEventId: string }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    if (rfx.status !== 'CLOSED') return fail('INVALID_STATE_TRANSITION', `rfx.reopen is not allowed from ${rfx.status}`, { from: rfx.status, command: 'rfx.reopen' })
    if (rfx.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the RFx changed meanwhile', { expectedVersion: input.expectedVersion, version: rfx.version })
    if (await tx.bid.count({ where: { rfxEventId: rfx.id, status: 'SUBMITTED' } })) return reasonOf('rfxEventId', 'HAS_BIDS', 'an RFx with bids is evaluated, not reopened')
    const lines = await tx.rfxLine.findMany({ where: { rfxEventId: rfx.id }, orderBy: { lineNo: 'asc' }, include: { sources: { where: { active: true } } } })
    const card = rfx.scorecardId ? await tx.scorecard.findUnique({ where: { id: rfx.scorecardId }, include: { criteria: true, evaluators: true } }) : null
    const cancelled = await cancelInTx(tx, ctx, rfx, input.reason)
    if (isFail(cancelled)) return cancelled
    const { id: _id, number: _n, status: _s, openedById: _o, openedAt: _oa, closesAt: _c, questionCutoffAt: _q, closedAt: _ca, scorecardId: _sc, awardDecisionId: _a, cancelReason: _cr, cancelledAt: _cat, version: _v, createdAt: _cr2, updatedAt: _u, revisionNo: _r, ...copy } = rfx
    // sealed as the organization's setting: prices seen early again need their own reason (BR-RFX-06)
    const fresh = await tx.rfxEvent.create({ data: { ...copy, sealed: (await settingsOf(tx, ctx)).sealedBids, createdById: memberOf(ctx)!, sourceDepartmentIds: rfx.sourceDepartmentIds }, select: { id: true } })
    for (const l of lines) {
      const { id: _lid, rfxEventId: _e, createdAt: _lc, updatedAt: _lu, sources, ...lineCopy } = l
      const row = await tx.rfxLine.create({ data: { ...lineCopy, rfxEventId: fresh.id }, select: { id: true } })
      for (const s of sources) {
        await tx.rfxLineSource.create({ data: { organizationId: ctx.organizationId, rfxLineId: row.id, requestLineId: s.requestLineId, quantity: s.quantity } })
        await tx.requestLine.update({ where: { id: s.requestLineId }, data: { rfxEventId: fresh.id } })
      }
    }
    if (card) {
      const sc = await tx.scorecard.create({ data: { organizationId: ctx.organizationId, rfxEventId: fresh.id, minEvaluators: card.minEvaluators, priceCriterionCode: card.priceCriterionCode }, select: { id: true } })
      await tx.scoreCriterion.createMany({ data: card.criteria.map((c) => ({ organizationId: ctx.organizationId, scorecardId: sc.id, code: c.code, nameTh: c.nameTh, nameEn: c.nameEn, weightBp: c.weightBp, kind: c.kind, guidance: c.guidance, sortOrder: c.sortOrder })) })
      await tx.scorecardEvaluator.createMany({ data: card.evaluators.filter((e) => e.status !== 'RECUSED').map((e) => ({ organizationId: ctx.organizationId, scorecardId: sc.id, memberId: e.memberId, assignedAt: ctx.now })) })
      await tx.rfxEvent.update({ where: { id: fresh.id }, data: { scorecardId: sc.id } })
    }
    return {
      ok: true,
      result: { rfxEventId: fresh.id, fromRfxEventId: rfx.id },
      events: [...cancelled.events, { type: 'rfx.reopened', aggregateType: 'RfxEvent', aggregateId: fresh.id, data: { fromRfxEventId: rfx.id, requestLineIds: cancelled.requestLineIds } }],
      notifications: cancelled.notifications,
      outbox: cancelled.outbox,
    }
  },
})

// ---------- S7's application approved: its invites move to the new supplier ----------

/** supplier_application.approved → every invite of the application names the supplier now (ADR-203 · rfx_invite.supplier_linked) */
export const linkApplicationInvitesCommand = defineCommand({
  name: 'rfx.linkApplicationInvites',
  capability: 'system.sourcing',
  input: z.strictObject({ applicationId: z.uuid(), supplierId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ linked: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'the job links the invites of an approved application')
    const invites = await tx.rfxInvite.findMany({ where: { applicationId: input.applicationId, supplierId: null }, select: { id: true, rfxEventId: true } })
    const events: EventDraft[] = []
    for (const i of invites) {
      // an invite of the same supplier on the same RFx already (invited both ways) keeps the older one
      if (await tx.rfxInvite.findFirst({ where: { rfxEventId: i.rfxEventId, supplierId: input.supplierId }, select: { id: true } })) continue
      await tx.rfxInvite.update({ where: { id: i.id }, data: { supplierId: input.supplierId, version: { increment: 1 } } })
      events.push({ type: 'rfx_invite.supplier_linked', aggregateType: 'RfxInvite', aggregateId: i.id, data: { rfxEventId: i.rfxEventId, applicationId: input.applicationId, supplierId: input.supplierId } })
    }
    if (events.length === 0) return fail('INVALID_STATE_TRANSITION', 'no invite of the application to link', { reason: 'NOTHING_TO_LINK' })
    return { ok: true, result: { linked: events.length }, events }
  },
})

// ---------- callers ----------

export const createRfx = (ctx: Ctx, input: z.input<typeof CreateInput>, opts: RunOptions) => runCommand(ctx, createRfxCommand, input, opts)
export const updateRfx = (ctx: Ctx, input: z.input<typeof UpdateInput>, opts: RunOptions) => runCommand(ctx, updateRfxCommand, input, opts)
export const addRfxLines = (ctx: Ctx, input: z.input<typeof AddLinesInput>, opts: RunOptions) => runCommand(ctx, addRfxLinesCommand, input, opts)
export const removeRfxLine = (ctx: Ctx, input: z.input<typeof RemoveLineInput>, opts: RunOptions) => runCommand(ctx, removeRfxLineCommand, input, opts)
export const setScorecard = (ctx: Ctx, input: z.input<typeof ScorecardInput>, opts: RunOptions) => runCommand(ctx, setScorecardCommand, input, opts)
export const inviteToRfx = (ctx: Ctx, input: z.input<typeof InviteInput>, opts: RunOptions) => runCommand(ctx, inviteToRfxCommand, input, opts)
export const uninviteFromRfx = (ctx: Ctx, input: z.input<typeof UninviteInput>, opts: RunOptions) => runCommand(ctx, uninviteFromRfxCommand, input, opts)
export const openRfx = (ctx: Ctx, input: z.input<typeof OpenInput>, opts: RunOptions) => runCommand(ctx, openRfxCommand, input, opts)
export const amendRfx = (ctx: Ctx, input: z.input<typeof AmendInput>, opts: RunOptions) => runCommand(ctx, amendRfxCommand, input, opts)
export const extendRfx = (ctx: Ctx, input: z.input<typeof ExtendInput>, opts: RunOptions) => runCommand(ctx, extendRfxCommand, input, opts)
export const closeRfxEarly = (ctx: Ctx, input: z.input<typeof CloseEarlyInput>, opts: RunOptions) => runCommand(ctx, closeRfxEarlyCommand, input, opts)
export const closeRfx = (ctx: Ctx, input: z.input<typeof CloseInput>, opts: RunOptions) => runCommand(ctx, closeRfxCommand, input, opts)
export const cancelRfx = (ctx: Ctx, input: z.input<typeof CancelInput>, opts: RunOptions) => runCommand(ctx, cancelRfxCommand, input, opts)
export const reopenRfx = (ctx: Ctx, input: z.input<typeof ReopenInput>, opts: RunOptions) => runCommand(ctx, reopenRfxCommand, input, opts)
export const linkApplicationInvites = (ctx: Ctx, input: z.input<typeof linkApplicationInvitesCommand.input>, opts: RunOptions) => runCommand(ctx, linkApplicationInvitesCommand, input, opts)

// ---------- for the jobs (SYSTEM) ----------

/** The job rfx-close at closesAt: closes the RFx if it is still OPEN and due (§4.3 key `<functionId>:<stepId>:<subjectId>`) */
export async function closeRfxAt(organizationId: string, rfxEventId: string, closesAt: string, now: Date): Promise<{ readonly closed: boolean; readonly reason?: string }> {
  const done = await runCommand(systemCtx(organizationId, now, 'rfx-close'), closeRfxCommand, { rfxEventId }, { idempotencyKey: `rfx-close:close:${rfxEventId}:${closesAt}` })
  return done.ok ? { closed: done.data.closed } : { closed: false, reason: String((done.error.details as { reason?: unknown } | undefined)?.reason ?? done.error.code) }
}

/** The job rfx-invite-link after supplier_application.approved */
export async function linkInvitesOfApplication(organizationId: string, applicationId: string, supplierId: string, now: Date): Promise<number> {
  const done = await runCommand(systemCtx(organizationId, now, 'rfx-invite-link'), linkApplicationInvitesCommand, { applicationId, supplierId }, { idempotencyKey: `rfx-invite-link:link:${applicationId}` })
  return done.ok ? done.data.linked : 0
}

const RemindInput = z.strictObject({ rfxEventId: z.uuid(), closesAt: z.iso.datetime({ offset: true }) })

/** The job rfx-reminder: rfx.reminder once per invite and revision to those who neither bid nor declined (BR-NOTI-11) */
export const remindRfxCommand = defineCommand({
  name: 'rfx.remind',
  capability: 'system.sourcing',
  input: RemindInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ reminded: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'the job reminds the suppliers')
    const rfx = await tx.rfxEvent.findUnique({ where: { id: input.rfxEventId } })
    // the close moved since (a later run reminds for it), or the RFx is not open any more
    if (!rfx || rfx.status !== 'OPEN' || rfx.closesAt?.toISOString() !== new Date(input.closesAt).toISOString() || ctx.now.getTime() >= rfx.closesAt.getTime()) {
      return fail('INVALID_STATE_TRANSITION', 'the RFx is not open at this close any more', { reason: 'NOT_DUE' })
    }
    const waiting = await tx.rfxInvite.count({ where: { rfxEventId: rfx.id, status: { in: ['INVITED', 'VIEWED', 'WITHDRAWN'] } } })
    if (waiting === 0) return fail('INVALID_STATE_TRANSITION', 'every invite has answered', { reason: 'NOTHING_TO_REMIND' })
    const out = await mailInvites(tx, ctx, mailFacts(rfx), ['INVITED', 'VIEWED', 'WITHDRAWN'], SOURCING_SUPPLIER_TEMPLATES.reminder, `r${rfx.revisionNo}`, {})
    out.events.unshift({ type: 'rfx.reminded', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { invites: waiting, revisionNo: rfx.revisionNo, closesAt: rfx.closesAt!.toISOString() } })
    return { ok: true, result: { reminded: waiting }, ...out }
  },
})

export async function remindRfxAt(organizationId: string, rfxEventId: string, closesAt: string, now: Date, runOf = closesAt): Promise<number> {
  // one key per run (the event that started it), so an amendment that keeps the close reminds for its new revision; the
  // e-mail itself goes once per invite and revision (dedupeKey of mailInvites)
  const done = await runCommand(systemCtx(organizationId, now, 'rfx-reminder'), remindRfxCommand, { rfxEventId, closesAt }, { idempotencyKey: `rfx-reminder:remind:${rfxEventId}:${runOf}` })
  return done.ok ? done.data.reminded : 0
}

/** When rfx-reminder writes: one business day (540 business minutes) before the close, on the organization's calendar */
export const REMINDER_BUSINESS_MINUTES = 540

export async function rfxReminderAt(organizationId: string, closesAt: string): Promise<string> {
  const calendar = await forTenant(organizationId).$transaction((tx) => loadBusinessCalendar(tx, organizationId))
  return subtractBusinessMinutes(new Date(closesAt), REMINDER_BUSINESS_MINUTES, calendar).toISOString()
}

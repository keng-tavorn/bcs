import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import { agreementDay, checkAgreement } from '@/core/pricing'
import type { AppError } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { EventDraft } from '@/server/events/append'
import { CATALOG_ITEM_FIELDS } from '@/server/events/schemas/catalog'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// The catalogue and its agreed prices (S6-10 · FR-INT-102 AC3 · BR-PRC-06 · OQ-114): PROCUREMENT adds and edits items
// and sets agreed prices itself (catalog.manage), with an event every time. An agreed price is before VAT, for a period
// [validFrom, validTo) of Thai calendar days that never overlaps another of the same item and supplier. Ending one makes
// today its last day; one that has not started yet cannot be ended (it never applied). Nothing is deleted.

type FailCode = AppError['code']
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const Code = z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/)
const Baht = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
const Day = z.iso.date()
const ItemFields = {
  nameTh: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).nullable(),
  uom: z.string().trim().min(1).max(30),
  categoryCode: z.string().trim().min(1).max(50),
  isService: z.boolean(),
  accountCode: z.string().trim().max(20).nullable(),
  whtIncomeType: z.string().trim().max(20).nullable(),
  /** Before VAT, baht text */
  refUnitPrice: Baht,
}
const DAY_MS = 24 * 60 * 60 * 1000
const dateOf = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00Z`)
const dayOf = (d: Date) => d.toISOString().slice(0, 10)

async function allowed(tx: Parameters<typeof authorize>[0], ctx: Ctx) {
  return authorize(tx, ctx, 'catalog.manage')
}

// ---------- items ----------

const CreateItemInput = z.strictObject({ code: Code, ...ItemFields, nameEn: ItemFields.nameEn.optional(), accountCode: ItemFields.accountCode.optional(), whtIncomeType: ItemFields.whtIncomeType.optional() })

export const createCatalogItemCommand = defineCommand({
  name: 'catalogItem.create',
  capability: 'catalog.manage',
  input: CreateItemInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ catalogItemId: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    if (await tx.catalogItem.findFirst({ where: { code: input.code }, select: { id: true } })) return fail('VALIDATION_FAILED', 'the code is in use', { field: 'code', reason: 'CODE_EXISTS' })
    const row = await tx.catalogItem.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        nameTh: input.nameTh,
        nameEn: input.nameEn || null,
        uom: input.uom,
        categoryCode: input.categoryCode,
        isService: input.isService,
        accountCode: input.accountCode || null,
        whtIncomeType: input.whtIncomeType || null,
        refUnitPriceSatang: amountToSatang(input.refUnitPrice),
      },
      select: { id: true },
    })
    return { ok: true, result: { catalogItemId: row.id }, events: [{ type: 'catalog_item.created', aggregateType: 'CatalogItem', aggregateId: row.id, data: { code: input.code, via: 'ADMIN' } }] }
  },
})

export function createCatalogItem(ctx: Ctx, input: z.input<typeof CreateItemInput>, options: RunOptions) {
  return runCommand(ctx, createCatalogItemCommand, input, options)
}

const UpdateItemInput = z.strictObject({
  catalogItemId: z.uuid(),
  nameTh: ItemFields.nameTh.optional(),
  nameEn: ItemFields.nameEn.optional(),
  uom: ItemFields.uom.optional(),
  categoryCode: ItemFields.categoryCode.optional(),
  isService: ItemFields.isService.optional(),
  accountCode: ItemFields.accountCode.optional(),
  whtIncomeType: ItemFields.whtIncomeType.optional(),
  refUnitPrice: ItemFields.refUnitPrice.optional(),
  /** false takes the item out of the catalogue's search and the request form; requests that have it keep it */
  active: z.boolean().optional(),
})

export const updateCatalogItemCommand = defineCommand({
  name: 'catalogItem.update',
  capability: 'catalog.manage',
  input: UpdateItemInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ catalogItemId: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    const [locked] = await lockRowsForUpdate(tx, 'CatalogItem', ctx.organizationId, [input.catalogItemId])
    if (!locked) return fail('NOT_FOUND', 'catalogue item not found')
    const item = await tx.catalogItem.findUniqueOrThrow({ where: { id: input.catalogItemId } })
    const next = {
      nameTh: input.nameTh,
      nameEn: input.nameEn === undefined ? undefined : input.nameEn || null,
      uom: input.uom,
      categoryCode: input.categoryCode,
      isService: input.isService,
      accountCode: input.accountCode === undefined ? undefined : input.accountCode || null,
      whtIncomeType: input.whtIncomeType === undefined ? undefined : input.whtIncomeType || null,
      refUnitPriceSatang: input.refUnitPrice === undefined ? undefined : amountToSatang(input.refUnitPrice),
      active: input.active,
    }
    const column = (f: (typeof CATALOG_ITEM_FIELDS)[number]) => (f === 'refUnitPrice' ? 'refUnitPriceSatang' : f)
    const changed = CATALOG_ITEM_FIELDS.filter((f) => next[column(f)] !== undefined && next[column(f)] !== item[column(f)])
    if (changed.length === 0) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NO_CHANGE' })
    await tx.catalogItem.update({ where: { id: item.id }, data: Object.fromEntries(changed.map((f) => [column(f), next[column(f)]])) })
    return { ok: true, result: { catalogItemId: item.id }, events: [{ type: 'catalog_item.updated', aggregateType: 'CatalogItem', aggregateId: item.id, data: { code: item.code, fields: changed } }] }
  },
})

export function updateCatalogItem(ctx: Ctx, input: z.input<typeof UpdateItemInput>, options: RunOptions) {
  return runCommand(ctx, updateCatalogItemCommand, input, options)
}

// ---------- agreed prices ----------

const CreateAgreementInput = z.strictObject({
  catalogItemId: z.uuid(),
  supplierId: z.uuid(),
  /** Before VAT, baht text, above zero */
  unitPrice: Baht.refine((v) => /[1-9]/.test(v), 'the agreed price must be above zero'),
  validFrom: Day,
  /** Not included */
  validTo: Day,
  /** The contract or quotation it comes from */
  sourceRef: z.string().trim().max(200).optional(),
})

export const createPriceAgreementCommand = defineCommand({
  name: 'priceAgreement.create',
  capability: 'catalog.manage',
  input: CreateAgreementInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ priceAgreementId: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    // One agreement of an item at a time, so two saved together cannot both pass the overlap check
    const [locked] = await lockRowsForUpdate(tx, 'CatalogItem', ctx.organizationId, [input.catalogItemId])
    if (!locked) return fail('NOT_FOUND', 'catalogue item not found')
    if (!(await tx.supplier.count({ where: { id: input.supplierId, status: 'ACTIVE' } }))) return fail('VALIDATION_FAILED', 'unknown or inactive supplier', { field: 'supplierId', reason: 'UNKNOWN' })
    if (input.validTo <= agreementDay(ctx.now)) return fail('VALIDATION_FAILED', 'the period is over already', { field: 'validTo', reason: 'PERIOD_OVER' })
    const existing = await tx.priceAgreement.findMany({ where: { catalogItemId: input.catalogItemId, supplierId: input.supplierId }, select: { catalogItemId: true, supplierId: true, validFrom: true, validTo: true } })
    const checked = checkAgreement(
      existing.map((e) => ({ ...e, validFrom: dayOf(e.validFrom), validTo: dayOf(e.validTo) })),
      { catalogItemId: input.catalogItemId, supplierId: input.supplierId, validFrom: input.validFrom, validTo: input.validTo },
    )
    if (!checked.ok) return { ok: false, error: checked.error }
    const unitPriceSatang = amountToSatang(input.unitPrice)
    const row = await tx.priceAgreement.create({
      data: {
        organizationId: ctx.organizationId,
        catalogItemId: input.catalogItemId,
        supplierId: input.supplierId,
        unitPriceSatang,
        validFrom: dateOf(input.validFrom),
        validTo: dateOf(input.validTo),
        sourceRef: input.sourceRef || null,
        createdById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
      },
      select: { id: true },
    })
    const event: EventDraft = {
      type: 'price_agreement.created',
      aggregateType: 'PriceAgreement',
      aggregateId: row.id,
      data: { catalogItemId: input.catalogItemId, supplierId: input.supplierId, unitPriceSatang: unitPriceSatang.toString(), validFrom: input.validFrom, validTo: input.validTo, via: 'ADMIN' },
    }
    return { ok: true, result: { priceAgreementId: row.id }, events: [event] }
  },
})

export function createPriceAgreement(ctx: Ctx, input: z.input<typeof CreateAgreementInput>, options: RunOptions) {
  return runCommand(ctx, createPriceAgreementCommand, input, options)
}

const EndAgreementInput = z.strictObject({ priceAgreementId: z.uuid() })

export const endPriceAgreementCommand = defineCommand({
  name: 'priceAgreement.end',
  capability: 'catalog.manage',
  input: EndAgreementInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ priceAgreementId: string; validTo: string }>> {
    const ok = await allowed(tx, ctx)
    if (!ok.ok) return { ok: false, error: ok.error }
    const agreement = await tx.priceAgreement.findFirst({ where: { id: input.priceAgreementId } })
    if (!agreement) return fail('NOT_FOUND', 'agreed price not found')
    await lockRowsForUpdate(tx, 'CatalogItem', ctx.organizationId, [agreement.catalogItemId])
    const today = agreementDay(ctx.now)
    // Today is its last day: from tomorrow the item has no agreed price with this supplier
    const validTo = dayOf(new Date(dateOf(today).getTime() + DAY_MS))
    if (dayOf(agreement.validFrom) > today) return fail('INVALID_STATE_TRANSITION', 'the agreed price has not started', { reason: 'AGREEMENT_NOT_STARTED' })
    if (dayOf(agreement.validTo) <= validTo) return fail('INVALID_STATE_TRANSITION', 'the agreed price ends by tomorrow already', { reason: 'AGREEMENT_OVER' })
    await tx.priceAgreement.update({ where: { id: agreement.id }, data: { validTo: dateOf(validTo), endedAt: ctx.now } })
    return {
      ok: true,
      result: { priceAgreementId: agreement.id, validTo },
      events: [{ type: 'price_agreement.ended', aggregateType: 'PriceAgreement', aggregateId: agreement.id, data: { catalogItemId: agreement.catalogItemId, supplierId: agreement.supplierId, validTo } }],
    }
  },
})

export function endPriceAgreement(ctx: Ctx, input: z.input<typeof EndAgreementInput>, options: RunOptions) {
  return runCommand(ctx, endPriceAgreementCommand, input, options)
}

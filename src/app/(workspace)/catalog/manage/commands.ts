import { z } from 'zod'
import type { Ctx } from '@/server/context'
import { createCatalogItem, createPriceAgreement, endPriceAgreement, updateCatalogItem } from '@/server/services/catalog'
import { plainBaht, validDay, validToOf } from '@/ui/catalog/model'
import { toCatalogFailure, type CatalogFailure, type CatalogOutcome } from '@/ui/catalog/outcome'

// The commands behind the buttons of /catalog/manage (S6-10 · FR-INT-102 AC3), apart from the session and the page
// cache so tests run them with a context. Server actions are public endpoints (BR-AUTH-05): every argument is parsed
// before it is read, so a malformed call gets VALIDATION_FAILED naming its field and never a crash; then the service
// checks catalog.manage (PROCUREMENT) and every rule again. Money arrives as typed and goes on as plain baht text; an
// agreed price's period arrives as its first and last day (included) and goes on as [validFrom, validTo), validTo the
// day after the last.

const Key = z.uuid()
const invalid = (field: string): CatalogFailure => ({ ok: false, code: 'VALIDATION_FAILED', field })
const BAD_KEY = invalid('idempotencyKey')
const text = (max: number) => z.string().max(max)

const ItemFields = {
  nameTh: text(200),
  nameEn: text(200),
  uom: text(30),
  categoryCode: text(50),
  isService: z.boolean(),
  accountCode: text(20),
  whtIncomeType: text(20),
  refUnitPrice: text(40),
}
const NewItem = z.strictObject({ code: text(40), ...ItemFields })
const EditItem = z.strictObject({ catalogItemId: z.uuid(), active: z.boolean(), ...ItemFields })
const NewAgreement = z.strictObject({ catalogItemId: z.uuid(), supplierId: z.uuid(), unitPrice: text(40), validFrom: text(10), lastDay: text(10), sourceRef: text(200) })
const EndAgreement = z.strictObject({ priceAgreementId: z.uuid() })

function parseFailure(issues: readonly z.core.$ZodIssue[]): CatalogFailure {
  const first = issues[0]
  if (first?.code === 'unrecognized_keys') return invalid(first.keys[0] ?? '(input)')
  return invalid(typeof first?.path[0] === 'string' ? first.path[0] : '(input)')
}

const options = (idempotencyKey: string) => ({ idempotencyKey, sender: null })

/** "บันทึกรายการ": a new item of the catalogue; blank optional fields are left out */
export async function createItemFromScreen(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<CatalogOutcome<{ catalogItemId: string }>> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = NewItem.safeParse(input)
  if (!parsed.success) return parseFailure(parsed.error.issues)
  const v = parsed.data
  const result = await createCatalogItem(
    ctx,
    {
      code: v.code.trim(),
      nameTh: v.nameTh,
      uom: v.uom,
      categoryCode: v.categoryCode,
      isService: v.isService,
      refUnitPrice: plainBaht(v.refUnitPrice),
      ...(v.nameEn.trim() ? { nameEn: v.nameEn } : {}),
      ...(v.accountCode.trim() ? { accountCode: v.accountCode } : {}),
      ...(v.whtIncomeType.trim() ? { whtIncomeType: v.whtIncomeType } : {}),
    },
    options(String(idempotencyKey)),
  )
  return result.ok ? { ok: true, catalogItemId: result.data.catalogItemId } : toCatalogFailure(result.error)
}

/** "บันทึกการแก้ไข": every field of the form, blank optional ones cleared; the service changes those that differ (NO_CHANGE when none) */
export async function updateItemFromScreen(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<CatalogOutcome<{ catalogItemId: string }>> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = EditItem.safeParse(input)
  if (!parsed.success) return parseFailure(parsed.error.issues)
  const v = parsed.data
  const result = await updateCatalogItem(
    ctx,
    {
      catalogItemId: v.catalogItemId,
      nameTh: v.nameTh,
      nameEn: v.nameEn.trim() ? v.nameEn : null,
      uom: v.uom,
      categoryCode: v.categoryCode,
      isService: v.isService,
      accountCode: v.accountCode.trim() ? v.accountCode : null,
      whtIncomeType: v.whtIncomeType.trim() ? v.whtIncomeType : null,
      refUnitPrice: plainBaht(v.refUnitPrice),
      active: v.active,
    },
    options(String(idempotencyKey)),
  )
  return result.ok ? { ok: true, catalogItemId: result.data.catalogItemId } : toCatalogFailure(result.error)
}

/** "บันทึกราคาตกลง": the last day becomes the period's end (the day after it, not included) */
export async function createAgreementFromScreen(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<CatalogOutcome<{ priceAgreementId: string }>> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = NewAgreement.safeParse(input)
  if (!parsed.success) return parseFailure(parsed.error.issues)
  const v = parsed.data
  if (!validDay(v.validFrom)) return invalid('validFrom')
  if (!validDay(v.lastDay)) return invalid('lastDay')
  const result = await createPriceAgreement(
    ctx,
    {
      catalogItemId: v.catalogItemId,
      supplierId: v.supplierId,
      unitPrice: plainBaht(v.unitPrice),
      validFrom: v.validFrom,
      validTo: validToOf(v.lastDay),
      ...(v.sourceRef.trim() ? { sourceRef: v.sourceRef } : {}),
    },
    options(String(idempotencyKey)),
  )
  return result.ok ? { ok: true, priceAgreementId: result.data.priceAgreementId } : toCatalogFailure(result.error)
}

/** "สิ้นสุดราคาตกลงวันนี้": today becomes the agreed price's last day */
export async function endAgreementFromScreen(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<CatalogOutcome<{ validTo: string }>> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = EndAgreement.safeParse(input)
  if (!parsed.success) return parseFailure(parsed.error.issues)
  const result = await endPriceAgreement(ctx, parsed.data, options(String(idempotencyKey)))
  return result.ok ? { ok: true, validTo: result.data.validTo } : toCatalogFailure(result.error)
}

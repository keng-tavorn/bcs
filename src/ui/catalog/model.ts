import { satangToAmount } from '@/core/money/dto'
import { MS_PER_DAY } from '@/lib/constants'
import type { AgreementView, CatalogItemView, ItemFormValues, NewAgreementInput } from './types'

// The rules the catalogue screens run as PROCUREMENT types (S6-10 · FR-INT-102 AC3): the item form's checks — the
// same patterns the service checks again — the period of an agreed price picked as its first and last day (the service
// keeps [validFrom, validTo), validTo the first day it no longer applies), and where each agreed price stands today.
// Pure: days are YYYY-MM-DD text, money baht text.

/** The item code the service takes: upper-case letters, digits, - and _ (src/server/services/catalog/index.ts) */
export const ITEM_CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/
const BAHT = /^\d{1,13}(\.\d{1,2})?$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** "1,250.50 " → "1250.50": separators and spaces are only for reading */
export const plainBaht = (text: string): string => text.replace(/[\s,]/g, '')

export const validBaht = (text: string): boolean => BAHT.test(plainBaht(text))

export const validDay = (text: string): boolean => DAY.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`))

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

/** The period's end the service keeps (not included) from the last day the price applies (included) */
export const validToOf = (lastDay: string): string => addDays(lastDay, 1)

/** The last day a price applies (included) from the period's end (not included) */
export const lastDayOf = (validTo: string): string => addDays(validTo, -1)

/** Where an agreed price stands on `today`: in effect, in effect for the last time today, or still to come */
export type AgreementState = 'IN_EFFECT' | 'LAST_DAY' | 'UPCOMING'

export function agreementState(a: Pick<AgreementView, 'validFrom' | 'validTo'>, today: string): AgreementState {
  if (a.validFrom > today) return 'UPCOMING'
  return lastDayOf(a.validTo) <= today ? 'LAST_DAY' : 'IN_EFFECT'
}

/** "สิ้นสุดราคาตกลง" makes today its last day: only for a price in effect that would still apply after today */
export const canEndAgreement = (a: Pick<AgreementView, 'validFrom' | 'validTo'>, today: string): boolean => agreementState(a, today) === 'IN_EFFECT'

/** The item form's values for a new item, or for editing one */
export function itemFormValues(item: CatalogItemView | null): ItemFormValues {
  if (!item) return { code: '', nameTh: '', nameEn: '', uom: '', categoryCode: '', isService: false, accountCode: '', whtIncomeType: '', refUnitPrice: '', active: true }
  return {
    code: item.code,
    nameTh: item.nameTh,
    nameEn: item.nameEn ?? '',
    uom: item.uom,
    categoryCode: item.categoryCode,
    isService: item.isService,
    accountCode: item.accountCode ?? '',
    whtIncomeType: item.whtIncomeType ?? '',
    refUnitPrice: satangToAmount(BigInt(item.refUnitPriceSatang)),
    active: item.active,
  }
}

export type ItemField = 'code' | 'nameTh' | 'uom' | 'categoryCode' | 'refUnitPrice'
export type ItemFieldError = 'CODE' | 'NAME' | 'UOM' | 'CATEGORY' | 'PRICE'

/** What the item form can already tell is wrong (the service checks every value again) */
export function itemFormErrors(v: ItemFormValues, isNew: boolean): Partial<Record<ItemField, ItemFieldError>> {
  const errors: Partial<Record<ItemField, ItemFieldError>> = {}
  if (isNew && !ITEM_CODE.test(v.code.trim())) errors.code = 'CODE'
  if (!v.nameTh.trim()) errors.nameTh = 'NAME'
  if (!v.uom.trim()) errors.uom = 'UOM'
  if (!v.categoryCode.trim()) errors.categoryCode = 'CATEGORY'
  if (!validBaht(v.refUnitPrice)) errors.refUnitPrice = 'PRICE'
  return errors
}

export type AgreementField = 'supplierId' | 'unitPrice' | 'validFrom' | 'lastDay'
export type AgreementFieldError = 'SUPPLIER' | 'PRICE' | 'PRICE_ZERO' | 'DATE' | 'INVALID_PERIOD' | 'PERIOD_OVER'

/** What the agreed-price form can already tell is wrong: a supplier, a price above zero, a first and a last day in order, not over */
export function agreementFormErrors(v: Omit<NewAgreementInput, 'catalogItemId'>, today: string): Partial<Record<AgreementField, AgreementFieldError>> {
  const errors: Partial<Record<AgreementField, AgreementFieldError>> = {}
  if (!v.supplierId) errors.supplierId = 'SUPPLIER'
  if (!validBaht(v.unitPrice)) errors.unitPrice = 'PRICE'
  else if (!/[1-9]/.test(plainBaht(v.unitPrice))) errors.unitPrice = 'PRICE_ZERO'
  if (!validDay(v.validFrom)) errors.validFrom = 'DATE'
  if (!validDay(v.lastDay)) errors.lastDay = 'DATE'
  else if (validDay(v.validFrom) && v.lastDay < v.validFrom) errors.lastDay = 'INVALID_PERIOD'
  else if (v.lastDay < today) errors.lastDay = 'PERIOD_OVER'
  return errors
}

import { z } from 'zod'
import { defineEvents } from '../registry'

// The catalogue and its agreed prices (S6-10 · FR-INT-102 AC3 · BR-PRC-06): every change PROCUREMENT makes, and the
// seed's. Money as satang text; dates as the Thai calendar days of the period [validFrom, validTo).

const via = z.enum(['SEED', 'ADMIN'])
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const satang = z.string().regex(/^\d+$/)
export const CATALOG_ITEM_FIELDS = ['nameTh', 'nameEn', 'uom', 'categoryCode', 'isService', 'accountCode', 'whtIncomeType', 'refUnitPrice', 'active'] as const

defineEvents('CatalogItem', {
  'catalog_item.created': { schema: z.object({ code: z.string().min(1), via }) },
  'catalog_item.updated': { schema: z.object({ code: z.string().min(1), fields: z.array(z.enum(CATALOG_ITEM_FIELDS)).min(1) }) },
})

defineEvents('PriceAgreement', {
  'price_agreement.created': {
    schema: z.object({ catalogItemId: z.uuid(), supplierId: z.uuid(), unitPriceSatang: satang, validFrom: day, validTo: day, via }),
  },
  // Ended early: the period now stops at validTo (the day it no longer applies)
  'price_agreement.ended': { schema: z.object({ catalogItemId: z.uuid(), supplierId: z.uuid(), validTo: day }) },
})

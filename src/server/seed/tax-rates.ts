import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { systemDb } from '@/server/db/system'

// TaxRate seed (spec §7.1, BR-VAT-01): the dated VAT rates of prisma/seed/tax-rates.yaml. The rate is data, never a
// number in code. Running again adds nothing: a row is matched by its code and first day.

export const TAX_RATES_PATH = path.resolve(import.meta.dirname, '../../../prisma/seed/tax-rates.yaml')

const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const TaxRatesFile = z.strictObject({
  rates: z
    .array(
      z.strictObject({
        code: z.string().regex(/^[A-Z_]+$/),
        rateBp: z.number().int().min(0),
        effectiveFrom: DateText,
        effectiveTo: DateText.nullable().optional(),
        note: z.string().min(1).optional(),
        sourceUrl: z.url().optional(),
      }),
    )
    .min(1),
})
export type TaxRateSeed = z.infer<typeof TaxRatesFile>['rates'][number]

export function loadTaxRates(file: string = TAX_RATES_PATH): TaxRateSeed[] {
  return TaxRatesFile.parse(parseYaml(readFileSync(file, 'utf8'))).rates
}

/** A calendar date stored in a DATE column: midnight UTC of that day carries exactly the day. */
const dateOnly = (text: string) => new Date(`${text}T00:00:00Z`)

/** Adds the rates that are missing; returns how many were added. The exclusion constraint refuses overlapping periods. */
export async function seedTaxRates(rates: readonly TaxRateSeed[] = loadTaxRates()): Promise<number> {
  let added = 0
  for (const rate of rates) {
    const existing = await systemDb.taxRate.findFirst({ where: { code: rate.code, effectiveFrom: dateOnly(rate.effectiveFrom) }, select: { id: true } })
    if (existing) continue
    await systemDb.taxRate.create({
      data: {
        code: rate.code,
        rateBp: rate.rateBp,
        effectiveFrom: dateOnly(rate.effectiveFrom),
        effectiveTo: rate.effectiveTo ? dateOnly(rate.effectiveTo) : null,
        ...(rate.note ? { note: rate.note } : {}),
        ...(rate.sourceUrl ? { sourceUrl: rate.sourceUrl } : {}),
      },
    })
    added++
  }
  return added
}

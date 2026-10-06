import { describe, expect, it } from 'vitest'
import { rateFor } from '@/core/vat'
import { prisma } from '@/server/db/client'
import { loadTaxRates, seedTaxRates } from '@/server/seed/tax-rates'
import { loadYaml } from '../golden/doa-fixtures'

// BR-VAT-01 (spec §7.1): the seeded VAT rates are the table of §7.1, the same periods as the vat-rate.yaml fixture, and
// a second seed run adds nothing. The rate always comes from these rows, never from code.

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

describe('[BR-VAT-01] db:seed loads the dated VAT rates of §7.1', () => {
  it('matches the golden fixture, adds nothing when run again, and the engine finds 700 bp for October 2026', async () => {
    await seedTaxRates()
    expect(await seedTaxRates()).toBe(0)
    const rows = await prisma.taxRate.findMany({ where: { code: 'VAT_STANDARD' }, orderBy: { effectiveFrom: 'asc' } })
    const seeded = rows.map((r) => ({ code: r.code, rateBp: r.rateBp, effectiveFrom: iso(r.effectiveFrom), effectiveTo: iso(r.effectiveTo) }))
    const fixture = loadYaml<{ fixture: { rates: Array<{ code: string; rateBp: number; effectiveFrom: string; effectiveTo: string }> } }>('vat-rate.yaml').fixture.rates
    expect(seeded).toEqual(fixture.map((r) => ({ code: r.code, rateBp: r.rateBp, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo })))
    expect(seeded).toEqual(loadTaxRates().map((r) => ({ code: r.code, rateBp: r.rateBp, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? null })))
    // No confirmation is pretended: a PLATFORM_ADMIN confirms before go-live
    expect(rows.every((r) => r.confirmedById === null && r.confirmedAt === null)).toBe(true)
    const snapshots = seeded.map((r) => ({ code: r.code, rateBp: r.rateBp, effectiveFrom: r.effectiveFrom!, effectiveTo: r.effectiveTo! }))
    expect(rateFor('2026-10-03', snapshots)).toEqual({ ok: true, rateBp: 700 })
    expect(rateFor('2027-10-01', snapshots)).toMatchObject({ ok: false, error: 'TAX_RATE_NOT_CONFIGURED' })
  })
})

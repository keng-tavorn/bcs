import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount, toMoneyDto } from '@/core/money/dto'
import { ManualClock, fixedClock, systemClock } from '@/lib/clock'
import { isUuidV7, newId } from '@/lib/ids'
import { stableStringify, toJsonSafe } from '@/lib/json'

describe('clock', () => {
  it('fixed clock always returns the same instant (as a fresh Date)', () => {
    const c = fixedClock('2026-10-05T03:00:00Z')
    const a = c.now()
    a.setUTCFullYear(2000)
    expect(c.now().toISOString()).toBe('2026-10-05T03:00:00.000Z')
  })
  it('manual clock moves only when told to', () => {
    const c = new ManualClock('2026-10-05T03:00:00Z')
    c.advance(90 * 60 * 1000)
    expect(c.now().toISOString()).toBe('2026-10-05T04:30:00.000Z')
    c.set('2026-11-01T00:00:00+07:00')
    expect(c.now().toISOString()).toBe('2026-10-31T17:00:00.000Z')
  })
  it('rejects invalid instants and system clock is real time', () => {
    expect(() => fixedClock('not-a-date')).toThrow(RangeError)
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000)
  })
})

describe('newId (ADR-028)', () => {
  it('creates UUID v7 values that sort by creation time', async () => {
    const first = newId()
    await new Promise((r) => setTimeout(r, 2))
    const second = newId()
    expect(isUuidV7(first) && isUuidV7(second)).toBe(true)
    expect([second, first].sort()).toEqual([first, second])
    expect(new Set(Array.from({ length: 1000 }, newId)).size).toBe(1000)
  })
})

describe('JSON safety for BigInt money', () => {
  it('converts BigInt and Date, drops undefined fields', () => {
    expect(toJsonSafe({ a: 12345n, b: new Date('2026-10-01T00:00:00Z'), c: undefined, d: [1n, undefined] })).toEqual({
      a: '12345',
      b: '2026-10-01T00:00:00.000Z',
      d: ['1', null],
    })
  })
  it('stableStringify is independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2n, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2n }, b: 1 }))
  })
})

describe('money DTO (spec §14.1)', () => {
  it('formats satang as an amount string', () => {
    expect(toMoneyDto(1234550n)).toEqual({ amount: '12345.50', currency: 'THB' })
    expect(satangToAmount(-440000n)).toBe('-4400.00')
    expect(satangToAmount(5n)).toBe('0.05')
  })
  it('parses amount strings strictly', () => {
    expect(amountToSatang('12345.5')).toBe(1234550n)
    expect(amountToSatang('-0.05')).toBe(-5n)
    for (const bad of ['1.234', '1,000.00', 'abc', '', '1e3']) expect(() => amountToSatang(bad)).toThrow(RangeError)
  })
  it('round-trips any satang amount, including above 2^53', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (s) => amountToSatang(satangToAmount(s)) === s),
      { numRuns: 1000 },
    )
  })
})

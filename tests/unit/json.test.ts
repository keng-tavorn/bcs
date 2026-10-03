import Decimal from 'decimal.js'
import fc from 'fast-check'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { stableStringify, toJsonSafe, type Jsonified, type JsonValue } from '@/lib/json'
import { Prisma } from '@/server/db/generated/client'

// toJsonSafe is what Event.data, Outbox payloads, CommandLog.result and every command result go through
// (spec §4.5, §14.1). It must give what JSON.stringify gives, plus BigInt as a decimal string.

describe('[FR-PLT-003/AC1] toJsonSafe keeps Decimal quantities readable in the audit trail (spec §6.1)', () => {
  it('writes decimal.js and Prisma.Decimal values as their decimal string, not their internal fields', () => {
    expect(toJsonSafe({ quantity: new Decimal('12.5') })).toEqual({ quantity: '12.5' })
    expect(toJsonSafe({ quantity: new Prisma.Decimal('3.25') })).toEqual({ quantity: '3.25' })
    expect(toJsonSafe([new Decimal('0.0001'), { q: new Decimal('-7') }])).toEqual(['0.0001', { q: '-7' }])
  })

  it('hashes the same quantity the same way however it was written', () => {
    expect(stableStringify({ q: new Decimal('12.5') })).toBe(stableStringify({ q: new Decimal('12.50') }))
  })

  it('uses toJSON() of any object and keeps converting what it returns', () => {
    class Money {
      constructor(readonly satang: bigint) {}
      toJSON() {
        return { satang: this.satang, at: new Date('2026-10-01T00:00:00Z') }
      }
    }
    expect(toJsonSafe({ price: new Money(1050n) })).toEqual({ price: { satang: '1050', at: '2026-10-01T00:00:00.000Z' } })
    const selfish = { a: 1, toJSON() {
      return this
    } }
    expect(toJsonSafe(selfish)).toEqual({ a: 1 })
  })

  it('matches JSON.stringify for values without BigInt', () => {
    const sparse: unknown[] = [1]
    sparse[2] = 3 // index 1 is a hole: JSON.stringify writes null
    const sample = {
      n: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      bad: new Date('not a date'),
      f: () => 1,
      s: Symbol('x'),
      u: undefined,
      arr: [undefined, () => 1, Symbol('y'), 2],
      d: new Decimal('1.10'),
      boxed: [Object(7), Object('seven'), Object(false)],
      sparse,
      gone: { toJSON: () => undefined },
      once: { toJSON: () => ({ inner: { toJSON: () => 'inner toJSON' }, toJSON: () => 'not called again' }) },
    }
    expect(toJsonSafe(sample)).toEqual(JSON.parse(JSON.stringify(sample)))
    expect(toJsonSafe(undefined)).toBeNull()
    expect(toJsonSafe(Object(12n))).toBe('12')
  })

  it('refuses a cyclic structure with a TypeError, as JSON.stringify does, but allows shared references', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = { back: cyclic }
    expect(() => toJsonSafe(cyclic)).toThrow(TypeError)
    const shared = { q: new Decimal('2') }
    expect(toJsonSafe({ x: shared, y: [shared, shared] })).toEqual({ x: { q: '2' }, y: [{ q: '2' }, { q: '2' }] })
  })

  it('keeps a "__proto__" key as plain data, like JSON.parse does', () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"x":1}') as Record<string, unknown>
    const safe = toJsonSafe(parsed) as Record<string, unknown>
    expect(Object.keys(safe)).toEqual(['__proto__', 'x'])
    expect(JSON.stringify(safe)).toBe('{"__proto__":{"admin":true},"x":1}')
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype)
  })

  it('round-trips through JSON unchanged for any JSON-like input with BigInt', () => {
    const value = fc.letrec((tie) => ({
      tree: fc.oneof({ depthSize: 'small' }, tie('leaf'), fc.array(tie('tree'), { maxLength: 3 }), fc.dictionary(fc.string(), tie('tree'), { maxKeys: 3 })),
      leaf: fc.oneof(fc.string(), fc.nat(), fc.boolean(), fc.constant(null), fc.bigInt()),
    })).tree
    fc.assert(
      fc.property(value, (v) => {
        const safe = toJsonSafe(v)
        expect(JSON.parse(JSON.stringify(safe))).toEqual(safe)
      }),
      { numRuns: 300 },
    )
  })
})

describe('[FR-PLT-012/AC1] Jsonified<T> is the type a command caller really receives', () => {
  it('maps bigint, Date and Decimal to string and keeps JSON-safe shapes as they are', () => {
    interface Dto {
      readonly netSatang: bigint
      readonly at: Date
      readonly quantity: Decimal
      readonly note?: string
      readonly lines: ReadonlyArray<{ readonly qty: Decimal; readonly due: Date | null }>
      readonly counts: Record<string, number>
    }
    expectTypeOf<Jsonified<Dto>>().toEqualTypeOf<{
      readonly netSatang: string
      readonly at: string
      readonly quantity: string
      readonly note?: string
      readonly lines: Array<{ readonly qty: string; readonly due: string | null }>
      readonly counts: Record<string, number>
    }>()
    expectTypeOf<Jsonified<{ memberId: string; ok: true; n: number | null }>>().toEqualTypeOf<{ memberId: string; ok: true; n: number | null }>()
    expectTypeOf<Jsonified<undefined>>().toEqualTypeOf<null>()
    expectTypeOf<Jsonified<unknown>>().toEqualTypeOf<JsonValue>()
  })
})

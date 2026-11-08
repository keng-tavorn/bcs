import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addDays, documentExpiry } from '@/core/supplier-docs'
import { normalizeSupplierName, verifyOtp } from '@/core/supplier-onboarding'

// S7-03 property tests (docs/sub-specs/S7.md "Checklist" S7-03): normalizing a name twice gives what normalizing it once
// gave (BR-SUP ข้อ 09) · every date a document gets has expiresOn ≥ issuedOn (BR-SDOC ข้อ 02) · a locked challenge never
// lets a code through, whatever the code (BR-PORTAL ข้อ 02).

const words = ['บริษัท', 'จำกัด', 'บจก.', 'หจก.', '(มหาชน)', 'co., ltd.', 'Ltd', 'inc', 'Company Limited', 'สยาม', 'prince', 'Steel', ' ', '.', '-', '(สาขา 2)', 'ก', 'a']

describe('[BR-SUP-09] normalizeSupplierName is idempotent', () => {
  it('normalize(normalize(x)) = normalize(x)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.array(fc.constantFrom(...words), { maxLength: 8 }).map((p) => p.join(' '))), (name) => {
        const once = normalizeSupplierName(name)
        expect(normalizeSupplierName(once)).toBe(once)
      }),
      { numRuns: 2000, seed: 7_03 },
    )
  })
})

describe('[BR-SDOC-02] a document never expires before it is issued', () => {
  it('expiresOn ≥ issuedOn and issuedOn ≤ remindOn ≤ expiresOn for every type and date', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000 }),
        fc.option(fc.integer({ min: 1, max: 3_650 }), { nil: null }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: -400, max: 4_000 }),
        (offset, validityDays, reminderDaysBefore, statedOffset) => {
          const issuedOn = addDays('2000-01-01', offset)
          const r = documentExpiry({ validityDays, reminderDaysBefore }, { issuedOn, expiresOn: addDays(issuedOn, statedOffset) })
          if (!r.ok) {
            expect(r.reason).toBe('EXPIRY_BEFORE_ISSUE')
            return
          }
          expect(r.expiresOn >= issuedOn).toBe(true)
          expect(r.remindOn >= issuedOn && r.remindOn <= r.expiresOn).toBe(true)
        },
      ),
      { numRuns: 2000, seed: 7_03 },
    )
  })
})

describe('[BR-PORTAL-02] a locked challenge refuses every code', () => {
  it('OTP_LOCKED while now < lockedUntil, even with the right code', () => {
    const settings = { otpMinutes: 10, otpMaxAttempts: 5, otpLockMinutes: 15 }
    const createdAt = new Date('2026-11-02T02:00:00Z')
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 64 }), fc.integer({ min: 0, max: 899_999 }), fc.integer({ min: 1, max: 900_000 }), (attempt, offsetMs, lockMs) => {
        const now = new Date(createdAt.getTime() + offsetMs)
        const lockedUntil = new Date(now.getTime() + lockMs)
        const r = verifyOtp({ createdAt, codeHash: attempt, attempts: 5, lockedUntil }, attempt, now, settings)
        expect(r).toEqual({ ok: false, code: 'OTP_LOCKED' })
      }),
      { numRuns: 2000, seed: 7_03 },
    )
  })
})

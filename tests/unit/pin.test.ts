import { describe, expect, it } from 'vitest'
import {
  afterWrongPin,
  ALWAYS_STEP_UP_SUBJECTS,
  COMMON_PIN_GROUPS,
  COMMON_PINS,
  isPinFormat,
  isPinLocked,
  PIN_FAILURE_LIMIT,
  PIN_LENGTH,
  PIN_LOCK_MINUTES,
  pinAttemptsLeft,
  pinLockEndsAt,
  pinProblem,
  stepUpNeeded,
} from '@/core/pin'

// src/core/pin: the PIN rule of FR-AUTH-005 AC1, the lock of AC3 and which decisions need a step-up (BR-TOK-05,
// BR-DOA-15). The expected values are written out here, not computed with the code under test.

const MINUTE = 60_000

describe('[FR-AUTH-005/AC1] a PIN is six digits that are not easy to guess', () => {
  it('refuses the two examples of the AC, 123456 and 000000', () => {
    expect(pinProblem('123456')).toBe('SEQUENCE')
    expect(pinProblem('000000')).toBe('ALL_SAME')
  })

  it('refuses anything but six ASCII digits: shorter, longer, spaces, letters, signs and digits of other scripts', () => {
    expect(PIN_LENGTH).toBe(6)
    for (const value of ['', '7', '73916', '7391640', ' 739164', '739164 ', '739 164', 'abcdef', '73916a', '-73916', '7391.4', '๗๓๙๑๖๔', '７３９１６４', '7391٦4']) {
      expect(isPinFormat(value), JSON.stringify(value)).toBe(false)
      expect(pinProblem(value), JSON.stringify(value)).toBe('FORMAT')
    }
  })

  it('refuses one digit six times', () => {
    for (const pin of ['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999']) expect(pinProblem(pin), pin).toBe('ALL_SAME')
  })

  it('refuses digits going up or down by one, counting 9 → 0 and 0 → 9 as a step', () => {
    const up = ['012345', '123456', '234567', '345678', '456789', '567890', '678901', '789012', '890123', '901234']
    const down = ['543210', '654321', '765432', '876543', '987654', '098765', '109876', '210987', '321098', '432109']
    for (const pin of [...up, ...down]) expect(pinProblem(pin), pin).toBe('SEQUENCE')
    // A run that turns, or one step out of place, is not a run
    for (const pin of ['123465', '135792', '123454']) expect(pinProblem(pin), pin).not.toBe('SEQUENCE')
  })

  it('refuses the common choices of the constant list: repeated blocks, mirrors, keypad shapes and well-known numbers', () => {
    for (const pin of ['121212', '696969', '123123', '520520', '112233', '111222', '123321', '147258', '159753', '789456', '102030', '246810', '314159', '000123']) {
      expect(COMMON_PINS.has(pin), pin).toBe(true)
      expect(pinProblem(pin), pin).toBe('COMMON')
    }
    for (const pin of COMMON_PINS) expect(pinProblem(pin), pin).toBe('COMMON')
  })

  it('keeps the list to six-digit PINs the other rules do not refuse, each once, and every group in the set', () => {
    const all = Object.values(COMMON_PIN_GROUPS).flat()
    expect(all.length).toBe(COMMON_PINS.size)
    for (const pin of all) {
      expect(pin, pin).toMatch(/^[0-9]{6}$/)
      expect(/^(\d)\1{5}$/.test(pin), `${pin} is already ALL_SAME`).toBe(false)
    }
    // Every two digits three times is in the list (90 PINs)
    expect(COMMON_PIN_GROUPS.pairs).toHaveLength(90)
    for (let a = 0; a <= 9; a++) for (let b = 0; b <= 9; b++) if (a !== b) expect(COMMON_PINS.has(`${a}${b}`.repeat(3)), `${a}${b}`).toBe(true)
  })

  it('accepts PINs that are none of these', () => {
    for (const pin of ['739164', '480263', '915372', '264809', '503817', '826154', '502918', '371946']) expect(pinProblem(pin), pin).toBeNull()
  })

  it('refuses exactly the ten ALL_SAME, the twenty runs and the common list among all million PINs, and nothing else', () => {
    const counts = { FORMAT: 0, ALL_SAME: 0, SEQUENCE: 0, COMMON: 0, ok: 0 }
    for (let n = 0; n < 1_000_000; n++) counts[pinProblem(String(n).padStart(6, '0')) ?? 'ok']++
    expect(counts).toEqual({ FORMAT: 0, ALL_SAME: 10, SEQUENCE: 20, COMMON: COMMON_PINS.size, ok: 1_000_000 - 10 - 20 - COMMON_PINS.size })
  })
})

describe('[FR-AUTH-005/AC3] five wrong PINs in a row lock the PIN for 15 minutes', () => {
  const now = new Date('2026-10-05T03:00:00Z')

  it('counts the first four and locks at the fifth, for 15 minutes from then', () => {
    expect(PIN_FAILURE_LIMIT).toBe(5)
    expect(PIN_LOCK_MINUTES).toBe(15)
    expect([0, 1, 2, 3].map((before) => afterWrongPin(before, now))).toEqual([
      { failedCount: 1, lockedUntil: null, locked: false },
      { failedCount: 2, lockedUntil: null, locked: false },
      { failedCount: 3, lockedUntil: null, locked: false },
      { failedCount: 4, lockedUntil: null, locked: false },
    ])
    // The fifth locks and starts the count again, so the member has five tries after the lock
    expect(afterWrongPin(4, now)).toEqual({ failedCount: 0, lockedUntil: new Date('2026-10-05T03:15:00Z'), locked: true })
    expect(pinLockEndsAt(now)).toEqual(new Date('2026-10-05T03:15:00Z'))
  })

  it('locks at once if the count was somehow already past the limit', () => {
    expect(afterWrongPin(9, now)).toMatchObject({ locked: true, failedCount: 0 })
  })

  it('the lock stands until lockedUntil and ends at that instant', () => {
    const until = new Date(now.getTime() + 15 * MINUTE)
    expect(isPinLocked(until, now)).toBe(true)
    expect(isPinLocked(until, new Date(until.getTime() - 1))).toBe(true)
    expect(isPinLocked(until, until)).toBe(false)
    expect(isPinLocked(null, now)).toBe(false)
  })

  it('tells how many wrong PINs are still allowed', () => {
    expect([0, 1, 2, 3, 4, 5, 7].map(pinAttemptsLeft)).toEqual([5, 4, 3, 2, 1, 0, 0])
  })
})

// The rule only: whether a decision is refused without a PIN is proven where a deciding command runs it
// (tests/integration/step-up-pin.test.ts), so these carry the rule's tag, not FR-AUTH-005 AC2's
describe('[BR-TOK-05] which decisions need a step-up (BR-DOA-15)', () => {
  const threshold = 10_000_000n // 100,000.00 baht, as the DOA version sets it

  it('every DOA version (the initial package too), authority change, workflow version and bank account change, whatever the amount (BR-DOA-25)', () => {
    expect([...ALWAYS_STEP_UP_SUBJECTS].sort()).toEqual(['BANK_ACCOUNT_CHANGE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE', 'WORKFLOW_VERSION'])
    for (const subjectType of ['DOA_VERSION', 'ORG_AUTHORITY_CHANGE', 'WORKFLOW_VERSION', 'BANK_ACCOUNT_CHANGE']) {
      expect(stepUpNeeded({ subjectType, amountSatang: null, stepUpThresholdSatang: threshold })).toBe(true)
      expect(stepUpNeeded({ subjectType, amountSatang: null, stepUpThresholdSatang: null })).toBe(true)
    }
  })

  it('a task whose DOA amount is at or above the version threshold, compared in satang', () => {
    for (const subjectType of ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE']) {
      expect(stepUpNeeded({ subjectType, amountSatang: 10_000_000n, stepUpThresholdSatang: threshold }), `${subjectType} at`).toBe(true)
      expect(stepUpNeeded({ subjectType, amountSatang: 10_000_001n, stepUpThresholdSatang: threshold }), `${subjectType} above`).toBe(true)
      expect(stepUpNeeded({ subjectType, amountSatang: 9_999_999n, stepUpThresholdSatang: threshold }), `${subjectType} one satang below`).toBe(false)
    }
  })

  it('no step-up when the version sets no threshold or the subject has no amount', () => {
    expect(stepUpNeeded({ subjectType: 'REQUEST', amountSatang: 999_999_999_999n, stepUpThresholdSatang: null })).toBe(false)
    expect(stepUpNeeded({ subjectType: 'VARIANCE', amountSatang: null, stepUpThresholdSatang: threshold })).toBe(false)
  })

  it('[BR-WF-09] a reviewer needs none, whatever the amount; an approval step as before', () => {
    expect(stepUpNeeded({ subjectType: 'REQUEST', amountSatang: 10_000_000n, stepUpThresholdSatang: threshold, stepKind: 'REVIEW' })).toBe(false)
    expect(stepUpNeeded({ subjectType: 'REQUEST', amountSatang: 10_000_000n, stepUpThresholdSatang: threshold, stepKind: 'APPROVAL' })).toBe(true)
  })
})

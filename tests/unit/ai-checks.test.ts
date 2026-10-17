import { describe, expect, it } from 'vitest'
import { AGENT_ACTION_MACHINE, agentActionTransition, creditPeriodMonth, mapQuotation, redactForAi, REDACTED } from '@/core/ai-checks'

// The pure parts of the AI module that are not golden suites: the AgentAction state machine (docs/sub-specs/S13.md
// "State machine"), the month of a credit (Thai time), and the redactor of BR-AI-18.

describe('[BR-AI-04] AgentAction walks only the transitions of its table', () => {
  it('every (state, command) pair goes where the table says, every other pair is refused', () => {
    let allowed = 0
    for (const state of AGENT_ACTION_MACHINE.states) {
      for (const command of AGENT_ACTION_MACHINE.commands) {
        const expected = AGENT_ACTION_MACHINE.transitions.find((t) => t.command === command && t.from.includes(state))
        const r = agentActionTransition(state, command)
        if (expected) {
          expect(r).toEqual({ ok: true, to: expected.to })
          allowed++
        } else expect(r.ok, `${state} ${command}`).toBe(false)
      }
    }
    expect(allowed).toBe(8)
    // Final states never move again
    for (const state of ['ACCEPTED', 'EDITED', 'REJECTED', 'FAILED', 'EXPIRED'] as const) {
      for (const command of AGENT_ACTION_MACHINE.commands) expect(agentActionTransition(state, command).ok).toBe(false)
    }
  })
})

describe('[BR-AI-23] the month of a credit is the Thai month', () => {
  it('turns at midnight in Bangkok, not in UTC', () => {
    expect(creditPeriodMonth(new Date('2026-10-31T16:59:59Z'))).toBe('2026-10-01')
    expect(creditPeriodMonth(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11-01')
    expect(creditPeriodMonth(new Date('2026-12-31T17:30:00Z'))).toBe('2027-01-01')
  })
})

describe('[BR-AI-18] the redactor hides account numbers and personal ids', () => {
  it('replaces bank accounts and the 13-digit id of a natural person', () => {
    expect(redactForAi('โอนเข้าบัญชี 1234567890 ธนาคารกรุงไทย')).toBe(`โอนเข้าบัญชี ${REDACTED} ธนาคารกรุงไทย`)
    expect(redactForAi('บัญชี 123-4-56789-0')).toBe(`บัญชี ${REDACTED}`)
    expect(redactForAi('เลขบัตร 3-1012-01234-56-7 และ 3101201234567')).toBe(`เลขบัตร ${REDACTED} และ ${REDACTED}`)
  })
  it('keeps the tax id of a juristic person, amounts, dates and short numbers', () => {
    const text = 'ผู้ขาย 0105512345678 ยอด 129,684.00 บาท วันที่ 2026-10-13 จำนวน 25 วัน เลขที่ INV-00373'
    expect(redactForAi(text)).toBe(text)
  })
})

describe('[BR-AI-25] a total that is not an amount fills nothing instead of failing the reading (ADR-073 pre-review)', () => {
  const ctx = { fileId: 'F', vatRateBp: 700, registry: [], normalized: { lines: [], discountTotal: null } }
  it('a delivery note read in the quotation place, its net "-" or "1,200 บาท": no amount, AMOUNT_UNVERIFIED; "1,200.50" is read', () => {
    for (const net of ['-', '1,200 บาท', '12.345']) {
      const got = mapQuotation({ docType: 'DELIVERY_NOTE', net, lines: [] }, {}, ctx)
      expect(got.quotation?.amount, net).toBeNull()
      expect(got.flags, net).toContain('AMOUNT_UNVERIFIED')
    }
    expect(mapQuotation({ docType: 'QUOTATION', net: '1,200.50', lines: [] }, {}, ctx).quotation?.amount).toBe('1200.50')
  })
})

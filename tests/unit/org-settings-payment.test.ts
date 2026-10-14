import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { OrgSettingsSchema, paymentSettingsOf } from '@/lib/org-settings'

// S9-01: settings.payment and numbering.PAY / numbering.BAC are optional, so the DEMO settings still pass; a key that is
// missing reads as its OQ default (OQ-130 OQ-132 OQ-134)

const demo = () => parseYaml(readFileSync('prisma/seed/org-settings.demo.yaml', 'utf8')) as Record<string, unknown>

describe('OrgSettingsSchema with the S9 section', () => {
  it('accepts settings.payment and the numbering of payment runs and bank account changes', () => {
    const s = demo()
    const numbering = { ...(s.numbering as object), PAY: { pattern: 'PAY-{BE}-{SEQ5}', reset: 'YEARLY' }, BAC: { pattern: 'BAC-{BE}-{SEQ5}', reset: 'YEARLY' } }
    expect(OrgSettingsSchema.safeParse({ ...s, numbering, payment: { runWeekdays: ['TUE', 'FRI'], holidayShift: 'NEXT', recentBankChangeDays: 14, adviceEmail: false } }).success).toBe(true)
  })

  it.each([
    ['no weekday', { runWeekdays: [] }],
    ['a weekday that is not one', { runWeekdays: ['FRIDAY'] }],
    ['a shift other than PREVIOUS or NEXT', { holidayShift: 'NEAREST' }],
    ['more than a year of recent bank changes', { recentBankChangeDays: 366 }],
    ['an unknown key', { runDay: 'FRI' }],
  ])('refuses %s', (_label, payment) => {
    expect(OrgSettingsSchema.safeParse({ ...demo(), payment }).success).toBe(false)
  })
})

describe('paymentSettingsOf', () => {
  it('reads the OQ defaults when settings have no payment section: Fridays, the working day before, 30 days, advice e-mails on', () => {
    expect(paymentSettingsOf(demo())).toEqual({ runWeekdays: ['FRI'], holidayShift: 'PREVIOUS', recentBankChangeDays: 30, adviceEmail: true })
    expect(paymentSettingsOf(null)).toEqual(paymentSettingsOf({}))
  })

  it('takes each key that is set and keeps the default of the others', () => {
    expect(paymentSettingsOf({ payment: { recentBankChangeDays: 7 } })).toEqual({ runWeekdays: ['FRI'], holidayShift: 'PREVIOUS', recentBankChangeDays: 7, adviceEmail: true })
  })
})

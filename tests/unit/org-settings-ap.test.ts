import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { apPolicyOf, OrgSettingsSchema } from '@/lib/org-settings'

// S8-01: the matching, withholding-tax and AP sections and numbering.AP / numbering.WHT_CERT are optional, so the DEMO
// settings (which have none of them) still pass; a key that is missing reads as its OQ default (BR-MATCH-13).

const demo = () => parseYaml(readFileSync('prisma/seed/org-settings.demo.yaml', 'utf8')) as Record<string, unknown>

describe('OrgSettingsSchema with the S8 sections', () => {
  it('the DEMO settings still pass', () => {
    expect(OrgSettingsSchema.safeParse(demo()).success).toBe(true)
  })

  it('accepts the S8 sections and the two new numbering keys', () => {
    const s = demo()
    const numbering = { ...(s.numbering as object), AP: { pattern: 'AP-{BE}-{SEQ5}', reset: 'YEARLY' }, WHT_CERT: { pattern: '{BE}/{SEQ5}', reset: 'YEARLY' } }
    const parsed = OrgSettingsSchema.safeParse({
      ...s,
      numbering,
      matching: { priceTolBp: 100, priceTolAmount: '1000.00', qtyTolBp: 0, vatTolAmount: '1.00' },
      wht: { minimumBase: '1000.00', timing: 'AT_PAYMENT' },
      ap: { defaultTermDays: 30, inboxAddress: 'ap@simec.bcs.local' },
    })
    expect(parsed.success).toBe(true)
  })

  it('[FR-AP-104/AC2] wht.timing other than AT_PAYMENT is refused (BR-WHT-05)', () => {
    for (const timing of ['AT_BOOKING', 'at_payment', '']) {
      expect(OrgSettingsSchema.safeParse({ ...demo(), wht: { timing } }).success).toBe(false)
    }
  })

  it('refuses money that is not a baht string with 2 decimals, and rates outside 0–10000 bp', () => {
    expect(OrgSettingsSchema.safeParse({ ...demo(), matching: { priceTolAmount: 1000 } }).success).toBe(false)
    expect(OrgSettingsSchema.safeParse({ ...demo(), matching: { priceTolAmount: '1000' } }).success).toBe(false)
    expect(OrgSettingsSchema.safeParse({ ...demo(), matching: { priceTolBp: 10_001 } }).success).toBe(false)
    expect(OrgSettingsSchema.safeParse({ ...demo(), matching: { tolerance: 1 } }).success).toBe(false)
  })
})

describe('apPolicyOf', () => {
  it('reads the OQ defaults when settings leave the sections out', () => {
    expect(apPolicyOf(demo())).toEqual({
      priceTolBp: 100,
      priceTolSatang: 100_000n,
      qtyTolBp: 0,
      vatTolSatang: 100n,
      whtMinimumBaseSatang: 100_000n,
      whtTiming: 'AT_PAYMENT',
      defaultTermDays: 30,
    })
    expect(apPolicyOf(null).priceTolBp).toBe(100)
  })

  it('takes each key the settings give, and the default for the rest', () => {
    const policy = apPolicyOf({ matching: { priceTolBp: 50, vatTolAmount: '0.50' }, ap: { defaultTermDays: 45 } })
    expect(policy).toMatchObject({ priceTolBp: 50, priceTolSatang: 100_000n, vatTolSatang: 50n, defaultTermDays: 45 })
  })
})

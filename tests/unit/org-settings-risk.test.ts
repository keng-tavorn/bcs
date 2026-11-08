import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { OrgSettingsSchema, riskSettingsOf } from '@/lib/org-settings'

// S11-01: settings.risk and numbering.RSA / numbering.RO are optional, so the DEMO settings and an organization saved
// before S11 still pass; a key that is missing reads as its default (OQ-224 OQ-228 OQ-230). The keys that decide the PO
// gate are not in settings: they are the organization's RiskPolicy and RiskTier rows (BR-RSK-02)

const demo = () => parseYaml(readFileSync('prisma/seed/org-settings.demo.yaml', 'utf8')) as Record<string, unknown>

describe('[BR-RSK-02] OrgSettingsSchema with the S11 section', () => {
  it('parses settings without a risk key, and with the four keys and the numbering of assessments and overrides', () => {
    expect(OrgSettingsSchema.safeParse(demo()).success).toBe(true)
    const s = demo()
    const numbering = { ...(s.numbering as object), RSA: { pattern: 'RSA-{BE}-{SEQ5}', reset: 'YEARLY' }, RO: { pattern: 'RO-{BE}-{SEQ5}', reset: 'YEARLY' } }
    expect(OrgSettingsSchema.safeParse({ ...s, numbering, risk: { overrideMaxDays: 60, aiAssist: false, portalAnswering: false, answerRetentionYears: 7 } }).success).toBe(true)
  })

  it.each([
    ['a gate key (the screening map is RiskPolicy)', { screeningTierMap: { processesPersonalData: 'HIGH' } }],
    ['a gate key (the high-risk categories are RiskPolicy)', { highRiskCategories: ['PROF'] }],
    ['a gate key (the registry block is RiskPolicy)', { registryFlagBlocks: true }],
    ['an override of no days', { overrideMaxDays: 0 }],
    ['a retention of no years', { answerRetentionYears: 0 }],
  ])('refuses %s', (_label, risk) => {
    expect(OrgSettingsSchema.safeParse({ ...demo(), risk }).success).toBe(false)
  })
})

describe('riskSettingsOf', () => {
  it('reads the defaults when settings have no risk section: 90 days, AI help on, answering in the portal, 10 years', () => {
    expect(riskSettingsOf(demo())).toEqual({ overrideMaxDays: 90, aiAssist: true, portalAnswering: true, answerRetentionYears: 10 })
    expect(riskSettingsOf(null)).toEqual(riskSettingsOf({}))
  })

  it('takes each key that is set and keeps the default of the others; a broken section reads as the defaults', () => {
    expect(riskSettingsOf({ risk: { overrideMaxDays: 30 } })).toEqual({ overrideMaxDays: 30, aiAssist: true, portalAnswering: true, answerRetentionYears: 10 })
    expect(riskSettingsOf({ risk: { overrideMaxDays: -1 } })).toEqual(riskSettingsOf({}))
  })
})

import { describe, expect, it } from 'vitest'
import type { DelegationSnapshot } from '@/core/doa/types'
import { amountToSatang } from '@/core/money/dto'
import { g9Rate, overrideExpiryCheck, overrideWindow, reviewDates, riskReviewers, riskStatusAt, type G9Row, type RiskTierCode, type Screening } from '@/core/risk'
import { loadYaml, orgSnapshot } from './doa-fixtures'
import { workflowFixture } from './workflow-fixtures'

// tests/golden/risk-review.yaml (spec §7.24 · S11-06, S11-09 adds its own functions below): GC-RSK-25 to 32, the
// reviewers of a supplier risk assessment — the RISK_ASSESSMENT rules of the workflow version in effect resolved by S6's
// resolveReviewStep through riskReviewers (BR-RSK-07). The opener is the file's openedBy; conflictMemberIds are who filled
// in for the supplier; a delegation is from → to, limited by documentTypes or maxAmount when given.

interface Case {
  id: string
  title: string
  fn: string
  input: {
    screening: Screening
    tier: RiskTierCode
    inherentTier?: RiskTierCode
    categoryCodes?: string[]
    conflictMemberIds?: string[]
    vacate?: string[]
    delegations?: Array<{ from: string; to: string; documentTypes?: string[]; maxAmount?: string }>
  }
  expect: unknown
}
interface File {
  fixtures: string[]
  tiers: Array<{ code: RiskTierCode; reviewMonths: number; reminderDaysBefore: number }>
  defaults: { at: string; openedBy: string; categoryCodes: string[]; payeeType: string }
  cases: Case[]
}

const file = loadYaml<File>('risk-review.yaml')
const org = file.fixtures.find((f) => f.includes('/org-'))!
const { versions } = workflowFixture(file.fixtures, '/risk-reviewers')
const EPOCH = new Date('2000-01-01T00:00:00Z')
const LATER = new Date('2100-01-01T00:00:00Z')

function delegation(i: number, d: NonNullable<Case['input']['delegations']>[number]): DelegationSnapshot {
  return {
    id: `D${i}`,
    delegatorMemberId: d.from,
    delegateMemberId: d.to,
    startsAt: EPOCH,
    endsAt: LATER,
    documentTypes: (d.documentTypes as DelegationSnapshot['documentTypes']) ?? null,
    maxAmountSatang: d.maxAmount !== undefined ? amountToSatang(d.maxAmount) : null,
    status: 'ACTIVE',
  }
}

function run(c: Case): unknown {
  const i = c.input
  const r = riskReviewers(
    versions,
    {
      screening: i.screening,
      tier: i.tier,
      inherentTier: i.inherentTier ?? i.tier,
      categoryCodes: i.categoryCodes ?? file.defaults.categoryCodes,
      payeeType: file.defaults.payeeType,
      openedById: file.defaults.openedBy,
      filledOnBehalfByIds: i.conflictMemberIds ?? [],
      at: new Date(file.defaults.at),
    },
    orgSnapshot(i.vacate ?? [], org),
    (i.delegations ?? []).map((d, n) => delegation(n, d)),
  )
  if (!r.ok) return { error: r.error.code, rule: (r.error.details as { rule?: string } | undefined)?.rule }
  if (r.data === null) return { review: null }
  return {
    review: {
      quorum: 'ALL',
      slots: r.data.slots.map((s) => ({
        rules: [...s.ruleCodes],
        reviewers: s.assignees.map((a) => a.assigneeMemberId),
        ...(s.fallback ? { fallback: s.fallback } : {}),
        ...(s.assignees[0]!.principalMemberId ? { principal: s.assignees[0]!.principalMemberId } : {}),
        domains: [...s.riskDomains],
      })),
    },
  }
}

describe('golden risk-review (GC-RSK · S11-06 reviewers)', () => {
  for (const c of file.cases.filter((x) => x.fn === 'riskReviewers')) {
    it(`[${c.id}] ${c.title}`, () => {
      expect(run(c)).toEqual(c.expect)
    })
  }
})

// S11-09 (BR-RSK-13 BR-RSK-15 BR-RSK-10): the reassessment dates of a tier, the state on a day, G-9 and the window of an
// override's last day — GC-RSK-59 to 76, the tiers of the suite (SIMEC's months and reminder days · OQ-226)
type DatesInput = { completedAt: string; tier: RiskTierCode }
type StatusInput = { validUntil: string; remindOn: string; today: string }
type WindowInput = { submittedOn: string; overrideMaxDays: number; expiresOn?: string }

function runDates(c: Case): unknown {
  const i = c.input as unknown as DatesInput & StatusInput & WindowInput & { rows: G9Row[] }
  switch (c.fn) {
    case 'reviewDates':
      return reviewDates(new Date(i.completedAt), file.tiers.find((t) => t.code === i.tier)!, 'Asia/Bangkok')
    case 'riskStatusAt':
      return riskStatusAt(i)
    case 'g9Rate':
      return g9Rate(i.rows)
    case 'overrideWindow':
      return overrideWindow(i)
    default: {
      const r = overrideExpiryCheck({ submittedOn: i.submittedOn, expiresOn: i.expiresOn!, overrideMaxDays: i.overrideMaxDays })
      return r.ok ? { ok: true } : { error: r.error, reason: r.reason }
    }
  }
}

describe('golden risk-review (GC-RSK · S11-09 reassessment dates, G-9, override window)', () => {
  const fns = ['reviewDates', 'riskStatusAt', 'g9Rate', 'overrideWindow', 'overrideExpiryCheck']
  it('covers every case of the suite', () => {
    expect(file.cases.every((c) => c.fn === 'riskReviewers' || fns.includes(c.fn))).toBe(true)
  })
  for (const c of file.cases.filter((x) => fns.includes(x.fn))) {
    it(`[${c.id}] ${c.title}`, () => {
      expect(runDates(c)).toEqual(c.expect)
    })
  }
})

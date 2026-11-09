import { describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { poGate, type GateAssessment, type GatePolicy, type PoGateTrigger, type RegistryFlag, type RiskTierCode } from '@/core/risk'
import { loadYaml } from './doa-fixtures'

// tests/golden/risk-gate.yaml (spec §7.24 · S11-07): GC-RSK-33 to 58, the gate before a PO goes out (BR-RSK-09 BR-RSK-12 ·
// FR-RSK-203). Money is written in baht and compared as satang; an override of a case is merged field by field over the
// defaults' override; priorGrossAmount is what of this PO the override already holds (0 when not given).

interface OverrideIn {
  status?: string
  poId?: string
  expiresOn?: string
  capGrossAmount?: string
  usedGrossAmount?: string
}
interface Input {
  tier: RiskTierCode
  assessment: GateAssessment
  grossAmount?: string
  priorGrossAmount?: string
  registryFlag?: RegistryFlag
  screeningCovered?: boolean
  assessedAfterFlag?: boolean
  trigger?: PoGateTrigger
  policy?: GatePolicy
  override?: OverrideIn
}
interface Case {
  id: string
  title: string
  fn: 'poGate'
  input: Input
  expect: unknown
}
interface Suite {
  tiers: { code: RiskTierCode; blocksPo: boolean }[]
  policy: GatePolicy
  defaults: Required<Pick<Input, 'grossAmount' | 'registryFlag' | 'screeningCovered' | 'assessedAfterFlag' | 'trigger'>> & { poDate: string; poId: string; override: OverrideIn }
  cases: Case[]
}

const suite = loadYaml<Suite>('risk-gate.yaml')
const df = suite.defaults

function run(i: Input): unknown {
  const o = i.override ? { ...df.override, ...i.override } : null
  return poGate({
    tier: i.tier,
    tiers: suite.tiers,
    policy: i.policy ?? suite.policy,
    registryFlag: i.registryFlag ?? df.registryFlag,
    assessedAfterFlag: i.assessedAfterFlag ?? df.assessedAfterFlag,
    assessment: i.assessment,
    screeningCovered: i.screeningCovered ?? df.screeningCovered,
    override: o
      ? { status: o.status!, poId: o.poId ?? null, expiresOn: o.expiresOn!, capGrossSatang: amountToSatang(o.capGrossAmount!), usedGrossSatang: amountToSatang(o.usedGrossAmount ?? '0.00') }
      : null,
    poId: df.poId,
    poDate: df.poDate,
    grossSatang: amountToSatang(i.grossAmount ?? df.grossAmount),
    countedGrossSatang: amountToSatang(i.priorGrossAmount ?? '0.00'),
    trigger: i.trigger ?? df.trigger,
  })
}

describe('golden risk-gate.yaml', () => {
  it('has the cases of S11-07', () => expect(suite.cases.map((c) => c.id)).toEqual(Array.from({ length: 26 }, (_, i) => `GC-RSK-${i + 33}`)))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => expect(run(c.input)).toEqual(c.expect))
  }
})

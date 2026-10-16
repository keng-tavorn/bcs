import { describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { stepUpNeeded } from '@/core/pin'
import { passkeyAssertionVerdict, STEP_UP_GRANT_SECONDS, stepUpMethodsFor, type AssertionFacts } from '@/core/step-up-methods'
import { STEP_UP_TTL_MS } from '@/lib/constants'
import { loadYaml } from './doa-fixtures'

// tests/golden/step-up-methods.yaml (spec §7.20, S17-15): the proofs every subject that needs a step-up takes (the PIN
// and a passkey), what a passkey assertion comes to (BR-AUTH-09), and the step-up threshold's edge, unchanged. The
// signature, challenge and origin checks with a real authenticator and Postgres are tests/integration/passkey-step-up.test.ts.

interface Case {
  id: string
  title?: string
  input: { subjects?: string[]; assertion?: AssertionFacts; stepUpThreshold?: string; amounts?: string[] }
  expect: Record<string, unknown>
}

const suite = loadYaml<{ cases: Case[] }>('step-up-methods.yaml')

function run(c: Case): unknown {
  const i = c.input
  if (i.subjects) {
    const each = new Set(i.subjects.map((s) => JSON.stringify(stepUpMethodsFor(s))))
    return { methods: each.size === 1 ? JSON.parse([...each][0]!) : [...each] }
  }
  if (i.amounts) {
    const threshold = amountToSatang(i.stepUpThreshold!)
    return { stepUpNeeded: i.amounts.map((a) => stepUpNeeded({ subjectType: 'REQUEST', amountSatang: amountToSatang(a), stepUpThresholdSatang: threshold })) }
  }
  return passkeyAssertionVerdict(i.assertion!)
}

describe('[FR-PLT-301/AC3] [FR-AUTH-005/AC2] golden step-up-methods (BR-AUTH-09)', () => {
  it.each(suite.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(run(c)).toEqual(c.expect)
  })

  it('a passkey grant lives as long as a PIN grant', () => {
    expect(STEP_UP_GRANT_SECONDS * 1000).toBe(STEP_UP_TTL_MS)
  })
})

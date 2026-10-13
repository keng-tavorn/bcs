import { describe, expect, it } from 'vitest'
import { creditsForCall, creditsRemaining, crossesAlert, mayStartCall, type CreditPrice, type TokenUse } from '@/core/ai-checks'
import { loadGolden } from './support'

// tests/golden/ai-credits.yaml (spec §12.6, BR-AI-23): GC-AI-01 to GC-AI-11. The runner only adapts shapes.

interface Case {
  id: string
  title?: string
  input: {
    model?: string
    tokens?: TokenUse
    grant?: number
    alertAtBp?: number
    uses?: number[]
    used?: number
    calls?: number[]
  }
  expect: Record<string, unknown>
}

const suite = loadGolden('ai-credits') as unknown as { fixture: { prices: Record<string, CreditPrice> }; cases: Case[] }

function run(c: Case): Record<string, unknown> {
  const i = c.input
  if (i.model) return creditsForCall(suite.fixture.prices[i.model]!, i.tokens ?? {})
  if (i.uses) {
    let used = 0
    let alertAfterUse: number | null = null
    const remaining = i.uses.map((u, k) => {
      const before = used
      used += u
      if (alertAfterUse === null && crossesAlert(i.grant!, i.alertAtBp!, before, used)) alertAfterUse = k
      return creditsRemaining(i.grant!, used)
    })
    return { remaining, alertAfterUse }
  }
  let used = i.used!
  const results = i.calls!.map((cost) => {
    if (!mayStartCall(creditsRemaining(i.grant!, used))) return 'AI_CREDITS_EXHAUSTED'
    used += cost
    return 'ok'
  })
  return { results, remaining: creditsRemaining(i.grant!, used) }
}

describe('[BR-AI-23] golden ai-credits.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      const got = run(c)
      for (const [k, v] of Object.entries(c.expect)) expect(got[k], k).toEqual(v)
    })
  }
})

describe('[BR-AI-23] credits refuse what cannot be a token count', () => {
  it('throws on a negative or fractional count', () => {
    const price = suite.fixture.prices.A!
    expect(() => creditsForCall(price, { input: -1 })).toThrow(RangeError)
    expect(() => creditsForCall(price, { output: 1.5 })).toThrow(RangeError)
    expect(crossesAlert(0, 8000, 0, 10)).toBe(false)
  })
})

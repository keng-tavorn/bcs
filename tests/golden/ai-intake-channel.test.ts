import { describe, expect, it } from 'vitest'
import type { Condition } from '@/core/forms'
import { suggestChannel, type ChannelContext } from '@/core/ai-checks'
import { loadGolden } from './support'

// tests/golden/ai-intake-channel.yaml (spec §12.6, BR-AI-19): the purchase channel the Intake Agent suggests is computed
// by code from the catalogue's agreements in force, the requester's own past requests and the attachment rules.

describe('[BR-AI-19] golden ai-intake-channel.yaml', () => {
  const suite = loadGolden('ai-intake-channel') as unknown as {
    fixture: Omit<ChannelContext, 'rules'> & { rules: { id: string; when: Condition }[] }
    cases: Array<{ id: string; title?: string; input: { lines: { itemCode: string | null; qty: string }[]; amountGross: string }; expect: Record<string, unknown> }>
  }
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      expect(suggestChannel(c.input, suite.fixture)).toEqual(c.expect)
    })
  }
})

describe('[BR-AI-19] the channel of what the golden suite leaves out', () => {
  const ctx: ChannelContext = { asOf: '2026-10-11', rules: [], catalog: [{ itemCode: 'A', agreements: [{ supplier: 'S', unitPrice: '1.00', validFrom: '2026-01-01', validTo: null }] }], pastRequests: [{ itemCode: 'B', number: 'PR-1', daysAgo: 10 }, { itemCode: 'B', number: 'PR-OLD', daysAgo: 400 }], reorderLookbackDays: 180 }
  it('an open-ended agreement is in force; no lines at all is a standard request; an item asked too long ago is not a reorder', () => {
    expect(suggestChannel({ lines: [{ itemCode: 'A' }], amountGross: '1.00' }, ctx).channel).toBe('CATALOG')
    expect(suggestChannel({ lines: [], amountGross: '0.00' }, ctx)).toEqual({ channel: 'STANDARD', requiredRules: [] })
    expect(suggestChannel({ lines: [{ itemCode: 'B' }], amountGross: '1.00' }, ctx)).toEqual({ channel: 'REORDER', reorderFrom: 'PR-1', requiredRules: [] })
    expect(suggestChannel({ lines: [{ itemCode: 'B' }], amountGross: '1.00' }, { ...ctx, pastRequests: [{ itemCode: 'B', number: 'PR-OLD', daysAgo: 400 }] }).channel).toBe('STANDARD')
  })
})

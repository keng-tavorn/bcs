import { describe, expect, it } from 'vitest'
import { checkAiText, renderValue, type TextProfile, type TextValue } from '@/core/ai-checks'
import { DECISION_ADVICE_WORDS } from '@/lib/ai-config'
import { loadGolden } from './support'

// tests/golden/ai-text.yaml (spec §12.6, BR-AI-27, ADR-144): the text an AI wrote passes only with every value as a
// placeholder of a fact, no advice to decide, within the profile's sentences and length; values are filled in by code.

describe('[BR-AI-27] golden ai-text.yaml', () => {
  const suite = loadGolden('ai-text') as unknown as {
    fixture: { profiles: Record<string, TextProfile>; decisionAdvice: string[]; values: Record<string, TextValue> }
    cases: Array<{ id: string; title?: string; input: { profile: string; sentences: string[] }; expect: Record<string, unknown> }>
  }
  const fx = suite.fixture
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      expect(checkAiText(c.input.sentences, fx.values, fx.profiles[c.input.profile]!, fx.decisionAdvice)).toMatchObject(c.expect)
    })
  }
  it('the golden words of advice are the words of ai-config', () => expect([...DECISION_ADVICE_WORDS]).toEqual(expect.arrayContaining(fx.decisionAdvice)))
})

describe('[BR-AI-27] values as the text shows them', () => {
  it('money, percents, Thai dates, integers and text', () => {
    expect(renderValue({ kind: 'money', value: '1234567.5' })).toBe('1,234,567.50')
    expect(renderValue({ kind: 'bp', value: 1000 })).toBe('10%')
    expect(renderValue({ kind: 'bp', value: 1234 })).toBe('12.34%')
    expect(renderValue({ kind: 'bp', value: -50 })).toBe('-0.5%')
    expect(renderValue({ kind: 'bp', value: -1250 })).toBe('-12.5%')
    expect(renderValue({ kind: 'date', value: '2026-10-11' })).toBe('11 ต.ค. 2569')
    expect(renderValue({ kind: 'integer', value: 3 })).toBe('3')
    expect(renderValue({ kind: 'enum', value: 'HIGH' })).toBe('HIGH')
    expect(checkAiText([], {}, { maxSentences: 1, maxChars: 1 }, [])).toEqual({ ok: true, rendered: [] })
  })
})

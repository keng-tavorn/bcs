import { describe, expect, it } from 'vitest'
import { kindOfKey, rankSuggestions, SUGGESTION_KINDS, SUGGESTION_TONE, type SuggestionKind } from '@/lib/assistant-suggestions'

// NEW-121 (ADR-078): the order of the home card "ผู้ช่วยเจอให้คุณ" and the keys a member sets aside.

const s = (kind: SuggestionKind, key: string, at: string | null) => ({ kind, key, at: at ? new Date(at) : null })

describe('[FR-VIS-006/AC7] the order of the card', () => {
  it('the more pressing tone first, then the earlier moment, those without one last, then the kind and the key', () => {
    const ranked = rankSuggestions([
      s('AGREEMENT_EXPIRING', 'AGREEMENT_EXPIRING:a:1', '2026-10-13T00:00:00Z'),
      s('BUDGET_LOW', 'BUDGET_LOW:y:2', null),
      s('PRICE_HIGH', 'PRICE_HIGH:t2:1', '2026-10-14T00:00:00Z'),
      s('FOLLOW_DUE_SOON', 'FOLLOW_DUE_SOON:t1', '2026-10-12T05:00:00Z'),
      s('SUPPLIER_FLAGS', 'SUPPLIER_FLAGS:s:REGISTRY_CHANGED', '2026-10-20T00:00:00Z'),
      s('FOLLOW_OVERDUE', 'FOLLOW_OVERDUE:t0', '2026-10-11T00:00:00Z'),
      s('REQUEST_FLAG', 'REQUEST_FLAG:t2:DUPLICATE', '2026-10-14T00:00:00Z'),
    ])
    expect(ranked.map((r) => r.key)).toEqual([
      'FOLLOW_OVERDUE:t0',
      'SUPPLIER_FLAGS:s:REGISTRY_CHANGED',
      'FOLLOW_DUE_SOON:t1',
      // the same moment: the kind's order decides
      'REQUEST_FLAG:t2:DUPLICATE',
      'PRICE_HIGH:t2:1',
      'BUDGET_LOW:y:2',
      'AGREEMENT_EXPIRING:a:1',
    ])
  })

  it('every kind has a tone, and the order of the kinds follows the tones', () => {
    const order = ['DANGER', 'WARN', 'INFO']
    const tones = SUGGESTION_KINDS.map((k) => order.indexOf(SUGGESTION_TONE[k]))
    expect(tones.every((t) => t >= 0)).toBe(true)
    expect([...tones].sort((a, b) => a - b)).toEqual(tones)
  })
})

describe('[FR-VIS-006/AC8] the keys a member sets aside', () => {
  it('names a known kind first', () => {
    expect(kindOfKey('FOLLOW_OVERDUE:abc')).toBe('FOLLOW_OVERDUE')
    expect(kindOfKey('SUPPLIER_FLAGS:s:A+B')).toBe('SUPPLIER_FLAGS')
    expect(kindOfKey('NOPE:1')).toBeNull()
    expect(kindOfKey('')).toBeNull()
  })
})

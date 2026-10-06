import { describe, expect, it } from 'vitest'
import { formatDocumentNumber, scopeKey, type ResetPeriod } from '@/core/numbering'
import { loadYaml } from './doa-fixtures'

// tests/golden/numbering.yaml (spec §7.3, BR-NUM-01..03): document numbers and the counter scope they use.

type Case<I, E> = { id: string; title?: string; fn?: string; input: I; expect: E }

describe('golden numbering.yaml', () => {
  const suite = loadYaml<{ cases: Case<{ pattern: string; reset: ResetPeriod; documentType: string; at: string; seq: number; department?: string }, Record<string, string>>[] }>('numbering.yaml')
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const ctx = { at: new Date(c.input.at), department: c.input.department ?? null }
      expect({ number: formatDocumentNumber(c.input.pattern, { ...ctx, seq: c.input.seq }), scopeKey: scopeKey(c.input.documentType, c.input.pattern, c.input.reset, ctx) }).toEqual(c.expect)
    })
  }
})

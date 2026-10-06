import { describe, expect, it } from 'vitest'
import { consolidate, type LineKind } from '@/core/consolidation'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/consolidation.yaml (spec §7.10): GC-CONS-01 to GC-CONS-05. A line ref "PR-10/1" is request PR-10, line 1.

interface ConsolidationSuite {
  cases: Array<{
    id: string
    title?: string
    input: { lines: Array<{ ref: string; supplier: string | null; site: string | null; kind: LineKind; urgent?: boolean }> }
    expect: Record<string, unknown>
  }>
}

const suite = loadYaml<ConsolidationSuite>('consolidation.yaml')

describe('[FR-P2P-002/AC1] golden consolidation.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const lines = c.input.lines.map((l) => {
        const [requestNo, lineNo] = l.ref.split('/') as [string, string]
        return { ref: l.ref, requestNo, lineNo: Number(lineNo), supplierId: l.supplier, siteId: l.site, kind: l.kind, ...(l.urgent ? { urgent: true } : {}) }
      })
      expect(pick({ ...consolidate(lines) }, c.expect)).toEqual(c.expect)
    })
  }
})

describe('consolidation beyond the golden cases', () => {
  it('orders groups and lines by request number then line number, whatever order the pool is in (BR-CONS-05)', () => {
    const line = (ref: string, supplier: string) => {
      const [requestNo, lineNo] = ref.split('/') as [string, string]
      return { ref, requestNo, lineNo: Number(lineNo), supplierId: supplier, siteId: 'A', kind: 'GOODS' as const }
    }
    const pool = [line('PR-2569-00012/2', 'S2'), line('PR-2569-00009/1', 'S1'), line('PR-2569-00012/1', 'S1'), line('PR-2569-00010/1', 'S2')]
    expect(consolidate(pool).cycleGroups).toEqual([
      ['PR-2569-00009/1', 'PR-2569-00012/1'],
      ['PR-2569-00010/1', 'PR-2569-00012/2'],
    ])
    expect(consolidate([...pool].reverse())).toEqual(consolidate(pool))
  })
})

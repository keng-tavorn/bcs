import { describe, expect, it } from 'vitest'
import type { BusinessCalendar, Weekday } from '@/core/sla'
import { bottlenecks, cycleMinutes, decisionMinutes, heatCell, lowerMedian, wrongDoa } from '@/core/workflow-reports'
import { loadYaml } from './doa-fixtures'

// tests/golden/workflow-reports.yaml (spec §7.16 · S6-20 · FR-VIS-101 · BR-RPT-03 to BR-RPT-06): GC-RPT-06 to GC-RPT-11 —
// cycle and decision time in business minutes, the lower median, bottlenecks, the heatmap cell, decisions outside DOA.

interface ReportCase {
  id: string
  title?: string
  fn: 'cycleMinutes' | 'decisionMinutes' | 'lowerMedian' | 'bottlenecks' | 'heatCell' | 'wrongDoa'
  input: unknown
  expect: unknown
}

const suite = loadYaml<{ calendar: { timezone: string; workdays: Weekday[]; start: string; end: string; holidays: string[] }; cases: ReportCase[] }>('workflow-reports.yaml')
const calendar: BusinessCalendar = suite.calendar
const d = (s: string) => new Date(s)

describe('[FR-VIS-101/AC1] golden workflow-reports.yaml', () => {
  it('has the cases of S6-20', () => expect(suite.cases.map((c) => c.id)).toEqual(['GC-RPT-06', 'GC-RPT-07', 'GC-RPT-08', 'GC-RPT-09', 'GC-RPT-10', 'GC-RPT-11']))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? c.fn}`, () => {
      const i = c.input as Record<string, unknown>
      switch (c.fn) {
        case 'cycleMinutes':
          return expect(cycleMinutes(d(i.from as string), d(i.to as string), calendar)).toBe(c.expect)
        case 'decisionMinutes':
          return expect(decisionMinutes(d(i.assignedAt as string), d(i.decidedAt as string), (i.pauses as Array<{ from: string; to: string }>).map((p) => ({ from: d(p.from), to: d(p.to) })), calendar)).toBe(c.expect)
        case 'lowerMedian':
          return expect(lowerMedian(c.input as number[])).toBe(c.expect)
        case 'bottlenecks':
          return expect(bottlenecks(c.input as Array<{ at: string; overdue: number; median: number }>).map((r) => r.at)).toEqual(c.expect)
        case 'heatCell':
          return expect(heatCell(d(i.at as string), calendar.timezone)).toEqual(c.expect)
        case 'wrongDoa':
          return expect(wrongDoa(i.decisions as Array<{ ref: string; decider: string; onBehalfOf?: string; expected: string[] }>).map((x) => x.ref)).toEqual(c.expect)
      }
    })
  }
  it('edges: no values, no median; a pause outside the task or with no median counts nothing', () => {
    expect(lowerMedian([])).toBeNull()
    expect(decisionMinutes(d('2026-10-05T02:00:00Z'), d('2026-10-05T03:00:00Z'), [{ from: d('2026-10-06T02:00:00Z'), to: d('2026-10-06T03:00:00Z') }], calendar)).toBe(60)
    expect(bottlenecks([{ overdue: 1, median: null }, { overdue: 1, median: 5 }]).map((r) => r.median)).toEqual([5, null])
  })
})

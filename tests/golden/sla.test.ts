import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addBusinessMinutes, businessMinutesBetween, remindAt, resumeDue, type BusinessCalendar, type Weekday } from '@/core/sla'
import { loadYaml } from './doa-fixtures'

// tests/golden/sla.yaml (spec §7.8): GC-SLA-01 to GC-SLA-08, then properties and edge branches of core/sla.

interface SlaCase {
  id: string
  title?: string
  fn: 'addBusinessMinutes' | 'businessMinutesBetween' | 'resumeDue' | 'remindAt'
  input: Record<string, string | number>
  expect: string | number
}

const suite = loadYaml<{ calendar: { timezone: string; workdays: Weekday[]; start: string; end: string; holidays: string[] }; cases: SlaCase[] }>('sla.yaml')
const calendar: BusinessCalendar = suite.calendar
const d = (s: string | number) => new Date(String(s))
const iso = (x: Date) => x.toISOString().replace('.000Z', 'Z')

describe('golden sla.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const i = c.input
      const actual =
        c.fn === 'addBusinessMinutes'
          ? iso(addBusinessMinutes(d(i.from!), Number(i.minutes), calendar))
          : c.fn === 'businessMinutesBetween'
            ? businessMinutesBetween(d(i.from!), d(i.to!), calendar)
            : c.fn === 'resumeDue'
              ? iso(resumeDue({ assignedAt: d(i.assignedAt!), slaMinutes: Number(i.slaMinutes), pausedAt: d(i.pausedAt!), resumedAt: d(i.resumedAt!) }, calendar))
              : iso(remindAt({ assignedAt: d(i.assignedAt!), slaMinutes: Number(i.slaMinutes), remindPct: Number(i.remindPct) }, calendar))
      expect(actual).toEqual(c.expect)
    })
  }
})

describe('[FR-INT-007/AC1] business time beyond the golden cases (BR-SLA-01 to BR-SLA-03)', () => {
  it('adds zero minutes by moving to the next opening only', () => {
    expect(iso(addBusinessMinutes(d('2026-10-05T03:00:00Z'), 0, calendar))).toBe('2026-10-05T03:00:00Z')
    expect(iso(addBusinessMinutes(d('2026-10-03T03:00:00Z'), 0, calendar))).toBe('2026-10-05T01:30:00Z')
    expect(iso(addBusinessMinutes(d('2026-10-05T00:00:00Z'), 30, calendar))).toBe('2026-10-05T02:00:00Z')
  })

  it('counts nothing for an empty or reversed period, and only open hours inside one day', () => {
    expect(businessMinutesBetween(d('2026-10-05T05:00:00Z'), d('2026-10-05T05:00:00Z'), calendar)).toBe(0)
    expect(businessMinutesBetween(d('2026-10-05T06:00:00Z'), d('2026-10-05T05:00:00Z'), calendar)).toBe(0)
    expect(businessMinutesBetween(d('2026-10-05T00:00:00Z'), d('2026-10-05T12:00:00Z'), calendar)).toBe(540)
  })

  it('gives the whole SLA back when the question came before any business time was used, and never less than zero', () => {
    const sat = d('2026-10-03T03:00:00Z')
    expect(iso(resumeDue({ assignedAt: sat, slaMinutes: 60, pausedAt: sat, resumedAt: d('2026-10-05T01:30:00Z') }, calendar))).toBe('2026-10-05T02:30:00Z')
    expect(iso(resumeDue({ assignedAt: d('2026-10-05T01:30:00Z'), slaMinutes: 60, pausedAt: d('2026-10-05T05:30:00Z'), resumedAt: d('2026-10-06T01:30:00Z') }, calendar))).toBe('2026-10-06T01:30:00Z')
  })

  it('rounds the reminder half up to whole minutes', () => {
    expect(iso(remindAt({ assignedAt: d('2026-10-05T01:30:00Z'), slaMinutes: 3, remindPct: 50 }, calendar))).toBe('2026-10-05T01:32:00Z')
  })

  it('refuses bad input and unusable calendars', () => {
    const from = d('2026-10-05T03:00:00Z')
    expect(() => addBusinessMinutes(from, -1, calendar)).toThrow(RangeError)
    expect(() => addBusinessMinutes(from, 1.5, calendar)).toThrow(RangeError)
    expect(() => addBusinessMinutes(from, 1, { ...calendar, start: '8:30' })).toThrow(RangeError)
    expect(() => addBusinessMinutes(from, 1, { ...calendar, start: '17:30', end: '08:30' })).toThrow(RangeError)
    expect(() => addBusinessMinutes(from, 1, { ...calendar, workdays: [] })).toThrow(RangeError)
    const everyDayOff = { ...calendar, workdays: ['MON' as const], holidays: [] }
    const mondays: string[] = []
    for (let t = Date.UTC(2026, 9, 5); t < Date.UTC(2037, 0, 1); t += 7 * 86_400_000) mondays.push(new Date(t).toISOString().slice(0, 10))
    expect(() => addBusinessMinutes(from, 1, { ...everyDayOff, holidays: mondays })).toThrow(RangeError)
    expect(() => businessMinutesBetween(from, d('2040-01-01T00:00:00Z'), calendar)).toThrow(RangeError)
  })

  it('adding the minutes between two instants inside business hours lands on the later one (1,000 samples)', () => {
    const workHours = fc.record({ day: fc.integer({ min: 0, max: 90 }), minute: fc.integer({ min: 0, max: 539 }) })
    const toInstant = (p: { day: number; minute: number }) => new Date(Date.UTC(2026, 9, 1 + p.day, 1, 30 + p.minute))
    fc.assert(
      fc.property(workHours, fc.integer({ min: 0, max: 20_000 }), (start, minutes) => {
        const from = toInstant(start)
        const due = addBusinessMinutes(from, minutes, calendar)
        expect(due.getTime()).toBeGreaterThanOrEqual(from.getTime())
        const opening = addBusinessMinutes(from, 0, calendar)
        expect(businessMinutesBetween(opening, due, calendar)).toBe(minutes)
      }),
      { numRuns: 1000 },
    )
  })
})

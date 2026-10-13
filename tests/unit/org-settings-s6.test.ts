import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { OrgSettingsSchema, S6_DEFAULTS, s6SettingsOf } from '@/lib/org-settings'
import { s6SettingsFromSheet } from '@/server/seed/settings-s6'
import { INPUT_WORKBOOKS, loadInputWorkbook, type InputWorkbook, type SheetRow } from '@/server/seed/workbook'

// S6-01 (docs/sub-specs/S6.md "Entity และ migration"): the S6 keys of Organization.settings are optional, so an
// organization saved before S6 (staging, the demo seed) parses unchanged and reads the defaults of the open questions;
// the phase-1 workbook sets them from sheet Settings.

const demoYaml = parseYaml(readFileSync('prisma/seed/org-settings.demo.yaml', 'utf8'))

function settingsSheet(rows: ReadonlyArray<readonly [key: string, value: string | null]>): InputWorkbook {
  const table: SheetRow[] = rows.map(([key, value], i) => ({ row: i + 3, values: { key, value } }))
  return {
    hasSheet: (sheet) => sheet === 'Settings',
    table: () => table,
    keyValues: () => new Map(table.map(({ row, values }) => [values.key!, { value: values.value ?? null, row }])),
  }
}

describe('[FR-PLT-001/AC2] S6 settings keys are optional with defaults', () => {
  it('settings without the S6 keys (the demo organization) parse and read every default', () => {
    const parsed = OrgSettingsSchema.parse(demoYaml)
    expect(parsed.duplicateCheck).toBeUndefined()
    expect(parsed.numbering.BT).toBeUndefined()
    expect(s6SettingsOf(parsed)).toEqual(S6_DEFAULTS)
    expect(S6_DEFAULTS).toMatchObject({
      duplicateWindowDays: 7,
      priceRefWindowDays: 365,
      priceRefMinSamples: 3,
      budgetAlertThresholdsBp: [8000, 10000],
      budgetForecastMinElapsedDays: 30,
      overrunLapseDays: 14,
      renewalMilestoneDays: [60, 30],
      numberingBT: { pattern: 'BT-{BE}-{SEQ5}', reset: 'YEARLY' },
      numberingOB: { pattern: 'OB-{BE}-{SEQ5}', reset: 'YEARLY' },
    })
  })

  it('a set key wins over its default, the keys left out keep theirs', () => {
    const settings = OrgSettingsSchema.parse({ ...demoYaml, duplicateCheck: { windowDays: 14 }, budget: { overrunLapseDays: 30 } })
    expect(s6SettingsOf(settings)).toEqual({ ...S6_DEFAULTS, duplicateWindowDays: 14, overrunLapseDays: 30 })
  })

  it('refuses values out of range and unknown keys', () => {
    for (const bad of [
      { duplicateCheck: { windowDays: 0 } },
      { priceRef: { minSamples: 1.5 } },
      { budget: { alertThresholdsBp: [] } },
      { budget: { alertThresholdsBp: [0] } },
      { renewal: { milestoneDays: [-30] } },
      { budget: { carryOver: true } },
      { numbering: { ...demoYaml.numbering, BT: { pattern: '' , reset: 'YEARLY' } } },
    ]) {
      expect(OrgSettingsSchema.safeParse({ ...demoYaml, ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('stored settings that are not an object, or a broken key, read the defaults instead of a guess', () => {
    expect(s6SettingsOf(null)).toEqual(S6_DEFAULTS)
    expect(s6SettingsOf({ duplicateCheck: { windowDays: 'seven' }, numbering: { BT: { pattern: 'X-{SEQ3}' } } })).toEqual(S6_DEFAULTS)
  })
})

describe('[FR-PLT-001/AC2] the seed reads the S6 rows of sheet Settings', () => {
  const base = OrgSettingsSchema.parse(demoYaml)

  it('a sheet without S6 rows keeps the settings as they are', () => {
    expect(s6SettingsFromSheet(settingsSheet([['vatRate', '0.07']]), base)).toBe(base)
  })

  it('reads numbers, lists and the number patterns with the reset of numbering.reset', () => {
    const read = s6SettingsFromSheet(
      settingsSheet([
        ['numbering.reset', 'MONTHLY'],
        ['duplicateCheck.windowDays', '10'],
        ['budget.alertThresholdsBp', '7000, 9000,10000'],
        ['numbering.OB', 'OB-{BE}-{SEQ4}'],
      ]),
      base,
    )
    expect(s6SettingsOf(read)).toEqual({ ...S6_DEFAULTS, duplicateWindowDays: 10, budgetAlertThresholdsBp: [7000, 9000, 10000], numberingOB: { pattern: 'OB-{BE}-{SEQ4}', reset: 'MONTHLY' } })
    expect(read.numbering.PR).toEqual(base.numbering.PR)
  })

  it('stops with the row named for a value it cannot read', () => {
    expect(() => s6SettingsFromSheet(settingsSheet([['priceRef.minSamples', 'สาม']]), base)).toThrow(/แถว 3 \(priceRef\.minSamples\).*จำนวนเต็มบวก/)
    expect(() => s6SettingsFromSheet(settingsSheet([['renewal.milestoneDays', null]]), base)).toThrow(/แถว 3.*ว่าง/)
    expect(() => s6SettingsFromSheet(settingsSheet([['duplicateCheck.windowDays', '0']]), base)).toThrow(/ค่าตั้งของ S6 ใช้ไม่ได้/)
  })

  it('the phase-1 workbook sets every S6 key; the demo workbook sets none', async () => {
    const p1 = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const read = s6SettingsFromSheet(p1, base)
    expect(read.duplicateCheck).toEqual({ windowDays: 7 })
    expect(read.priceRef).toEqual({ windowDays: 365, minSamples: 3 })
    expect(read.budget).toEqual({ alertThresholdsBp: [8000, 10000], forecastMinElapsedDays: 30, overrunLapseDays: 14 })
    expect(read.renewal).toEqual({ milestoneDays: [60, 30] })
    expect(read.numbering.BT).toEqual({ pattern: 'BT-{BE}-{SEQ5}', reset: 'YEARLY' })
    expect(read.numbering.OB).toEqual({ pattern: 'OB-{BE}-{SEQ5}', reset: 'YEARLY' })
    const demo = await loadInputWorkbook(INPUT_WORKBOOKS.demo)
    expect(s6SettingsFromSheet(demo, base)).toBe(base)
  })
})

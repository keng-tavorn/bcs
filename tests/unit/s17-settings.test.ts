import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { BCS_GO_DEFAULTS, bcsGoSettingsOf, CHAT_INTAKE_DEFAULTS, chatIntakeSettingsOf, S17_SETTING_LIMITS } from '@/lib/s17-settings'
import { s17SettingsFromSheet } from '@/server/seed/settings-s17'
import { INPUT_WORKBOOKS, loadInputWorkbook, type InputWorkbook, type SheetRow } from '@/server/seed/workbook'

// S17-01 (docs/sub-specs/S17.md "Entity และ migration"): settings.chatIntake and settings.bcsGo are optional, so an
// organization saved before S17 (the demo organization, staging) parses unchanged and keeps asking through the chat
// switched off; the phase-1 workbook turns it on for SIMEC through sheet Settings. The seed wiring and appPush are in
// tests/integration/s17-schema.test.ts.

const demoYaml = readFileSync('prisma/seed/org-settings.demo.yaml', 'utf8')
const demo = () => parseYaml(demoYaml) as Record<string, unknown>

function settingsSheet(rows: ReadonlyArray<readonly [key: string, value: string | null]>): InputWorkbook {
  const table: SheetRow[] = rows.map(([key, value], i) => ({ row: i + 3, values: { key, value } }))
  return {
    hasSheet: (sheet) => sheet === 'Settings',
    table: () => table,
    keyValues: () => new Map(table.map(({ row, values }) => [values.key!, { value: values.value ?? null, row }])),
  }
}

describe('[FR-PLT-001/AC2] the S17 settings are optional with defaults', () => {
  it('settings without them (the demo organization) parse, and asking through the chat stays off', () => {
    const parsed = OrgSettingsSchema.parse(demo())
    expect(parsed.chatIntake).toBeUndefined()
    expect(parsed.bcsGo).toBeUndefined()
    expect(chatIntakeSettingsOf(parsed)).toEqual(CHAT_INTAKE_DEFAULTS)
    expect(bcsGoSettingsOf(parsed)).toEqual(BCS_GO_DEFAULTS)
    expect(CHAT_INTAKE_DEFAULTS).toEqual({ enabled: false, windowMinutes: 30, maxImages: 10, maxTextChars: 2000, hourlyLimit: 20, expireHours: 24, textRetentionDays: 7 })
    expect(BCS_GO_DEFAULTS).toEqual({ offlineRetentionDays: 7, maxPreparedPos: 50 })
  })

  it('a set key wins over its default, the keys left out keep theirs', () => {
    const settings = OrgSettingsSchema.parse({ ...demo(), chatIntake: { enabled: true, windowMinutes: 15 }, bcsGo: { maxPreparedPos: 20 } })
    expect(chatIntakeSettingsOf(settings)).toEqual({ ...CHAT_INTAKE_DEFAULTS, enabled: true, windowMinutes: 15 })
    expect(bcsGoSettingsOf(settings)).toEqual({ ...BCS_GO_DEFAULTS, maxPreparedPos: 20 })
  })

  it('takes each highest value and refuses one more, zero, fractions, text and unknown keys', () => {
    for (const [section, keys] of [
      ['chatIntake', ['windowMinutes', 'maxImages', 'maxTextChars', 'hourlyLimit', 'expireHours', 'textRetentionDays']],
      ['bcsGo', ['offlineRetentionDays', 'maxPreparedPos']],
    ] as const) {
      for (const key of keys) {
        const max = S17_SETTING_LIMITS[key]
        expect(OrgSettingsSchema.safeParse({ ...demo(), [section]: { [key]: max } }).success, `${key} ${max}`).toBe(true)
        for (const bad of [max + 1, 0, 1.5, String(max)]) {
          expect(OrgSettingsSchema.safeParse({ ...demo(), [section]: { [key]: bad } }).success, `${key} ${bad}`).toBe(false)
        }
      }
    }
    // the database CHECKs of the S17 migration and BR-APP-10
    expect(S17_SETTING_LIMITS).toMatchObject({ maxImages: 10, maxTextChars: 2000, offlineRetentionDays: 30 })
    expect(OrgSettingsSchema.safeParse({ ...demo(), chatIntake: { enabled: 'Y' } }).success).toBe(false)
    expect(OrgSettingsSchema.safeParse({ ...demo(), chatIntake: { inGroups: true } }).success).toBe(false)
    expect(OrgSettingsSchema.safeParse({ ...demo(), bcsGo: { encryptQueue: true } }).success).toBe(false)
  })

  it('stored settings that are not an object, or a broken key, read the default of that key instead of a guess', () => {
    expect(chatIntakeSettingsOf(null)).toEqual(CHAT_INTAKE_DEFAULTS)
    expect(chatIntakeSettingsOf({ chatIntake: 'on' })).toEqual(CHAT_INTAKE_DEFAULTS)
    expect(chatIntakeSettingsOf({ chatIntake: { enabled: 'true', maxImages: 50, hourlyLimit: 5 } })).toEqual({ ...CHAT_INTAKE_DEFAULTS, hourlyLimit: 5 })
    expect(bcsGoSettingsOf({ bcsGo: { offlineRetentionDays: 31, maxPreparedPos: 10 } })).toEqual({ ...BCS_GO_DEFAULTS, maxPreparedPos: 10 })
  })

  it('scripts/validate_inputs.py checks the workbook against the same highest values', () => {
    const line = readFileSync('scripts/validate_inputs.py', 'utf8').match(/^S17_MAX = (\{.*\})$/m)
    expect(line, 'S17_MAX in scripts/validate_inputs.py').not.toBeNull()
    const python = JSON.parse(line![1]!.replaceAll("'", '"')) as Record<string, number>
    const limits = Object.fromEntries(Object.entries(S17_SETTING_LIMITS).map(([k, v]) => [`${k in BCS_GO_DEFAULTS ? 'bcsGo' : 'chatIntake'}.${k}`, v]))
    expect(python).toEqual(limits)
  })
})

describe('[FR-PLT-001/AC2] the seed reads the S17 rows of sheet Settings', () => {
  const base = OrgSettingsSchema.parse(demo())

  it('a sheet without S17 rows keeps the settings as they are', () => {
    expect(s17SettingsFromSheet(settingsSheet([['vatRate', '0.07']]), base)).toBe(base)
  })

  it('reads Y and N and the whole numbers into chatIntake and bcsGo', () => {
    const read = s17SettingsFromSheet(
      settingsSheet([
        ['chatIntake.enabled', 'Y'],
        ['chatIntake.windowMinutes', '45'],
        ['bcsGo.offlineRetentionDays', ' 14 '],
      ]),
      base,
    )
    expect(read.chatIntake).toEqual({ enabled: true, windowMinutes: 45 })
    expect(read.bcsGo).toEqual({ offlineRetentionDays: 14 })
    expect(s17SettingsFromSheet(settingsSheet([['chatIntake.enabled', 'N']]), base).chatIntake).toEqual({ enabled: false })
  })

  it('stops with a Thai message naming the row when a value cannot be read exactly', () => {
    expect(() => s17SettingsFromSheet(settingsSheet([['chatIntake.enabled', 'yes']]), base)).toThrow(/แถว 3 \(chatIntake\.enabled\).*Y หรือ N/)
    expect(() => s17SettingsFromSheet(settingsSheet([['vatRate', '0.07'], ['chatIntake.maxImages', '2.5']]), base)).toThrow(/แถว 4 \(chatIntake\.maxImages\)/)
    expect(() => s17SettingsFromSheet(settingsSheet([['bcsGo.maxPreparedPos', null]]), base)).toThrow(/ว่าง/)
    expect(() => s17SettingsFromSheet(settingsSheet([['chatIntake.maxImages', '11']]), base)).toThrow(/ค่าตั้งของ S17/)
  })

  it('the demo workbook has no S17 rows; the phase-1 workbook turns the chat on for SIMEC with the defaults of the OQs', async () => {
    expect(s17SettingsFromSheet(await loadInputWorkbook(INPUT_WORKBOOKS.demo), base)).toBe(base)
    const p1 = s17SettingsFromSheet(await loadInputWorkbook(INPUT_WORKBOOKS.p1), base)
    expect(chatIntakeSettingsOf(p1)).toEqual({ ...CHAT_INTAKE_DEFAULTS, enabled: true })
    expect(bcsGoSettingsOf(p1)).toEqual(BCS_GO_DEFAULTS)
  })
})


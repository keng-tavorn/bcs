import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import type { InputWorkbook } from './workbook'

// The S17 keys of sheet Settings (docs/sub-specs/S17.md "การอ่านชีตของไฟล์ระยะ 1", S17-01) over the settings file. The
// phase-1 workbook has these rows and turns asking through the chat on for SIMEC; the demo workbook has none, so the
// demo organization keeps the defaults in code (chatIntakeSettingsOf: off). A row that cannot be read exactly stops the
// seed with a Thai message naming the row, for the person to fix scripts/inputs_p1 (the agent never edits the workbook).

const SHEET = 'Settings'
/** Y or N */
const SWITCH_KEYS = ['chatIntake.enabled'] as const
/** Whole numbers, one per key; the bounds are the schema's (src/lib/s17-settings.ts) */
const NUMBER_KEYS = [
  'chatIntake.windowMinutes',
  'chatIntake.maxImages',
  'chatIntake.maxTextChars',
  'chatIntake.hourlyLimit',
  'chatIntake.expireHours',
  'chatIntake.textRetentionDays',
  'bcsGo.offlineRetentionDays',
  'bcsGo.maxPreparedPos',
] as const
const S17_KEYS: readonly string[] = [...SWITCH_KEYS, ...NUMBER_KEYS]

/** `base` with the S17 rows of sheet Settings set; rows of other keys are read elsewhere */
export function s17SettingsFromSheet(workbook: InputWorkbook, base: OrgSettings): OrgSettings {
  if (!workbook.hasSheet(SHEET)) return base
  const rows = workbook.keyValues(SHEET)
  if (!S17_KEYS.some((k) => rows.has(k))) return base
  const value = (key: string): { text: string; at: string } | null => {
    const found = rows.get(key)
    if (!found) return null
    const at = `ชีต ${SHEET} แถว ${found.row} (${key})`
    if (found.value === null) throw new Error(`${at}: ช่องค่าที่ใช้ (value) ว่าง ใส่ค่า หรือลบแถวนี้ออก`)
    return { text: found.value.trim(), at }
  }

  const sections: Record<'chatIntake' | 'bcsGo', Record<string, unknown>> = { chatIntake: {}, bcsGo: {} }
  const set = (key: string, v: unknown) => {
    const [section, name] = key.split('.') as ['chatIntake' | 'bcsGo', string]
    sections[section][name] = v
  }
  for (const key of SWITCH_KEYS) {
    const v = value(key)
    if (!v) continue
    if (v.text !== 'Y' && v.text !== 'N') throw new Error(`${v.at}: "${v.text}" ต้องเป็น Y หรือ N`)
    set(key, v.text === 'Y')
  }
  for (const key of NUMBER_KEYS) {
    const v = value(key)
    if (!v) continue
    if (!/^\d+$/.test(v.text)) throw new Error(`${v.at}: "${v.text}" ต้องเป็นจำนวนเต็มบวก`)
    set(key, Number(v.text))
  }

  const merged = {
    ...base,
    ...(Object.keys(sections.chatIntake).length ? { chatIntake: { ...base.chatIntake, ...sections.chatIntake } } : {}),
    ...(Object.keys(sections.bcsGo).length ? { bcsGo: { ...base.bcsGo, ...sections.bcsGo } } : {}),
  }
  const parsed = OrgSettingsSchema.safeParse(merged)
  if (!parsed.success) throw new Error(`ชีต ${SHEET}: ค่าตั้งของ S17 ใช้ไม่ได้ (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`)
  return parsed.data
}

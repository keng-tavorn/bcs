import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import type { InputWorkbook } from './workbook'

// The S6 keys of sheet Settings (docs/sub-specs/S6.md "การอ่านชีตของไฟล์ระยะ 1", S6-01) over the settings file. The
// phase-1 workbook has these rows; the demo workbook has none, so the demo organization keeps the defaults in code
// (s6SettingsOf). A row that cannot be read exactly stops the seed with a Thai message naming the row, for the person
// to fix scripts/inputs_p1 (the agent never edits the workbook).

const SHEET = 'Settings'
/** Whole numbers, one per key */
const NUMBER_KEYS = ['duplicateCheck.windowDays', 'priceRef.windowDays', 'priceRef.minSamples', 'budget.forecastMinElapsedDays', 'budget.overrunLapseDays'] as const
/** Comma-separated whole numbers */
const LIST_KEYS = ['budget.alertThresholdsBp', 'renewal.milestoneDays'] as const
/** Number patterns; the reset is the row numbering.reset (YEARLY when it is missing) */
const PATTERN_KEYS = ['numbering.BT', 'numbering.OB'] as const
const S6_KEYS: readonly string[] = [...NUMBER_KEYS, ...LIST_KEYS, ...PATTERN_KEYS]

function wholeNumber(text: string, at: string): number {
  if (!/^\d+$/.test(text.trim())) throw new Error(`${at}: "${text}" ต้องเป็นจำนวนเต็มบวก`)
  return Number(text.trim())
}

/** `base` with the S6 rows of sheet Settings set; rows of other keys are read elsewhere */
export function s6SettingsFromSheet(workbook: InputWorkbook, base: OrgSettings): OrgSettings {
  const rows = workbook.keyValues(SHEET)
  const value = (key: string): { text: string; at: string } | null => {
    const found = rows.get(key)
    if (!found) return null
    const at = `ชีต ${SHEET} แถว ${found.row} (${key})`
    if (found.value === null) throw new Error(`${at}: ช่องค่าที่ใช้ (value) ว่าง ใส่ค่า หรือลบแถวนี้ออก`)
    return { text: found.value, at }
  }
  if (!S6_KEYS.some((k) => rows.has(k))) return base

  const sections: Record<string, Record<string, unknown>> = {}
  const set = (key: string, v: unknown) => {
    const [section, name] = key.split('.') as [string, string]
    sections[section] = { ...(sections[section] ?? {}), [name]: v }
  }
  for (const key of NUMBER_KEYS) {
    const v = value(key)
    if (v) set(key, wholeNumber(v.text, v.at))
  }
  for (const key of LIST_KEYS) {
    const v = value(key)
    if (v) set(key, v.text.split(',').map((part) => wholeNumber(part, v.at)))
  }
  const reset = value('numbering.reset')?.text ?? 'YEARLY'
  const numbering: Record<string, unknown> = { ...base.numbering }
  for (const key of PATTERN_KEYS) {
    const v = value(key)
    if (v) numbering[key.slice('numbering.'.length)] = { pattern: v.text, reset }
  }

  const merged = {
    ...base,
    numbering,
    duplicateCheck: { ...base.duplicateCheck, ...sections.duplicateCheck },
    priceRef: { ...base.priceRef, ...sections.priceRef },
    budget: { ...base.budget, ...sections.budget },
    renewal: { ...base.renewal, ...sections.renewal },
  }
  const parsed = OrgSettingsSchema.safeParse(merged)
  if (!parsed.success) throw new Error(`ชีต ${SHEET}: ค่าตั้งของ S6 ใช้ไม่ได้ (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`)
  return parsed.data
}

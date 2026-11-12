import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import type { InputWorkbook } from './workbook'

// The S11 keys of sheet Settings (docs/sub-specs/S11.md "การอ่านชีตของไฟล์ระยะ 1", S11-12) over the settings file: the
// keys of settings.risk that do not decide the gate (OQ-224 OQ-228 OQ-230 · BR-RSK-17) and the patterns of the numbers of
// an assessment and an override (numbering.RSA numbering.RO · OQ-12). What decides the gate is the confirmed RiskPolicy
// row of sheet Risk_Policy (BR-RSK-02), never settings. The demo workbook has none of these rows, so the demo
// organization keeps the defaults in code (riskSettingsOf). A row that cannot be read exactly stops the seed with a Thai
// message naming the row, for the person to fix scripts/inputs_p1.

const SHEET = 'Settings'
const SWITCH_KEYS = ['risk.aiAssist', 'risk.portalAnswering'] as const
const NUMBER_KEYS = ['risk.overrideMaxDays', 'risk.answerRetentionYears'] as const
const NUMBERING_KEYS = ['numbering.RSA', 'numbering.RO'] as const
const S11_KEYS: readonly string[] = [...SWITCH_KEYS, ...NUMBER_KEYS, ...NUMBERING_KEYS]

/** `base` with the S11 rows of sheet Settings set; rows of other keys are read elsewhere */
export function s11SettingsFromSheet(workbook: InputWorkbook, base: OrgSettings): OrgSettings {
  if (!workbook.hasSheet(SHEET)) return base
  const rows = workbook.keyValues(SHEET)
  if (!S11_KEYS.some((k) => rows.has(k))) return base
  const value = (key: string): { text: string; at: string } | null => {
    const found = rows.get(key)
    if (!found) return null
    const at = `ชีต ${SHEET} แถว ${found.row} (${key})`
    if (found.value === null) throw new Error(`${at}: ช่องค่าที่ใช้ (value) ว่าง ใส่ค่า หรือลบแถวนี้ออก`)
    return { text: found.value.trim(), at }
  }

  const risk: Record<string, unknown> = { ...base.risk }
  for (const key of SWITCH_KEYS) {
    const v = value(key)
    if (!v) continue
    if (v.text !== 'Y' && v.text !== 'N') throw new Error(`${v.at}: "${v.text}" ต้องเป็น Y หรือ N`)
    risk[key.slice('risk.'.length)] = v.text === 'Y'
  }
  for (const key of NUMBER_KEYS) {
    const v = value(key)
    if (!v) continue
    if (!/^\d+$/.test(v.text)) throw new Error(`${v.at}: "${v.text}" ต้องเป็นจำนวนเต็มไม่ติดลบ`)
    risk[key.slice('risk.'.length)] = Number(v.text)
  }
  const numbering: Record<string, unknown> = { ...base.numbering }
  for (const key of NUMBERING_KEYS) {
    const v = value(key)
    if (v) numbering[key.slice('numbering.'.length)] = { pattern: v.text, reset: value('numbering.reset')?.text ?? 'YEARLY' }
  }

  const parsed = OrgSettingsSchema.safeParse({ ...base, risk, numbering })
  if (!parsed.success) throw new Error(`ชีต ${SHEET}: ค่าตั้งของ S11 ใช้ไม่ได้ (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`)
  return parsed.data
}

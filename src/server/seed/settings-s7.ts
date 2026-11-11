import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import type { InputWorkbook } from './workbook'

// The S7 keys of sheet Settings (docs/sub-specs/S7.md "การอ่านชีตของไฟล์ระยะ 1", S7-13) over the settings file: the
// supplier portal's links, codes, sessions, the application's SLA and retention (settings.supplier · OQ-181 to OQ-192)
// and the pattern of the application's number (numbering.SUP). The phase-1 workbook has these rows; the demo workbook
// has none, so the demo organization keeps the defaults in code (supplierSettingsOf). A row that cannot be read exactly
// stops the seed with a Thai message naming the row, for the person to fix scripts/inputs_p1.

const SHEET = 'Settings'
const SWITCH_KEYS = ['supplier.selfRegistration', 'supplier.aiAssist', 'supplier.portalInvoice'] as const
const NUMBER_KEYS = [
  'supplier.inviteLinkDays',
  'supplier.loginLinkMinutes',
  'supplier.otpMinutes',
  'supplier.otpMaxAttempts',
  'supplier.otpLockMinutes',
  'supplier.sessionIdleMinutes',
  'supplier.sessionMaxHours',
  'supplier.applicationReminderBusinessDays',
  'supplier.applicationEscalateBusinessDays',
  'supplier.applicationExpireDays',
  'supplier.closedApplicationFileRetentionDays',
  'supplier.contactRetentionDays',
  'supplier.newContactBankHoldBusinessDays',
] as const
const S7_KEYS: readonly string[] = ['supplier.otpChannel', ...SWITCH_KEYS, ...NUMBER_KEYS, 'numbering.SUP']

/** `base` with the S7 rows of sheet Settings set; rows of other keys are read elsewhere */
export function s7SettingsFromSheet(workbook: InputWorkbook, base: OrgSettings): OrgSettings {
  if (!workbook.hasSheet(SHEET)) return base
  const rows = workbook.keyValues(SHEET)
  if (!S7_KEYS.some((k) => rows.has(k))) return base
  const value = (key: string): { text: string; at: string } | null => {
    const found = rows.get(key)
    if (!found) return null
    const at = `ชีต ${SHEET} แถว ${found.row} (${key})`
    if (found.value === null) throw new Error(`${at}: ช่องค่าที่ใช้ (value) ว่าง ใส่ค่า หรือลบแถวนี้ออก`)
    return { text: found.value.trim(), at }
  }

  const supplier: Record<string, unknown> = { ...base.supplier }
  const channel = value('supplier.otpChannel')
  if (channel) {
    if (channel.text !== 'EMAIL' && channel.text !== 'SMS') throw new Error(`${channel.at}: "${channel.text}" ต้องเป็น EMAIL หรือ SMS`)
    supplier.otpChannel = channel.text
  }
  for (const key of SWITCH_KEYS) {
    const v = value(key)
    if (!v) continue
    if (v.text !== 'Y' && v.text !== 'N') throw new Error(`${v.at}: "${v.text}" ต้องเป็น Y หรือ N`)
    supplier[key.slice('supplier.'.length)] = v.text === 'Y'
  }
  for (const key of NUMBER_KEYS) {
    const v = value(key)
    if (!v) continue
    if (!/^\d+$/.test(v.text)) throw new Error(`${v.at}: "${v.text}" ต้องเป็นจำนวนเต็มไม่ติดลบ`)
    supplier[key.slice('supplier.'.length)] = Number(v.text)
  }
  const numbering: Record<string, unknown> = { ...base.numbering }
  const sup = value('numbering.SUP')
  if (sup) numbering.SUP = { pattern: sup.text, reset: value('numbering.reset')?.text ?? 'YEARLY' }

  const parsed = OrgSettingsSchema.safeParse({ ...base, supplier, numbering })
  if (!parsed.success) throw new Error(`ชีต ${SHEET}: ค่าตั้งของ S7 ใช้ไม่ได้ (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`)
  return parsed.data
}

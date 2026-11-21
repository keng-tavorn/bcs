import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import type { InputWorkbook } from './workbook'

// The S10 keys of sheet Settings (docs/sub-specs/S10.md "การอ่านชีตของไฟล์ระยะ 1", S10-14) over the settings file:
// sourcing's opening days, question cutoff, bid validity, sealed bids, bids with VAT, invitations above the threshold,
// evaluators, price flags, preferred and agreed days and AI help (settings.sourcing · OQ-08 OQ-201 to OQ-212), and the
// patterns of the RFx's and the award's numbers (numbering.RFX numbering.AWD). The phase-1 workbook has these rows; the
// demo workbook has none, so the demo organization keeps the defaults in code (sourcingSettingsOf). A row that cannot
// be read exactly stops the seed with a Thai message naming the row, for the person to fix scripts/inputs_p1.

const SHEET = 'Settings'
const PREFIX = 'sourcing.'
const KINDS = ['RFQ', 'RFP', 'RFI'] as const
const SWITCH_KEYS = ['sourcing.sealedBids', 'sourcing.allowVatInclusiveBids', 'sourcing.aiAssist'] as const
const NUMBER_KEYS = [
  'sourcing.questionCutoffBusinessDays',
  'sourcing.bidValidityDays',
  'sourcing.minInvitesAboveThreshold',
  'sourcing.minEvaluators',
  'sourcing.priceAnomalyBp',
  'sourcing.preferredSupplierDays',
  'sourcing.agreementFromAwardDays',
] as const
const THRESHOLD_KEY = 'sourcing.minInvitesThresholdGross'
const S10_KEYS: readonly string[] = [...KINDS.map((k) => `sourcing.minOpenBusinessDays.${k}`), ...SWITCH_KEYS, ...NUMBER_KEYS, THRESHOLD_KEY, 'numbering.RFX', 'numbering.AWD']

/** `base` with the S10 rows of sheet Settings set; rows of other keys are read elsewhere */
export function s10SettingsFromSheet(workbook: InputWorkbook, base: OrgSettings): OrgSettings {
  if (!workbook.hasSheet(SHEET)) return base
  const rows = workbook.keyValues(SHEET)
  if (!S10_KEYS.some((k) => rows.has(k))) return base
  const value = (key: string): { text: string; at: string } | null => {
    const found = rows.get(key)
    if (!found) return null
    const at = `ชีต ${SHEET} แถว ${found.row} (${key})`
    if (found.value === null) throw new Error(`${at}: ช่องค่าที่ใช้ (value) ว่าง ใส่ค่า หรือลบแถวนี้ออก`)
    return { text: found.value.trim(), at }
  }
  const whole = (key: string): number | null => {
    const v = value(key)
    if (!v) return null
    if (!/^\d+$/.test(v.text)) throw new Error(`${v.at}: "${v.text}" ต้องเป็นจำนวนเต็มไม่ติดลบ`)
    return Number(v.text)
  }

  const sourcing: Record<string, unknown> = { ...base.sourcing }
  const days: Record<string, number> = { ...base.sourcing?.minOpenBusinessDays }
  for (const kind of KINDS) {
    const n = whole(`sourcing.minOpenBusinessDays.${kind}`)
    if (n !== null) days[kind] = n
  }
  if (Object.keys(days).length) sourcing.minOpenBusinessDays = days
  for (const key of SWITCH_KEYS) {
    const v = value(key)
    if (!v) continue
    if (v.text !== 'Y' && v.text !== 'N') throw new Error(`${v.at}: "${v.text}" ต้องเป็น Y หรือ N`)
    sourcing[key.slice(PREFIX.length)] = v.text === 'Y'
  }
  for (const key of NUMBER_KEYS) {
    const n = whole(key)
    if (n !== null) sourcing[key.slice(PREFIX.length)] = n
  }
  const threshold = value(THRESHOLD_KEY)
  if (threshold) {
    // whole baht or baht and satang in the sheet; settings keep baht with 2 decimals (BR-MONEY-01)
    const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(threshold.text)
    if (!m) throw new Error(`${threshold.at}: "${threshold.text}" ต้องเป็นจำนวนเงินบาท เช่น 100000`)
    sourcing.minInvitesThresholdGross = `${m[1]}.${(m[2] ?? '').padEnd(2, '0')}`
  }
  const numbering: Record<string, unknown> = { ...base.numbering }
  for (const doc of ['RFX', 'AWD'] as const) {
    const v = value(`numbering.${doc}`)
    if (v) numbering[doc] = { pattern: v.text, reset: value('numbering.reset')?.text ?? 'YEARLY' }
  }

  const parsed = OrgSettingsSchema.safeParse({ ...base, sourcing, numbering })
  if (!parsed.success) throw new Error(`ชีต ${SHEET}: ค่าตั้งของ S10 ใช้ไม่ได้ (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`)
  return parsed.data
}

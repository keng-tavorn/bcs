import { EXPRESS_FIELDS, OrgSettingsSchema, type ExpressField, type OrgSettings } from '@/lib/org-settings'
import type { InputWorkbook } from './workbook'

// The Express file layout of the demo organization, from sheet Settings of docs/inputs/BCS_inputs_v1_demo.xlsx (spec
// S4-09, BR-EXP-01, OQ-10, P0-10). Nobody guesses the layout (§7.13, §17.3, ADR-011): until the customer's sample import
// file arrives the sheet has no column rows, the mapping stays empty and the export is refused with MAPPING_NOT_SET.
// The person filling in the workbook adds one row per column of the file:
//   key express.column.01, express.column.02, …   value <column header>=<field>, e.g. เลขที่ใบกำกับ=invoiceNo
// The columns follow the numbers of their keys and each field is one of EXPRESS_FIELDS (src/lib/org-settings.ts). The
// rows express.fileType, express.encoding and express.dateFormat set the rest of the layout; a row left out keeps the
// value of prisma/seed/org-settings.demo.yaml. Whatever cannot be read exactly stops the seed with a Thai message naming
// the row, for the person to fix the sheet in Excel (the agent never edits the workbook).

type ExpressSettings = OrgSettings['express']

const SHEET = 'Settings'
const PREFIX = 'express.'
/** Two digits, 01 to 99: the column's place in the file */
const COLUMN_KEY = /^express\.column\.(\d{2})$/
const EXAMPLE = 'เลขที่ใบกำกับ=invoiceNo'
const LAYOUT = OrgSettingsSchema.shape.express
const HEADER = LAYOUT.shape.mapping.element.shape.header
const KNOWN_KEYS = 'express.column.01 ถึง express.column.99 (คอลัมน์ของไฟล์ตามลำดับ) express.fileType express.encoding และ express.dateFormat (ตัวพิมพ์เล็กใหญ่ตามนี้)'

interface Column {
  /** The number of the key: the column's place in the file */
  readonly place: number
  readonly header: string
  readonly field: ExpressField
}

function oneOf<T extends string>(allowed: readonly T[], value: string, at: string): T {
  const found = allowed.find((a) => a === value)
  if (found === undefined) throw new Error(`${at}: "${value}" ใช้ไม่ได้ ใส่ได้เฉพาะ ${allowed.join(' หรือ ')}`)
  return found
}

/** "<column header>=<field>": the header is everything before the last "=", so a header may hold "=" itself */
function columnOf(value: string, at: string): Omit<Column, 'place'> {
  const split = value.lastIndexOf('=')
  if (split < 0) throw new Error(`${at}: "${value}" ไม่มีเครื่องหมาย = ใส่เป็น <หัวคอลัมน์>=<ชื่อข้อมูล> เช่น ${EXAMPLE}`)
  const header = value.slice(0, split).trim()
  const name = value.slice(split + 1).trim()
  if (!HEADER.safeParse(header).success) throw new Error(`${at}: หัวคอลัมน์ (ข้อความก่อนเครื่องหมาย =) ต้องยาว ${HEADER.minLength} ถึง ${HEADER.maxLength} ตัวอักษร เช่น ${EXAMPLE}`)
  if (name === '') throw new Error(`${at}: ยังไม่มีชื่อข้อมูลหลังเครื่องหมาย = เช่น ${EXAMPLE} ชื่อข้อมูลที่ใช้ได้: ${EXPRESS_FIELDS.join(', ')}`)
  const field = EXPRESS_FIELDS.find((f) => f === name)
  if (field === undefined) {
    // Never taken as the field it resembles: the person confirms it in the sheet
    const close = EXPRESS_FIELDS.find((f) => f.toLowerCase() === name.toLowerCase())
    const hint = close ? ` (ถ้าหมายถึง ${close} ให้พิมพ์ตัวพิมพ์เล็กใหญ่ให้ตรงกัน)` : ''
    throw new Error(`${at}: "${name}" ไม่ใช่ชื่อข้อมูลที่ระบบรู้จัก${hint} ชื่อข้อมูลที่ใช้ได้: ${EXPRESS_FIELDS.join(', ')}`)
  }
  return { header, field }
}

/**
 * The Express layout of sheet Settings over `base` (the demo settings file): the column rows replace its mapping when
 * there is at least one; without any, its mapping stays as it is (empty until the customer's sample file, OQ-10).
 * Throws a Thai message naming the sheet row for a key it does not know, a key given twice, an empty value, a value
 * that is not <header>=<field>, a field outside EXPRESS_FIELDS, or a file type, encoding or date format it does not take.
 */
export function expressLayoutFromSheet(workbook: InputWorkbook, base: ExpressSettings): ExpressSettings {
  const rowOfKey = new Map<string, number>()
  const columns: Column[] = []
  let { fileType, encoding, dateFormat } = base
  for (const { row, values } of workbook.table(SHEET)) {
    const key = values.key ?? null
    // Other settings of the sheet are read elsewhere; a key that only differs in case is still the Express layout's
    if (key === null || !key.toLowerCase().startsWith(PREFIX)) continue
    const at = `ชีต ${SHEET} แถว ${row} (${key})`
    const earlier = rowOfKey.get(key)
    if (earlier !== undefined) throw new Error(`${at}: ชื่อค่านี้ซ้ำกับแถว ${earlier} ให้เหลือแถวเดียว`)
    rowOfKey.set(key, row)
    const value = values.value ?? null
    if (value === null) throw new Error(`${at}: ช่องค่าที่ใช้ (value) ว่าง ใส่ค่า หรือลบแถวนี้ออก`)
    const column = COLUMN_KEY.exec(key)
    const place = column ? Number(column[1]) : 0
    if (place > 0) columns.push({ place, ...columnOf(value, at) })
    else if (key === 'express.fileType') fileType = oneOf(LAYOUT.shape.fileType.options, value, at)
    else if (key === 'express.encoding') encoding = oneOf(LAYOUT.shape.encoding.options, value, at)
    else if (key === 'express.dateFormat') dateFormat = oneOf(LAYOUT.shape.dateFormat.options, value, at)
    else throw new Error(`${at}: ไม่รู้จักชื่อค่านี้ ชื่อค่าของไฟล์ Express ที่ใช้ได้คือ ${KNOWN_KEYS}`)
  }
  const mapping = columns.length > 0 ? [...columns].sort((a, b) => a.place - b.place).map(({ header, field }) => ({ header, field })) : base.mapping
  const layout = LAYOUT.safeParse({ fileType, encoding, dateFormat, mapping })
  if (!layout.success) throw new Error(`ชีต ${SHEET}: รูปแบบไฟล์ Express ใช้ไม่ได้ (${layout.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`)
  return layout.data
}

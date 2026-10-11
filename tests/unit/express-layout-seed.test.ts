import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { EXPRESS_FIELDS, OrgSettingsSchema } from '@/lib/org-settings'
import { expressLayoutFromSheet } from '@/server/seed/express-layout'
import type { InputWorkbook, SheetRow } from '@/server/seed/workbook'

// S4-09 (spec §7.13, BR-EXP-01, OQ-10, P0-10): the demo organization's Express file layout comes from sheet Settings
// of the inputs file — rows express.column.01, 02, … holding <column header>=<field> — and never from a guess. Without
// such rows the layout of prisma/seed/org-settings.demo.yaml stays: no columns (Appendix A), so the export is refused.
// Anything the loader cannot read exactly stops the seed with a Thai message naming the row.

/** prisma/seed/org-settings.demo.yaml as the seed reads it (the test runs from the repository root) */
const demoSettings = OrgSettingsSchema.parse(parseYaml(readFileSync('prisma/seed/org-settings.demo.yaml', 'utf8')))
const base = demoSettings.express

/** Sheet Settings with these key/value rows from row 3 (row 1 holds the column keys, row 2 the Thai labels) */
function settingsSheet(rows: ReadonlyArray<readonly [key: string, value: string | null]>): InputWorkbook {
  const table: SheetRow[] = rows.map(([key, value], i) => ({ row: i + 3, values: { key, value, labelTh: null, ref: null } }))
  const only = (sheet: string) => {
    if (sheet !== 'Settings') throw new Error(`the Express layout reads sheet Settings only, not ${sheet}`)
  }
  return {
    hasSheet: (sheet) => sheet === 'Settings',
    table: (sheet) => {
      only(sheet)
      return table
    },
    keyValues: (sheet) => {
      only(sheet)
      return new Map(table.map(({ row, values }) => [values.key!, { value: values.value ?? null, row }]))
    },
  }
}

/** The rows of the inputs file today: other settings, and the encoding of the Express file (OQ-10) but no column */
const TODAY: ReadonlyArray<readonly [string, string]> = [
  ['vatRate', '0.07'],
  ['budgetBasis', 'NET'],
  ['numbering.PR', 'PR-{BE}-{SEQ5}'],
  ['express.encoding', 'UTF-8-BOM'],
  ['poIdleDays', '30'],
  ['registry.mode', 'stub'],
]

const read = (rows: ReadonlyArray<readonly [string, string | null]>) => expressLayoutFromSheet(settingsSheet(rows), base)

/** The message the seed stops with for these rows */
function problemOf(rows: ReadonlyArray<readonly [string, string | null]>): string {
  try {
    read(rows)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the rows to be refused')
}

describe('[FR-P2P-009/AC1] the demo’s Express layout comes from sheet Settings, never from a guess (S4-09, BR-EXP-01, OQ-10)', () => {
  it('has no columns in the demo settings file (Appendix A), and a sheet without column rows keeps it so', () => {
    expect(base).toEqual({ fileType: 'xlsx', encoding: 'UTF-8-BOM', dateFormat: 'BE', mapping: [] })
    expect(read(TODAY)).toEqual(base)
    expect(read([])).toEqual(base)
  })

  it('takes the column rows in the order of their keys, whatever the order of the rows, and nothing from other settings', () => {
    const layout = read([
      ['express.column.02', 'วันที่เอกสาร=invoiceDate'],
      ['vatRate', '0.07'],
      ['express.column.10', ' ยอดรวมทั้งสิ้น = gross '],
      ['express.column.01', 'รหัสเจ้าหนี้=expressVendorCode'],
      // A header may hold "=" itself: the field is what follows the last one
      ['express.column.03', 'ยอด=ก่อนภาษี=net'],
    ])
    expect(layout).toEqual({
      ...base,
      mapping: [
        { header: 'รหัสเจ้าหนี้', field: 'expressVendorCode' },
        { header: 'วันที่เอกสาร', field: 'invoiceDate' },
        { header: 'ยอด=ก่อนภาษี', field: 'net' },
        { header: 'ยอดรวมทั้งสิ้น', field: 'gross' },
      ],
    })
  })

  it('takes every field of EXPRESS_FIELDS', () => {
    const rows = EXPRESS_FIELDS.map((field, i) => [`express.column.${String(i + 1).padStart(2, '0')}`, `คอลัมน์ ${i + 1}=${field}`] as const)
    expect(read(rows).mapping.map((c) => c.field)).toEqual([...EXPRESS_FIELDS])
  })

  it('sets the file type, encoding and date format from their rows; a row left out keeps the settings file’s value', () => {
    const layout = read([
      ['express.column.01', 'เลขที่ใบกำกับ=invoiceNo'],
      ['express.fileType', 'csv'],
      ['express.dateFormat', 'CE'],
    ])
    expect(layout).toEqual({ fileType: 'csv', encoding: base.encoding, dateFormat: 'CE', mapping: [{ header: 'เลขที่ใบกำกับ', field: 'invoiceNo' }] })
    expect(read([['express.encoding', 'WINDOWS-874']])).toEqual({ ...base, encoding: 'WINDOWS-874' })
  })

  it('stops with a Thai message naming the row for a field it does not know, never taking the field it resembles', () => {
    const rows = [
      ['express.column.01', 'เลขที่ใบกำกับ=invoiceNo'],
      ['express.column.02', 'วันที่=InvoiceDate'],
    ] as const
    expect(problemOf(rows)).toMatch(/^ชีต Settings แถว 4 \(express\.column\.02\): "InvoiceDate" ไม่ใช่ชื่อข้อมูลที่ระบบรู้จัก \(ถ้าหมายถึง invoiceDate /)
    const message = problemOf([['express.column.01', 'ผู้ขาย=vendor']])
    expect(message).toMatch(/^ชีต Settings แถว 3 \(express\.column\.01\): "vendor" ไม่ใช่ชื่อข้อมูลที่ระบบรู้จัก ชื่อข้อมูลที่ใช้ได้: /)
    for (const field of EXPRESS_FIELDS) expect(message).toContain(field)
  })

  it('stops for a value that is not <column header>=<field>', () => {
    const cases: ReadonlyArray<readonly [value: string | null, problem: RegExp]> = [
      [null, /ช่องค่าที่ใช้ \(value\) ว่าง/],
      ['เลขที่ใบกำกับ', /"เลขที่ใบกำกับ" ไม่มีเครื่องหมาย =/],
      ['=invoiceNo', /หัวคอลัมน์ \(ข้อความก่อนเครื่องหมาย =\) ต้องยาว 1 ถึง 100 ตัวอักษร/],
      [`${'ก'.repeat(101)}=invoiceNo`, /หัวคอลัมน์ \(ข้อความก่อนเครื่องหมาย =\) ต้องยาว 1 ถึง 100 ตัวอักษร/],
      ['เลขที่ใบกำกับ=', /ยังไม่มีชื่อข้อมูลหลังเครื่องหมาย =/],
    ]
    for (const [value, problem] of cases) {
      expect(() => read([['express.column.01', value]]), String(value)).toThrow(/^ชีต Settings แถว 3 \(express\.column\.01\): /)
      expect(() => read([['express.column.01', value]]), String(value)).toThrow(problem)
    }
  })

  it('stops for a key given twice and for an Express key it does not know: a typo is never skipped', () => {
    expect(() =>
      read([
        ['express.column.01', 'เลขที่ใบกำกับ=invoiceNo'],
        ['express.column.01', 'ยอดรวม=gross'],
      ]),
    ).toThrow(/^ชีต Settings แถว 4 \(express\.column\.01\): ชื่อค่านี้ซ้ำกับแถว 3/)
    for (const key of ['express.columns.01', 'Express.Column.01', 'express.column.1', 'express.column.001', 'express.column.00', 'express.layout']) {
      expect(() => read([[key, 'เลขที่ใบกำกับ=invoiceNo']]), key).toThrow(new RegExp(`^ชีต Settings แถว 3 \\(${key.replace(/\./g, '\\.')}\\): ไม่รู้จักชื่อค่านี้ ชื่อค่าของไฟล์ Express ที่ใช้ได้คือ express\\.column\\.01 ถึง express\\.column\\.99`))
    }
  })

  it('stops for a file type, encoding or date format it does not take', () => {
    expect(() => read([['express.fileType', 'xls']])).toThrow(/^ชีต Settings แถว 3 \(express\.fileType\): "xls" ใช้ไม่ได้ ใส่ได้เฉพาะ xlsx หรือ csv$/)
    expect(() => read([['express.encoding', 'TIS-620']])).toThrow(/^ชีต Settings แถว 3 \(express\.encoding\): "TIS-620" ใช้ไม่ได้ ใส่ได้เฉพาะ UTF-8-BOM หรือ WINDOWS-874$/)
    expect(() => read([['express.dateFormat', 'พ.ศ.']])).toThrow(/^ชีต Settings แถว 3 \(express\.dateFormat\): "พ\.ศ\." ใช้ไม่ได้ ใส่ได้เฉพาะ BE หรือ CE$/)
  })
})

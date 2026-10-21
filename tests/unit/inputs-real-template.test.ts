import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { INPUT_WORKBOOKS, loadInputWorkbook, type InputWorkbook } from '@/server/seed/workbook'

// P1-12: the form that collects the customer's real data (finish line B) is docs/inputs/BCS_inputs_real_template.xlsx,
// built by `node scripts/py.mjs scripts/inputs_p1/make.py --blank`. It must keep every sheet and column key of the
// phase-1 workbook that is asked from the customer (blue headers) or set by BCS (grey), so the seed reader takes the
// filled form as is, and must carry none of the synthetic company (gold sheets, sample rows, "สมมติ" notes).

const TEMPLATE = 'docs/inputs/BCS_inputs_real_template.xlsx'
const GOLD = 'BF8F00'
const GREY = '7F7F7F'
const KEY_VALUE_SHEETS = ['Org', 'DOA_Policy', 'Settings']
/** Grey key/value values of the synthetic company the form leaves empty (scripts/inputs_p1/p1_texts.py BLANK_CLEAR_KEYS) */
const CLEARED = { DOA_Policy: ['code', 'version', 'effectiveFrom'], Settings: ['ap.inboxAddress'] } as Record<string, string[]>

async function open(path: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  return workbook
}

const headerFill = (ws: ExcelJS.Worksheet) => (ws.getCell(1, 1).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb?.slice(-6)
const headerKeys = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(String)
const ids = (workbook: InputWorkbook, sheet: string) => workbook.table(sheet).map((r) => r.values.id)

describe('[FR-PLT-001/AC1] P1-12 the form of real data (make.py --blank)', () => {
  let p1: ExcelJS.Workbook
  let form: ExcelJS.Workbook
  let p1Rows: InputWorkbook
  let formRows: InputWorkbook
  beforeAll(async () => {
    ;[p1, form, p1Rows, formRows] = await Promise.all([open(INPUT_WORKBOOKS.p1), open(TEMPLATE), loadInputWorkbook(INPUT_WORKBOOKS.p1), loadInputWorkbook(TEMPLATE)])
  })

  it('has every sheet of the phase-1 workbook except the synthetic ones (gold), in the same order with the same column keys and colours', () => {
    const asked = p1.worksheets.filter((ws) => ws.name === 'README' || headerFill(ws) !== GOLD)
    expect(form.worksheets.map((ws) => ws.name)).toEqual(asked.map((ws) => ws.name))
    expect(form.worksheets.map((ws) => ws.name)).not.toContain('Request_History')
    for (const ws of asked.filter((s) => s.name !== 'README')) {
      const mine = form.getWorksheet(ws.name)!
      expect(headerKeys(mine), ws.name).toEqual(headerKeys(ws))
      expect(headerFill(mine), ws.name).toBe(headerFill(ws))
      expect(mine.getRow(2).getCell(1).value, `${ws.name} row 2 explains the column`).toBeTruthy()
    }
  })

  it('leaves every table of real data empty and keeps the grey defaults of BCS, clearing only the synthetic company', () => {
    for (const ws of form.worksheets.filter((s) => s.name !== 'README' && !['Inputs', 'Questions'].includes(s.name))) {
      const grey = headerFill(ws) === GREY
      if (KEY_VALUE_SHEETS.includes(ws.name)) {
        const mine = formRows.keyValues(ws.name)
        const theirs = p1Rows.keyValues(ws.name)
        expect([...mine.keys()], ws.name).toEqual([...theirs.keys()])
        for (const [key, { value }] of mine) {
          const expected = !grey || CLEARED[ws.name]?.includes(key) ? null : theirs.get(key)!.value
          expect(value, `${ws.name}.${key}`).toBe(expected)
        }
      } else if (grey) {
        expect(formRows.table(ws.name).map((r) => r.values), ws.name).toEqual(p1Rows.table(ws.name).map((r) => r.values))
      } else {
        expect(formRows.table(ws.name), ws.name).toEqual([])
      }
    }
    expect(formRows.table('Banks').length).toBeGreaterThan(0)
    expect(formRows.table('WHT_Types').length).toBeGreaterThan(0)
  })

  it('lists every input to ask for and every meeting question, with nothing marked synthetic and every sheet it names in the form', () => {
    expect(ids(formRows, 'Inputs')).toEqual(ids(p1Rows, 'Inputs'))
    expect(ids(formRows, 'Questions')).toEqual(ids(p1Rows, 'Questions'))
    const sheets = new Set(form.worksheets.map((ws) => ws.name))
    for (const { values } of formRows.table('Inputs')) {
      expect(['รอข้อมูล', 'ค่าเริ่มต้น OQ'], values.id!).toContain(values.status)
      expect(values.sheet === '-' || sheets.has(values.sheet!), `${values.id} → ${values.sheet}`).toBe(true)
      if (values.status !== 'ค่าเริ่มต้น OQ') expect(values.demoValue, values.id!).toBeNull()
    }
    for (const { values } of formRows.table('Questions')) expect(values.answer, values.id!).toBeNull()
  })

  it('carries no trace of the synthetic company outside the meeting questions', () => {
    for (const ws of form.worksheets.filter((s) => s.name !== 'Questions')) {
      ws.eachRow((row, r) =>
        row.eachCell((cell, c) => {
          const text = String(cell.value ?? '')
          expect(/simec|สมมติ|Request_History|DocSamples/i.test(text), `${ws.name}!R${r}C${c}: ${text}`).toBe(false)
        }),
      )
    }
  })

  it('formats the columns of numbers with leading zeros as Text, so Excel keeps the zeros of a tax ID or a bank code', () => {
    const column = (sheet: string, key: string) => form.getWorksheet(sheet)!.getColumn(headerKeys(form.getWorksheet(sheet)!).indexOf(key) + 1)
    expect(column('Suppliers', 'taxId').numFmt).toBe('@')
    expect(column('Suppliers', 'branchCode').numFmt).toBe('@')
    expect(column('SupplierPayment', 'bankCode').numFmt).toBe('@')
    expect(column('SupplierPayment', 'accountNo').numFmt).toBe('@')
    expect(column('CompanyBankAccounts', 'accountNo').numFmt).toBe('@')
  })
})

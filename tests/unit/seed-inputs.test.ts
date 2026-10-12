import { afterEach, describe, expect, it } from 'vitest'
import { parseBudget, parseCostCenters, parseHistory, parseP1History } from '@/server/seed/sheets'
import { INPUT_WORKBOOK_PATH, INPUT_WORKBOOKS, inputProfileOf, loadInputWorkbook, type InputWorkbook, type SheetRow } from '@/server/seed/workbook'
import { budgetKeyLines, budgetLineOn, type HistoryBudgetLines } from '@/server/seed/budget-keys'
import { inputsArgument } from '../../scripts/db-reset'

// P1-02: the seed reads the phase-1 workbook only when pnpm db:seed or a script asks for it (SEED_INPUTS=p1, or
// pnpm db:reset:p1); the default every test and e2e loads stays the demo workbook, whatever the environment holds.

/** `workbook` with one sheet's rows changed by `edit` */
function editSheet(workbook: InputWorkbook, sheet: string, edit: (rows: SheetRow[]) => SheetRow[]): InputWorkbook {
  return { ...workbook, table: (name) => (name === sheet ? edit(workbook.table(name)) : workbook.table(name)) }
}

/** The first row of `rows` with `values` merged in */
const firstWith = (values: Record<string, string | null>) => (rows: SheetRow[]) => rows.map((r, i) => (i === 0 ? { ...r, values: { ...r.values, ...values } } : r))

describe('[FR-PLT-001/AC1] P1-02 choosing the input workbook', () => {
  const saved = process.env.SEED_INPUTS
  afterEach(() => {
    if (saved === undefined) delete process.env.SEED_INPUTS
    else process.env.SEED_INPUTS = saved
  })

  it('reads SEED_INPUTS as demo when unset or empty, p1 when asked, and refuses anything else', () => {
    expect(inputProfileOf(undefined)).toBe('demo')
    expect(inputProfileOf('')).toBe('demo')
    expect(inputProfileOf(' p1 ')).toBe('p1')
    expect(() => inputProfileOf('p2')).toThrow(/SEED_INPUTS=p2/)
    expect(INPUT_WORKBOOKS).toEqual({ demo: INPUT_WORKBOOK_PATH, p1: 'docs/inputs/BCS_inputs_p1.xlsx' })
  })

  it('loads the demo workbook by default even when the environment names the phase-1 one (tests and e2e keep the demo)', async () => {
    process.env.SEED_INPUTS = 'p1'
    const workbook = await loadInputWorkbook()
    expect(workbook.hasSheet('Demo_History')).toBe(true)
    expect(workbook.hasSheet('Request_History')).toBe(false)
  })

  it('takes pnpm db:reset --inputs=<profile> for the seed it runs', () => {
    expect(inputsArgument(['--inputs=p1'])).toBe('p1')
    expect(inputsArgument(['--inputs', 'p1'])).toBe('p1')
    expect(inputsArgument([])).toBeNull()
    // A mistyped option is refused before anything is wiped, never ignored
    expect(() => inputsArgument(['--input=p1'])).toThrow('--input=p1')
    expect(() => inputsArgument(['p1'])).toThrow('p1')
  })
})

describe('[FR-PLT-001/AC1] P1-02 sheets of the phase-1 workbook', () => {
  it('reads Request_History with its budget key, item line and form, and the demo Demo_History with its budget line', async () => {
    const p1 = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const rows = parseHistory(p1)
    expect(rows).toHaveLength(p1.table('Request_History').length)
    const first = rows[0]!
    expect(first.ref).toMatch(/^H\d{3}$/)
    expect(first.budget).toEqual({ key: p1.table('Request_History')[0]!.values.budgetKey })
    expect(first.line?.quantity).toBe(p1.table('Request_History')[0]!.values.qty)
    expect(rows.some((r) => r.form?.processesPersonalData === 'Y')).toBe(true)
    // A department code with a hyphen (HRA-GA) is read as the organization screens take it
    expect(rows.some((r) => r.chargedDept.includes('-'))).toBe(true)
    const demo = parseHistory(await loadInputWorkbook())
    expect(demo[0]!.budget).toHaveProperty('line')
    expect(demo.every((r) => r.line === null && r.form === null)).toBe(true)
  })

  it('refuses a row whose quantity times unit price is not its net, an unknown item, or a form that is not JSON of text answers', async () => {
    const p1 = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const ref = p1.table('Request_History')[0]!.values.ref!
    expect(() => parseP1History(editSheet(p1, 'Request_History', firstWith({ qty: '3', unitPrice: '1', net: '4' })))).toThrow(`Request_History ${ref}: 3 × 1 is not the net 4`)
    expect(() => parseP1History(editSheet(p1, 'Request_History', firstWith({ itemCode: 'NO-SUCH-ITEM' })))).toThrow('is not in sheet Items')
    expect(() => parseP1History(editSheet(p1, 'Request_History', firstWith({ form: '{"processesPersonalData": 1}' })))).toThrow(/form must be JSON/)
    expect(() => parseP1History(editSheet(p1, 'Request_History', firstWith({ form: 'not json' })))).toThrow(/form must be JSON/)
  })

  it('refuses two lines of one budget key in a fiscal year, and names cost centers from sheet CostCenters (none for the demo workbook)', async () => {
    const p1 = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const first = p1.table('Budget')[0]!.values
    const second = (rows: SheetRow[]) => rows.map((r, i) => (i === 1 ? { ...r, values: { ...r.values, budgetKey: first.budgetKey!, fiscalYear: first.fiscalYear! } } : r))
    expect(() => parseBudget(editSheet(p1, 'Budget', second))).toThrow('duplicate budgetKey')
    expect(parseCostCenters(p1)).toHaveLength(p1.table('CostCenters').length)
    expect(parseCostCenters(await loadInputWorkbook())).toEqual([])
    expect(parseBudget(await loadInputWorkbook()).every((l) => l.budgetKey === null)).toBe(true)
  })
})

describe('[FR-PLT-001/AC1] P1-02 the budget line a history row is sent with', () => {
  // The same line code in both fiscal years (parseBudget allows it): the year of the day decides, never the code alone
  const lines: HistoryBudgetLines = {
    budgetLines: new Map([['OPEX', 'line-2570']]),
    linesByYear: new Map([
      ['FY2569|OPEX', 'line-2569'],
      ['FY2570|OPEX', 'line-2570'],
    ]),
    fiscalYears: [
      { code: 'FY2569', startsOn: '2026-01-01', endsOn: '2026-12-31' },
      { code: 'FY2570', startsOn: '2027-01-01', endsOn: '2027-12-31' },
    ],
    budgetKeys: budgetKeyLines([
      { budgetKey: 'OPEX', fiscalYear: 'FY2569', code: 'OPEX' },
      { budgetKey: 'OPEX', fiscalYear: 'FY2570', code: 'OPEX' },
    ]),
  }

  it('takes the key line of the fiscal year holding the day, on both sides of the year end', () => {
    expect(budgetLineOn(lines, { key: 'OPEX' }, '2026-12-31')).toBe('line-2569')
    expect(budgetLineOn(lines, { key: 'OPEX' }, '2027-01-01')).toBe('line-2570')
  })

  it('finds no line on a day outside every fiscal year, or for a key the sheet lacks', () => {
    expect(budgetLineOn(lines, { key: 'OPEX' }, '2025-12-31')).toBeUndefined()
    expect(budgetLineOn(lines, { key: 'CAPEX' }, '2026-06-01')).toBeUndefined()
  })
})

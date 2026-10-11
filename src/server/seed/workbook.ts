import ExcelJS from 'exceljs'

// Reads docs/inputs/BCS_inputs_v1_demo.xlsx the same way scripts/validate_inputs.py does: row 1 holds the
// column keys, row 2 the Thai labels for people editing the sheet, data starts on row 3 and ends at the
// first row whose first cell is empty. Values are normalized to trimmed strings (or null) so Zod can parse
// and report them with the sheet!cell position.
// P1-02 (ADR-065): `pnpm db:seed` and the scripts may read the synthetic phase-1 workbook instead (SEED_INPUTS=p1);
// tests and e2e keep the demo workbook, so the default here never reads the environment (.env reaches the tests).

export const INPUT_WORKBOOK_PATH = 'docs/inputs/BCS_inputs_v1_demo.xlsx'

/** The input workbooks the seed reads: the demo scenes, and the synthetic data of phase 1 (spec §16.13) */
export const INPUT_WORKBOOKS = { demo: INPUT_WORKBOOK_PATH, p1: 'docs/inputs/BCS_inputs_p1.xlsx' } as const
export type InputProfile = keyof typeof INPUT_WORKBOOKS

/** SEED_INPUTS of `pnpm db:seed` and the scripts: unset or empty is the demo workbook, anything unknown is refused */
export function inputProfileOf(value: string | undefined): InputProfile {
  const profile = (value ?? '').trim() || 'demo'
  if (!Object.hasOwn(INPUT_WORKBOOKS, profile)) throw new Error(`SEED_INPUTS=${profile} is not one of ${Object.keys(INPUT_WORKBOOKS).join(', ')}`)
  return profile as InputProfile
}

export interface SheetRow {
  /** 1-based row number in the sheet, for error messages */
  readonly row: number
  readonly values: Readonly<Record<string, string | null>>
}

export interface InputWorkbook {
  hasSheet(sheet: string): boolean
  table(sheet: string): SheetRow[]
  keyValues(sheet: string): Map<string, { value: string | null; row: number }>
}

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('richText' in value) return cellText(value.richText.map((part) => part.text).join(''))
    if ('result' in value) return cellText((value.result ?? null) as ExcelJS.CellValue)
    if ('text' in value && typeof value.text === 'string') return cellText(value.text)
    if ('error' in value) throw new Error(`cell contains an Excel error (${String(value.error)})`)
  }
  return String(value)
}

export async function loadInputWorkbook(path: string = INPUT_WORKBOOK_PATH): Promise<InputWorkbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)

  function sheet(name: string): ExcelJS.Worksheet {
    const ws = workbook.getWorksheet(name)
    if (!ws) throw new Error(`${path}: sheet "${name}" is missing (run pnpm inputs:check)`)
    return ws
  }

  function table(name: string): SheetRow[] {
    const ws = sheet(name)
    const keys = new Map<number, string>()
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      const key = cellText(cell.value)
      if (key) keys.set(col, key)
    })
    const rows: SheetRow[] = []
    for (let r = 3; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      if (cellText(row.getCell(1).value) === null) break
      const values: Record<string, string | null> = {}
      for (const [col, key] of keys) {
        try {
          values[key] = cellText(row.getCell(col).value)
        } catch (error) {
          throw new Error(`${name}!${ws.getColumn(col).letter}${r}: ${(error as Error).message}`)
        }
      }
      rows.push({ row: r, values })
    }
    return rows
  }

  function keyValues(name: string): Map<string, { value: string | null; row: number }> {
    const out = new Map<string, { value: string | null; row: number }>()
    for (const { row, values } of table(name)) {
      if (values.key) out.set(values.key, { value: values.value ?? null, row })
    }
    return out
  }

  return { hasSheet: (name) => workbook.getWorksheet(name) !== undefined, table, keyValues }
}

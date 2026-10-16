import { describe, expect, it } from 'vitest'
import { BANKS, bankOf } from '@/core/bankfile/banks'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '@/server/seed/workbook'

// ADR-131 (S9-01): the bank codes in the program are sheet Banks of the phase-1 file, row for row, and nothing else

describe('[ADR-131] the bank codes of the program are those of sheet Banks', () => {
  it('has every row of the sheet with its short name and Thai name, and no code the sheet lacks', async () => {
    const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const sheet = workbook.table('Banks').map(({ values }) => ({ code: String(values.code), shortName: String(values.shortName), nameTh: String(values.nameTh) }))
    expect(sheet.length).toBeGreaterThan(0)
    expect([...BANKS].sort((a, b) => a.code.localeCompare(b.code))).toEqual(sheet.sort((a, b) => a.code.localeCompare(b.code)))
  })

  it('finds a bank by its code; an unknown code is null (BANK_CODE_UNKNOWN)', () => {
    expect(bankOf('004')).toEqual({ code: '004', shortName: 'KBANK', nameTh: 'ธนาคารกสิกรไทย' })
    expect(bankOf('999')).toBeNull()
    expect(bankOf('4')).toBeNull()
  })
})

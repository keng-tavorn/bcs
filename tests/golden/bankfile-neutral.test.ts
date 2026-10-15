import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildNeutralFile, readNeutralFile, type NeutralItem, type NeutralRun } from '@/core/bankfile'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { utf8WithBom } from '@/lib/encoding'
import { loadYaml } from './doa-fixtures'

// tests/golden/bankfile-neutral.yaml (spec §7.14, BR-BANK-04 BR-BANK-05, ADR-130): the file of each case built by the
// pure builder, written as the service writes it (UTF-8 with a BOM, src/lib/encoding), then read back: its name, its
// lines, the count and total its rows state, its length in bytes and their sha256. A case with sameAs is that case with
// its run changed.

type RawItem = Omit<NeutralItem, 'amountSatang'> & { amount: string }
interface NeutralCase {
  id: string
  title: string
  input: { run: NeutralRun; items: RawItem[] } | { sameAs: string; run: Partial<NeutralRun> }
  expect: { fileName: string; lines: string[]; itemCount: number; total: string; bytes: number; sha256: string }
}

const suite = loadYaml<{ template: string; cases: NeutralCase[] }>('bankfile-neutral.yaml')

function inputOf(c: NeutralCase): { run: NeutralRun; items: RawItem[] } {
  if (!('sameAs' in c.input)) return c.input
  const { sameAs, run } = c.input
  const base = inputOf(suite.cases.find((x) => x.id === sameAs)!)
  return { run: { ...base.run, ...run }, items: base.items }
}

/** The file of an input as the service would store it */
function neutralFileOf(input: { run: NeutralRun; items: readonly NeutralItem[] }) {
  const file = buildNeutralFile(input)
  const bytes = utf8WithBom(file.text)
  const read = readNeutralFile(file.text)
  return { file, bytes, read, sha256: createHash('sha256').update(bytes).digest('hex') }
}

describe('golden bankfile-neutral.yaml', () => {
  it('has the cases of the suite', () => {
    expect(suite.template).toBe('BCS-NEUTRAL-1')
    expect(suite.cases.length).toBe(3)
  })
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const input = inputOf(c)
      const { file, bytes, read, sha256 } = neutralFileOf({ run: input.run, items: input.items.map(({ amount, ...i }) => ({ ...i, amountSatang: amountToSatang(amount) })) })
      // the H row, the D rows and the T row agree with each other (INV-PAY-02)
      expect(read.header).toEqual(read.trailer)
      expect(read.details).toEqual(read.trailer)
      expect({
        fileName: file.fileName,
        lines: file.text.split('\r\n').slice(0, -1),
        itemCount: read.trailer.count,
        total: satangToAmount(read.trailer.totalSatang),
        bytes: bytes.length,
        sha256,
      }).toEqual(c.expect)
    })
  }
})

import { amountToSatang, satangToAmount } from '../money/dto'
import type { Satang } from '../money/math'
import { NEUTRAL_TEMPLATE_CODE } from './templates'

// BR-BANK-04 BR-BANK-05 (ADR-129 ADR-130): the neutral template BCS-NEUTRAL-1 of the demo layer. The builder is pure:
// it takes the run and its items and gives the file's name and text; the service writes the text as UTF-8 with a BOM
// (src/lib/encoding), keeps the sha256 of those bytes, and reads the file back (readNeutralFile) to see that the D rows,
// the T row and the run's total agree. Nothing in the text depends on when it is made, so the same run and version give
// the same bytes every time.

const NOT_A_BANK_FORMAT = 'NOT-A-BANK-FORMAT'
const CRLF = '\r\n'
const REFERENCE_SEQ_DIGITS = 3

export interface NeutralRun {
  readonly number: string
  readonly fileVersion: number
  /** The pay date, YYYY-MM-DD in the Gregorian calendar */
  readonly valueDate: string
  readonly payer: { readonly bankCode: string; readonly accountNo: string }
}

export interface NeutralItem {
  readonly seq: number
  readonly bankCode: string
  readonly accountNo: string
  readonly accountName: string
  readonly amountSatang: Satang
  readonly supplierCode: string
}

/** A field as CSV writes it: in quotes, with its quotes doubled, when it holds a comma, a quote or a line break */
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
const line = (fields: readonly (string | number)[]) => fields.map((f) => field(String(f))).join(',')

/** The file of a run: its items in seq order, one H row, a D row per item and one T row, each line ending with CRLF */
export function buildNeutralFile(input: { readonly run: NeutralRun; readonly items: readonly NeutralItem[] }): { readonly fileName: string; readonly text: string } {
  const { run } = input
  const items = [...input.items].sort((a, b) => a.seq - b.seq)
  if (items.some((i) => i.amountSatang <= 0n)) throw new RangeError('a bank file transfers more than nothing on every row (BR-PAY-04)')
  const total = satangToAmount(items.reduce((a, i) => a + i.amountSatang, 0n))
  const rows = [
    line(['H', NEUTRAL_TEMPLATE_CODE, NOT_A_BANK_FORMAT, run.number, run.fileVersion, run.valueDate, run.payer.bankCode, run.payer.accountNo, items.length, total]),
    ...items.map((i) => line(['D', i.seq, i.bankCode, i.accountNo, i.accountName, satangToAmount(i.amountSatang), i.supplierCode, `${run.number}-${String(i.seq).padStart(REFERENCE_SEQ_DIGITS, '0')}`])),
    line(['T', items.length, total]),
  ]
  return { fileName: `${NEUTRAL_TEMPLATE_CODE}_${NOT_A_BANK_FORMAT}_${run.number}_v${run.fileVersion}.csv`, text: rows.join(CRLF) + CRLF }
}

/** The fields of one CSV line (quotes as field() writes them); a quote left open throws */
function fieldsOf(text: string): string[] {
  const out: string[] = []
  let i = 0
  for (;;) {
    let value = ''
    if (text[i] === '"') {
      for (i++; ; i++) {
        if (i >= text.length) throw new RangeError('a quoted field is not closed')
        if (text[i] === '"' && text[i + 1] === '"') value += text[i++]
        else if (text[i] === '"') break
        else value += text[i]
      }
      i++
    } else {
      const end = text.indexOf(',', i)
      value = text.slice(i, end === -1 ? text.length : end)
      i = end === -1 ? text.length : end
    }
    out.push(value)
    if (i >= text.length) return out
    if (text[i] !== ',') throw new RangeError('a quoted field is followed by something other than a comma')
    i++
  }
}

export interface NeutralTotals {
  readonly header: { readonly count: number; readonly totalSatang: Satang }
  readonly details: { readonly count: number; readonly totalSatang: Satang }
  readonly trailer: { readonly count: number; readonly totalSatang: Satang }
}

/** The counts and totals a neutral file states, read back from its text: its H row, the sum of its D rows, its T row */
export function readNeutralFile(text: string): NeutralTotals {
  if (!text.endsWith(CRLF)) throw new RangeError('every line of the file ends with CRLF')
  const rows = text.slice(0, -CRLF.length).split(CRLF).map(fieldsOf)
  const [head, ...rest] = rows
  const tail = rest.pop()
  if (head?.[0] !== 'H' || head.length !== 10 || tail?.[0] !== 'T' || tail.length !== 3 || rest.some((r) => r[0] !== 'D' || r.length !== 8)) throw new RangeError('not a BCS-NEUTRAL-1 file')
  return {
    header: { count: Number(head[8]), totalSatang: amountToSatang(head[9]!) },
    details: { count: rest.length, totalSatang: rest.reduce((a, r) => a + amountToSatang(r[5]!), 0n) },
    trailer: { count: Number(tail[1]), totalSatang: amountToSatang(tail[2]!) },
  }
}

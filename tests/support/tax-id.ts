import { randomInt } from 'node:crypto'

/**
 * A Thai taxpayer id that passes mod 11 (BR-TAXID-01), random enough for the suppliers of one test organization. A test
 * supplier that is only "some supplier" is Thai with one of these, not foreign: a foreign supplier asks for an RFx in
 * Thai and English (BR-FORM-11 · S10-17).
 */
export function thaiTaxId(): string {
  const body = `01055${String(randomInt(0, 10_000_000)).padStart(7, '0')}`
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (13 - i), 0)
  return body + String((11 - (sum % 11)) % 10)
}

// Money crosses JSON boundaries as a decimal string (spec §14.1): { amount: "12345.50", currency: "THB" }.
// Internally money is always BigInt satang (ADR-018); these are the only conversion helpers.

export interface MoneyDto {
  readonly amount: string
  readonly currency: 'THB'
}

const SATANG_PER_BAHT = 100n
const AMOUNT = /^(-)?(\d+)(?:\.(\d{1,2}))?$/

/** 1234550n → "12345.50" · -440000n → "-4400.00" (no thousands separators: an I/O format, not a display format). */
export function satangToAmount(satang: bigint): string {
  const negative = satang < 0n
  const abs = negative ? -satang : satang
  const baht = abs / SATANG_PER_BAHT
  const rest = (abs % SATANG_PER_BAHT).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${baht.toString()}.${rest}`
}

/** "12345.5" → 1234550n. Rejects anything that is not a plain decimal with at most 2 places. */
export function amountToSatang(amount: string): bigint {
  const m = AMOUNT.exec(amount.trim())
  if (!m) throw new RangeError(`invalid money amount: ${JSON.stringify(amount)}`)
  const [, sign, baht, frac = ''] = m
  const satang = BigInt(baht!) * SATANG_PER_BAHT + BigInt(frac.padEnd(2, '0'))
  return sign ? -satang : satang
}

export function toMoneyDto(satang: bigint): MoneyDto {
  return { amount: satangToAmount(satang), currency: 'THB' }
}

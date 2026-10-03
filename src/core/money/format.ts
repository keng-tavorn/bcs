// Money for display (FR-PLT-002 AC3, §9.9 rule 6): thousands separators and exactly 2 decimals, from BigInt satang.
// No floating point anywhere (§17.3).

const SATANG_PER_BAHT = 100n
const GROUP = /\B(?=(\d{3})+(?!\d))/g

/** 123456n → "1,234.56" · -5n → "-0.05" */
export function formatSatang(satang: bigint): string {
  const negative = satang < 0n
  const abs = negative ? -satang : satang
  const baht = (abs / SATANG_PER_BAHT).toString().replace(GROUP, ',')
  const fraction = (abs % SATANG_PER_BAHT).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${baht}.${fraction}`
}

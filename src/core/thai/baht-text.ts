// Amount in Thai words (spec §7.2, BR-THAI-01, OQ-28): the same text as LibreOffice Calc BAHTTEXT. "เอ็ด" is used only
// when the tens digit of the same six-digit group is not zero (11, 21, 111) — 101 is "หนึ่งร้อยหนึ่ง" and 1,000,001 is
// "หนึ่งล้านหนึ่ง". Zero is "ศูนย์บาทถ้วน"; satang only starts with the satang; a negative amount is refused.
import { THAI_NUMBER_GROUP } from '../money/constants'

const DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'] as const
const PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'] as const
const GROUP = THAI_NUMBER_GROUP

/** One group of up to six digits (1–999,999) in words. */
function groupText(n: number): string {
  const digits = String(n).padStart(6, '0').split('').map(Number).reverse()
  let text = ''
  for (let place = 5; place >= 0; place--) {
    const d = digits[place]!
    if (d === 0) continue
    if (place === 1) text += d === 1 ? 'สิบ' : d === 2 ? 'ยี่สิบ' : `${DIGITS[d]}สิบ`
    else if (place === 0) text += d === 1 && digits[1] !== 0 ? 'เอ็ด' : DIGITS[d]
    else text += `${DIGITS[d]}${PLACES[place]}`
  }
  return text
}

/** A whole number in words; groups of six digits joined by "ล้าน" (1,000,000,000,000 → หนึ่งล้านล้าน). */
export function integerText(value: bigint): string {
  if (value < 0n) throw new RangeError('a negative number has no Thai amount text')
  if (value === 0n) return DIGITS[0]
  const groups: number[] = []
  for (let v = value; v > 0n; v /= GROUP) groups.unshift(Number(v % GROUP))
  return groups.map((g, i) => (g === 0 ? '' : groupText(g)) + (i < groups.length - 1 ? 'ล้าน' : '')).join('')
}

/** BAHTTEXT of an amount in satang (GC-THAI-01 to GC-THAI-15). */
export function bahtText(satang: bigint): string {
  if (satang < 0n) throw new RangeError('a negative amount has no Thai amount text')
  const baht = satang / 100n
  const rest = satang % 100n
  if (baht === 0n && rest === 0n) return 'ศูนย์บาทถ้วน'
  const bahtPart = baht > 0n ? `${integerText(baht)}บาท` : ''
  return rest === 0n ? `${bahtPart}ถ้วน` : `${bahtPart}${integerText(rest)}สตางค์`
}

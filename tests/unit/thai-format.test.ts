import { describe, expect, it } from 'vitest'
import { formatSatang } from '@/core/money/format'
import { buddhistYear, formatEnglishBeDate, formatEnglishBeDateTime, formatThaiDate, formatThaiDateTime } from '@/core/thai'

describe('[FR-PLT-002/AC3] Thai dates use the Buddhist era in Thai time', () => {
  it('switches day and year at Thai midnight, not UTC midnight', () => {
    expect(formatThaiDate('2026-01-31T16:59:59Z')).toBe('31 ม.ค. 2569')
    expect(formatThaiDate('2026-01-31T17:00:00Z')).toBe('1 ก.พ. 2569')
    expect(buddhistYear(new Date('2025-12-31T17:00:00Z'))).toBe(2569)
  })

  it('names every month', () => {
    const months = Array.from({ length: 12 }, (_, m) => formatThaiDate(new Date(Date.UTC(2026, m, 15, 3))).split(' ')[1])
    expect(months).toEqual(['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'])
  })

  it('pads hours and minutes', () => {
    expect(formatThaiDateTime('2026-10-01T23:05:00Z')).toBe('2 ต.ค. 2569 06:05 น.')
  })

  it('English screens keep the Buddhist-era year', () => {
    expect(formatEnglishBeDate('2026-10-02T09:30:00Z')).toBe('2 Oct 2569')
    expect(formatEnglishBeDateTime('2026-10-02T09:30:00Z')).toBe('2 Oct 2569 16:30')
  })

  it('refuses an invalid date instead of printing nonsense', () => {
    expect(() => formatThaiDate('not a date')).toThrow(RangeError)
  })
})

describe('[FR-PLT-002/AC3] money has thousands separators and 2 decimals', () => {
  it.each([
    [0n, '0.00'],
    [5n, '0.05'],
    [100n, '1.00'],
    [123456n, '1,234.56'],
    [10_000_000_00n, '10,000,000.00'],
    [-5n, '-0.05'],
    [-123456789n, '-1,234,567.89'],
  ])('%s satang → %s', (satang, text) => {
    expect(formatSatang(satang)).toBe(text)
  })
})

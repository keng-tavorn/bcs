import { createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { priceReferenceView, type PriceRefT } from '@/app/(workspace)/_tracking/price-reference'
import type { PriceLineReferenceDto, PriceReferenceDto } from '@/server/services/price-reference'
import { formatBpPercent } from '@/ui/format'
import { LiffPriceReference } from '@/ui/liff/tasks/price-reference'
import { PriceReferencePanel } from '@/ui/price-reference/panel'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S6-11 on screen (FR-DOA-101 AC1 AC2): the words and figures of the price reference panel, built from
// getPriceReference's DTO — money as satang text written with 2 decimals, a deviation as whole basis points written as a
// percent by integer arithmetic, "few prices" in words, the agreed price and the quotations — and the same figures in the
// web panel and the LIFF list.

const tTh = createTranslator({ locale: 'th', messages: th, namespace: 'priceReference' }) as unknown as PriceRefT
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'priceReference' }) as unknown as PriceRefT

const drill: PriceLineReferenceDto = {
  lineNo: 1,
  description: 'สว่านไฟฟ้า 18V',
  uom: 'ชิ้น',
  key: 'สว่านไฟฟ้า 18v|ชิ้น',
  unitPriceSatang: '270000',
  count: 3,
  excludedVatIncluded: 0,
  minSatang: '238000',
  medianSatang: '240000',
  maxSatang: '245000',
  lastSatang: '245000',
  status: 'OK',
  deviationBp: 1250,
  alert: 'HIGH',
  agreement: null,
}
const tape: PriceLineReferenceDto = {
  ...drill,
  lineNo: 2,
  description: 'ตลับเมตร 5 ม.',
  uom: 'อัน',
  key: 'ตลับเมตร 5 ม.|อัน',
  unitPriceSatang: '15000',
  count: 0,
  excludedVatIncluded: 1,
  minSatang: null,
  medianSatang: null,
  maxSatang: null,
  lastSatang: null,
  status: 'FEW_SAMPLES',
  deviationBp: null,
  alert: null,
  agreement: { supplierName: 'ผู้ขายเครื่องมือ', unitPriceSatang: '1234567' },
}
const ref: PriceReferenceDto = {
  requestId: 'r1',
  windowDays: 90,
  minSamples: 3,
  alertBp: 1000,
  requestIncludesVat: false,
  lines: [drill, tape],
  quotes: { count: 3, lowestSatang: '500000', highestSatang: '620000', selectedSatang: '550000', selectedIsLowest: false, nonLowestReason: 'ส่งของเร็วกว่า' },
  badge: { high: { lines: 1, maxPct: 12 }, low: null },
}

describe('[FR-DOA-101/AC1] basis points as a percent, by integer arithmetic', () => {
  it('signs, two decimals, thousands, zero and a threshold without a sign', () => {
    expect(formatBpPercent(1250)).toBe('+12.50%')
    expect(formatBpPercent(-305)).toBe('-3.05%')
    expect(formatBpPercent(-5)).toBe('-0.05%')
    expect(formatBpPercent(7)).toBe('+0.07%')
    expect(formatBpPercent(0)).toBe('0.00%')
    expect(formatBpPercent(100)).toBe('+1.00%')
    expect(formatBpPercent(123456)).toBe('+1,234.56%')
    expect(formatBpPercent(-1000000)).toBe('-10,000.00%')
    expect(formatBpPercent(1000, { signed: false })).toBe('10.00%')
    expect(formatBpPercent(-250, { signed: false })).toBe('-2.50%')
  })

  it('refuses a number that is not whole basis points', () => {
    expect(() => formatBpPercent(12.5)).toThrow(RangeError)
    expect(() => formatBpPercent(Number.NaN)).toThrow(RangeError)
    expect(() => formatBpPercent(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError)
  })
})

describe('[FR-DOA-101/AC1] the view of the panel', () => {
  it('a line with a median: money with 2 decimals, the deviation and the HIGH badge', () => {
    const view = priceReferenceView(tTh, ref)
    expect(view.title).toBe('ราคาอ้างอิง')
    expect(view.intro).toContain('90 วัน')
    expect(view.intro).toContain('10.00%')
    expect(view.vatNote).toBeNull()
    expect(view.lines[0]).toMatchObject({
      title: 'สว่านไฟฟ้า 18V',
      unitPrice: '2,700.00',
      median: '2,400.00',
      min: '2,380.00',
      max: '2,450.00',
      last: '2,450.00',
      deviation: '+12.50%',
      alert: { kind: 'HIGH', label: 'สูงกว่าค่ากลาง' },
      samples: 'จาก 3 ราคาใน PO ที่อนุมัติแล้ว',
      few: null,
      agreement: null,
    })
  })

  it('a line never bought: no figures, "few prices" in words, the excluded VAT prices and the agreed price', () => {
    const line = priceReferenceView(tTh, ref).lines[1]!
    expect(line).toMatchObject({ median: '-', min: '-', max: '-', last: '-', deviation: 'ยังไม่มีค่ากลาง', alert: null })
    expect(line.samples).toBe('ยังไม่มีราคาใน PO ที่อนุมัติแล้ว · ไม่นับ 1 ราคาที่รวม VAT')
    expect(line.few).toBe('ข้อมูลน้อย: ควรมีอย่างน้อย 3 ราคาจึงเทียบได้ดี')
    expect(line.agreement).toBe('ราคาตกลงกับ ผู้ขายเครื่องมือ 12,345.67 บาท/อัน')
  })

  it('a LOW line and a request whose prices include VAT: no deviation, and why', () => {
    const low = priceReferenceView(tTh, { ...ref, lines: [{ ...drill, unitPriceSatang: '200000', deviationBp: -1666, alert: 'LOW' }] }).lines[0]!
    expect(low).toMatchObject({ deviation: '-16.66%', alert: { kind: 'LOW', label: 'ต่ำกว่าค่ากลาง' } })
    const vat = priceReferenceView(tTh, { ...ref, requestIncludesVat: true, lines: [{ ...drill, deviationBp: null, alert: null }] })
    expect(vat.vatNote).toBe('ราคาในคำขอนี้รวม VAT จึงไม่คำนวณส่วนต่างจากค่ากลาง เพราะค่ากลางเป็นราคาก่อน VAT')
    expect(vat.lines[0]).toMatchObject({ deviation: 'ไม่คำนวณ (ราคารวม VAT)', median: '2,400.00', alert: null })
  })

  it('the quotations: count, lowest, highest, chosen, and the reason when the chosen one is not the lowest', () => {
    const quotes = priceReferenceView(tTh, ref).quotes!
    expect(quotes.rows).toEqual([
      { label: 'จำนวนใบเสนอราคา', value: '3 ใบ' },
      { label: 'ต่ำสุด', value: '5,000.00' },
      { label: 'สูงสุด', value: '6,200.00' },
      { label: 'ใบที่เลือก', value: '5,500.00' },
    ])
    expect(quotes.note).toBe('ใบที่เลือกไม่ใช่ราคาต่ำสุด เหตุผล: ส่งของเร็วกว่า')
    const lowest = { count: 2, lowestSatang: '500000', highestSatang: '520000', selectedSatang: '500000', selectedIsLowest: true, nonLowestReason: null }
    expect(priceReferenceView(tTh, { ...ref, quotes: lowest }).quotes!.note).toBe('เลือกใบที่ราคาต่ำสุด')
    expect(priceReferenceView(tTh, { ...ref, quotes: { ...lowest, selectedSatang: null, selectedIsLowest: false } }).quotes!.note).toBe('ยังไม่ได้เลือกใบเสนอราคา')
    expect(priceReferenceView(tTh, { ...ref, quotes: null }).quotes).toBeNull()
  })

  it('in English too', () => {
    const view = priceReferenceView(tEn, ref)
    expect(view.lines[0]!.samples).toBe('From 3 prices on approved POs')
    expect(view.lines[0]!.alert!.label).toBe('Above the median')
    expect(view.lines[1]!.agreement).toBe('Agreed price with ผู้ขายเครื่องมือ: 12,345.67 baht/อัน')
    expect(view.quotes!.rows[0]!.value).toBe('3 quotations')
  })
})

describe('[FR-DOA-101/AC2] the web panel and the LIFF list show the same figures', () => {
  const view = priceReferenceView(tTh, ref)
  it('the web panel: a table for a wide column and the stacked list for a narrow one, with the badge in words', () => {
    const html = renderToStaticMarkup(<PriceReferencePanel view={view} />)
    for (const figure of ['2,700.00', '2,400.00', '2,380.00 –', '2,450.00', '+12.50%', 'สูงกว่าค่ากลาง', 'ข้อมูลน้อย', '5,500.00', 'ส่งของเร็วกว่า']) expect(html, figure).toContain(figure)
    expect(html).toContain('<table')
    expect(html).toContain('data-icon="TrendingUp"')
  })

  it('the LIFF list: the same numbers, plain elements with the LIFF badge (no table, no shadcn/ui slot)', () => {
    const html = renderToStaticMarkup(<LiffPriceReference view={view} />)
    for (const figure of ['2,700.00', '2,400.00', '2,380.00', '2,450.00', '+12.50%', 'สูงกว่าค่ากลาง', 'ข้อมูลน้อย', '5,500.00', 'ส่งของเร็วกว่า']) expect(html, figure).toContain(figure)
    expect(html).not.toContain('<table')
    expect(html).not.toContain('data-slot="table')
    expect(html).toContain('data-icon="TrendingUp"')
  })
})

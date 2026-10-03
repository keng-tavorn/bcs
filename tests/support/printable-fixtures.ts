import { formatSatang } from '@/core/money/format'
import { bahtText } from '@/core/thai/baht-text'
import type { PrintableDocument } from '@/server/pdf/printable'

// Printed documents for the Thai rendering snapshots (spec FR-PLT-009 AC3) — fictional, never customer data. The
// lines carry the Thai that breaks renderers: long runs without spaces that must wrap between words, stacked vowels
// and tone marks (ที่ ปั๊ม ผู้ใหญ่ ญี่ปุ่น ฤๅษี), marks under tall letters (ฎีกา ฐาน ปฏิบัติ), and sara am (น้ำ).

const organization = {
  name: 'บริษัท บีซีเอส สาธิต จำกัด',
  address: '99/9 ถนนพหลโยธิน แขวงสามเสนใน เขตพญาไท กรุงเทพมหานคร 10400',
  taxLine: 'เลขประจำตัวผู้เสียภาษี 0105599000017 · สำนักงานใหญ่',
}

const HARD = [
  { description: 'ปูนซีเมนต์ปอร์ตแลนด์ประเภทหนึ่งสำหรับงานโครงสร้างคอนกรีตเสริมเหล็กที่ต้องการกำลังอัดสูงบรรจุถุงละห้าสิบกิโลกรัมส่งถึงหน้างาน', quantity: '120', uom: 'ถุง', unitSatang: 18_550n },
  { description: 'น้ำมันเชื้อเพลิงดีเซลสำหรับเครื่องปั่นไฟและปั๊มน้ำของผู้ใหญ่บ้าน (ที่นั่งญี่ปุ่น กุ้งแห้ง ปู่ย่า อื้ออึง ฤๅษี ฎีกา ฐานราก ปฏิบัติงาน)', quantity: '2,000', uom: 'ลิตร', unitSatang: 3_194n },
  { description: 'ค่าจ้างเหมาซ่อมบำรุงหลังคาเมทัลชีทพร้อมรางน้ำฝน ทั้งนี้รวมค่าแรง ค่าขนส่ง และค่าเช่านั่งร้านแล้ว', quantity: '1', uom: 'งาน', unitSatang: 4_875_000n },
]

const approvals = [
  { name: 'นางสาวปฏิมา ฤทธิ์ณรงค์', position: 'ผู้จัดการฝ่าย · ฝ่ายก่อสร้าง', atText: '5 ต.ค. 2569 10:42 น.', channel: 'เว็บ', doaRef: 'DOA-DEMO ฉบับ 1 ข้อ PO-01' },
  { name: 'นายณัฐวุฒิ ศรีสุขใจ (ทำแทน นายปู่ ญี่ปุ่นดี)', position: 'รองประธานฝ่าย · ฝ่ายปฏิบัติการ', atText: '5 ต.ค. 2569 13:05 น.', channel: 'LINE (แชท)', doaRef: 'DOA-DEMO ฉบับ 1 ข้อ PO-01' },
]

function lines(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const base = HARD[i % HARD.length]!
    const amount = (BigInt(base.quantity.replace(/,/g, '')) * base.unitSatang) as bigint
    return { no: i + 1, description: i < HARD.length ? base.description : `${base.description} (รายการที่ ${i + 1})`, quantity: base.quantity, uom: base.uom, unitPrice: formatSatang(base.unitSatang), amount: formatSatang(amount), amountSatang: amount }
  })
}

function totals(items: ReturnType<typeof lines>) {
  const net = items.reduce((s, l) => s + l.amountSatang, 0n)
  const vat = (net * 7n + 50n) / 100n
  return { net: formatSatang(net), vatLabel: 'ภาษีมูลค่าเพิ่ม 7%', vat: formatSatang(vat), gross: formatSatang(net + vat), grossText: bahtText(net + vat) }
}

export function poDocument(lineCount = 3): PrintableDocument {
  const items = lines(lineCount)
  return {
    kind: 'PO',
    titleTh: 'ใบสั่งซื้อ',
    titleEn: 'Purchase Order',
    organization,
    number: 'PO-2569-000123',
    dateText: '6 ต.ค. 2569',
    counterparty: { label: 'ผู้ขาย', name: 'ห้างหุ้นส่วนจำกัด ศิริวัฒน์ก่อสร้างและวัสดุภัณฑ์', lines: ['123/45 หมู่ 6 ตำบลบ้านใหม่ อำเภอปากเกร็ด จังหวัดนนทบุรี 11120', 'เลขประจำตัวผู้เสียภาษี 0123556001234 · สาขา 00001'] },
    meta: [
      { label: 'สถานที่ส่ง', value: 'โครงการก่อสร้างอาคารสำนักงานแห่งใหม่ ไซต์งานบางนา' },
      { label: 'เงื่อนไขการชำระเงิน', value: 'เครดิต 30 วัน' },
      { label: 'อ้างอิงใบขอซื้อ', value: 'PR-2569-000456, PR-2569-000457' },
    ],
    amountHeader: 'จำนวนเงิน',
    lines: items.map(({ amountSatang: _, ...l }) => l),
    totals: totals(items),
    approvals,
    note: 'กรุณาแนบสำเนาใบสั่งซื้อนี้พร้อมใบส่งของ และออกใบกำกับภาษีในนามบริษัทตามที่อยู่ข้างต้น',
    footer: 'พิมพ์จากระบบ BCS · PO-2569-000123 · 6 ต.ค. 2569 09:00 น.',
  }
}

export function prDocument(): PrintableDocument {
  const items = lines(2)
  return {
    kind: 'PR',
    titleTh: 'ใบขอซื้อ',
    titleEn: 'Purchase Request',
    organization,
    number: 'PR-2569-000456',
    dateText: '3 ต.ค. 2569',
    counterparty: { label: 'ผู้ขอซื้อ', name: 'นายสมศักดิ์ ใจซื่อ', lines: ['ฝ่ายก่อสร้าง', 'งบประมาณ CON-OPEX-2569 ค่าใช้จ่ายดำเนินงาน ฝ่ายก่อสร้าง'] },
    meta: [
      { label: 'เรื่อง', value: 'วัสดุเทพื้นชั้นสอง' },
      { label: 'ประเภทคำขอ', value: 'ซื้อสินค้า' },
      { label: 'ต้องการใช้', value: '15 ต.ค. 2569' },
    ],
    amountHeader: 'จำนวนเงิน',
    lines: items.map(({ amountSatang: _, ...l }) => l),
    totals: totals(items),
    approvals: approvals.slice(0, 1),
    note: null,
    footer: 'พิมพ์จากระบบ BCS · PR-2569-000456 · 6 ต.ค. 2569 09:00 น.',
  }
}

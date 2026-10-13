import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { loadDoaRows, REG_PAGE_SIZE, regulationSentence } from './lib/ai-eval-agents'
import { AI_DOCS_DIR, loadEvalDocuments, ROOT, type EvalDocument } from './lib/ai-eval-cases'

// `pnpm ai:docs` (S13-05, ADR-146): draws every document of the AI evaluation set as the file an AI reads — a typed
// A4 PDF, an English template, a scan, a phone photo or a handwritten note — from DocSamples and
// tests/fixtures/ai-docs/cases.yaml, with Sarabun (OFL) from assets/fonts and CSS for skew, blur and stamps. Writes
// tests/fixtures/ai-docs/<id>.<pdf|jpg> and manifest.json (sha256 of each file, which a test holds the files to).
// The DOA drafter's two synthetic regulations (REG-A REG-B, FR-AI-308) are drawn too. The recorded answers of fixture
// mode come from `pnpm ai:eval --write-answers`.
// The PDF renderer stamps its own creation time, so drawing again changes the bytes: the committed files and their
// manifest are the evaluation set, and they are drawn again only when cases change.

const SARABUN = path.join(ROOT, 'assets', 'fonts', 'sarabun')
const fontFace = (weight: number, file: string) =>
  `@font-face{font-family:Sarabun;font-weight:${weight};src:url(data:font/ttf;base64,${readFileSync(path.join(SARABUN, file)).toString('base64')}) format('truetype')}`
const FONTS = fontFace(400, 'Sarabun-Regular.ttf') + fontFace(700, 'Sarabun-Bold.ttf')

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'
const MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const MONTHS_LONG = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const grouped = (amount: string) => {
  const [whole, frac] = amount.replace('-', '').split('.')
  return `${amount.startsWith('-') ? '-' : ''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`
}

function dateText(d: EvalDocument): string {
  const [y, m, day] = d.docDate.split('-').map(Number) as [number, number, number]
  if (d.language === 'EN' || (d.layout === 'EN_TEMPLATE' && d.dateStyle === 'BE')) return `${day} ${MONTHS_EN[m - 1]} ${y}`
  if (d.dateStyle === 'CE') return d.docDate
  if (d.dateStyle === 'BE_LONG') return `${day} ${MONTHS_LONG[m - 1]} ${y + 543}`
  return `${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y + 543} (${day} ${MONTHS_SHORT[m - 1]} ${y + 543})`
}

const TITLES = {
  TH: { QUOTATION: 'ใบเสนอราคา', DELIVERY_NOTE: 'ใบส่งของ', TAX_INVOICE: 'ใบแจ้งหนี้ / ใบกำกับภาษี' },
  EN: { QUOTATION: 'QUOTATION', DELIVERY_NOTE: 'DELIVERY NOTE', TAX_INVOICE: 'TAX INVOICE' },
} as const

function html(d: EvalDocument): string {
  const en = d.layout === 'EN_TEMPLATE' || d.language === 'EN'
  const L = en
    ? { no: 'No.', date: 'Date', taxId: 'Tax ID', branch: 'Branch', buyer: 'Customer', item: 'Description', qty: 'Qty', unit: 'Unit', price: 'Unit price', amount: 'Amount', net: 'Subtotal', discount: 'Discount', vat: 'VAT 7%', gross: 'Total', sign: 'Received by' }
    : { no: 'เลขที่', date: 'วันที่', taxId: 'เลขประจำตัวผู้เสียภาษี', branch: 'สาขา', buyer: 'ลูกค้า บริษัท สยามเมกะคอนสตรัคชั่น จำกัด (สำนักงานใหญ่)', item: 'รายการ', qty: 'จำนวน', unit: 'หน่วย', price: 'ราคาต่อหน่วย', amount: 'จำนวนเงิน', net: 'รวมเงินก่อนภาษี', discount: 'หักส่วนลด', vat: 'ภาษีมูลค่าเพิ่ม 7%', gross: 'รวมทั้งสิ้น', sign: 'ผู้รับของ' }
  const title = (en ? TITLES.EN : TITLES.TH)[d.docType] + (d.language === 'MIXED' && !en ? '' : d.language === 'MIXED' ? ` / ${TITLES.TH[d.docType]}` : '')
  const thai = (s: string) => (d.digits === 'THAI' ? s.replace(/\d/g, (c) => THAI_DIGITS[Number(c)]!) : s)
  const priced = d.docType !== 'DELIVERY_NOTE'
  const cur = d.currency === 'THB' ? (en ? 'THB' : 'บาท') : d.currency
  const rows = d.lines
    .map(
      (l, i) =>
        `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td class=n>${thai(grouped(l.qty))}</td><td>${esc(l.unit)}</td>${
          priced ? `<td class=n>${l.unitPrice ? thai(grouped(l.unitPrice)) : ''}</td><td class=n>${l.amount ? thai(grouped(l.amount)) : ''}</td>` : ''
        }</tr>`,
    )
    .join('')
  const branch = d.sellerBranch === '00000' ? (en ? 'Head office' : 'สำนักงานใหญ่') : `${en ? 'Branch' : 'สาขาที่'} ${d.sellerBranch}`
  const totals = priced
    ? `<table class=totals>
        ${d.discountTotal ? `<tr><td>${L.discount}</td><td class=n>${thai(grouped(d.discountTotal))}</td></tr>` : ''}
        <tr><td>${d.priceIncludesVat ? (en ? 'Price before VAT' : 'มูลค่าก่อนภาษี') : L.net}</td><td class=n>${thai(grouped(d.net!))}</td></tr>
        <tr><td>${d.vatRegistered ? L.vat : en ? 'VAT (not registered)' : 'ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม'}</td><td class=n>${thai(grouped(d.vat!))}</td></tr>
        <tr class=g><td>${L.gross} (${cur})</td><td class=n>${thai(grouped(d.gross!))}</td></tr>
        ${d.priceIncludesVat ? `<tr><td colspan=2>${en ? 'Prices include VAT' : 'ราคาสินค้ารวมภาษีมูลค่าเพิ่มแล้ว'}</td></tr>` : ''}
      </table>`
    : `<p class=sign>${L.sign} ........................................</p>`
  const hand = d.layout === 'HANDWRITTEN'
  const scan = d.layout === 'A4_SCANNED'
  const photo = d.layout === 'PHOTO'
  const tilt = d.quality === 'SKEWED' ? 1.6 : photo ? 2.4 : hand ? 0.8 : scan ? 0.4 : 0
  const blur = d.quality === 'BLURRY' ? 0.9 : photo ? 0.3 : 0
  const stamp = d.quality === 'STAMPED' ? `<div class=stamp>${en ? 'RECEIVED' : 'ได้รับแล้ว'}<br>${thai(dateText(d))}</div>` : ''
  return `<!doctype html><html lang=th><head><meta charset=utf-8><style>${FONTS}
    *{box-sizing:border-box} body{margin:0;background:${photo ? '#5d5a55' : scan ? '#d9d6cf' : '#fff'};font-family:Sarabun,sans-serif}
    .page{width:794px;min-height:1000px;margin:${photo ? '40px auto' : '0 auto'};padding:48px 56px;background:${scan ? '#f4f1ea' : '#fff'};
      color:${hand ? '#1d2f7a' : '#111'};font-size:15px;line-height:1.5;transform:rotate(${tilt}deg);filter:blur(${blur}px)${scan ? ' contrast(1.15) grayscale(0.4)' : ''};
      ${photo ? 'box-shadow:0 18px 40px rgba(0,0,0,.45);' : ''}${hand ? 'font-style:italic;letter-spacing:.3px;' : ''}}
    h1{font-size:${hand ? 22 : 26}px;margin:0 0 4px} .head{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #333;padding-bottom:12px;margin-bottom:16px}
    table{border-collapse:collapse;width:100%} .items th,.items td{border:1px solid #777;padding:4px 6px;vertical-align:top} .items th{background:${hand ? 'transparent' : '#eee'}}
    .n{text-align:right;white-space:nowrap} .totals{width:55%;margin:12px 0 0 auto} .totals td{padding:3px 6px} .g td{font-weight:700;border-top:2px solid #333}
    .sign{margin-top:48px} .stamp{position:absolute;right:90px;top:260px;border:4px solid #b3261e;color:#b3261e;border-radius:50%;width:150px;height:150px;
      display:flex;align-items:center;justify-content:center;text-align:center;font-weight:700;transform:rotate(-18deg);opacity:.75;font-size:15px}
    .wrap{position:relative}
  </style></head><body><div class=wrap><div class=page>
    <div class=head><div><h1>${esc(title)}</h1><div><b>${esc(d.sellerName)}</b></div>
      <div>${L.taxId} ${thai(d.sellerTaxId)} · ${esc(branch)}</div></div>
      <div><div>${L.no} ${d.docNo ? esc(thai(d.docNo)) : '..........'}</div><div>${L.date} ${esc(thai(dateText(d)))}</div></div></div>
    <p>${en ? `${L.buyer}: Siam Mega Construction Co., Ltd. (Head office)` : L.buyer} · ${L.taxId} ${thai(d.buyerTaxId)}</p>
    <table class=items><thead><tr><th>#</th><th>${L.item}</th><th>${L.qty}</th><th>${L.unit}</th>${priced ? `<th>${L.price}</th><th>${L.amount}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table>
    ${totals}
  </div>${stamp}</div></body></html>`
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function regulationHtml(id: string, clauses: readonly string[]): string {
  const pages = [clauses.slice(0, REG_PAGE_SIZE), clauses.slice(REG_PAGE_SIZE)]
  return `<!doctype html><html lang=th><head><meta charset=utf-8><style>${FONTS}
    body{margin:0;font-family:Sarabun,sans-serif;font-size:16px;line-height:1.7;color:#111}
    .p{width:794px;height:1100px;padding:64px 72px;box-sizing:border-box;position:relative;page-break-after:always}
    h1{font-size:22px;text-align:center;margin:0 0 4px} .sub{text-align:center;margin-bottom:24px} .no{position:absolute;bottom:40px;width:100%;left:0;text-align:center}
    li{margin-bottom:8px}
  </style></head><body>${pages
    .map(
      (list, p) =>
        `<div class=p>${p === 0 ? `<h1>ระเบียบบริษัท สยามเมกะคอนสตรัคชั่น จำกัด</h1><div class=sub>ว่าด้วยอำนาจอนุมัติ (สังเคราะห์ ${id}) พ.ศ. 2569</div>` : ''}<ol start=${p * REG_PAGE_SIZE + 1}>${list
          .map((c) => `<li>${esc(c)}</li>`)
          .join('')}</ol><div class=no>หน้า ${p + 1} / ${pages.length}</div></div>`,
    )
    .join('')}</body></html>`
}

async function main() {
  const docs = await loadEvalDocuments()
  mkdirSync(AI_DOCS_DIR, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 1 })
  const manifest: Array<{ id: string; file: string; mediaType: string; sha256: string; purpose: string }> = []
  for (const d of docs) {
    await page.setContent(html(d), { waitUntil: 'load' })
    // Typed documents are PDF files; scans, photos and handwriting are pictures
    const pdf = d.layout === 'A4_TYPED' || d.layout === 'EN_TEMPLATE'
    const bytes = pdf
      ? Buffer.from(await page.pdf({ format: 'A4', printBackground: true }))
      : Buffer.from(await page.screenshot({ type: 'jpeg', quality: 62, fullPage: true }))
    const file = `${d.id}.${pdf ? 'pdf' : 'jpg'}`
    writeFileSync(path.join(AI_DOCS_DIR, file), bytes)
    manifest.push({ id: d.id, file, mediaType: pdf ? 'application/pdf' : 'image/jpeg', sha256: sha256(bytes), purpose: d.purpose })
  }
  // The regulations of the DOA drafter (FR-AI-308): two numbered pages of clauses; REG-B starts the second band at 20,001
  const doaRows = await loadDoaRows()
  for (const [id, regB] of [['REG-A', false], ['REG-B', true]] as const) {
    await page.setContent(regulationHtml(id, doaRows.map((r) => regulationSentence(r, regB))), { waitUntil: 'load' })
    const bytes = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }))
    writeFileSync(path.join(AI_DOCS_DIR, `${id}.pdf`), bytes)
    manifest.push({ id, file: `${id}.pdf`, mediaType: 'application/pdf', sha256: sha256(bytes), purpose: 'DOA_DRAFT' })
  }
  await browser.close()
  writeFileSync(path.join(AI_DOCS_DIR, 'manifest.json'), `${JSON.stringify({ baseDate: '2026-10-01', files: manifest }, null, 2)}\n`)
  console.log(`ai:docs ${manifest.length} files → ${path.relative(ROOT, AI_DOCS_DIR)}`)
}

void main()

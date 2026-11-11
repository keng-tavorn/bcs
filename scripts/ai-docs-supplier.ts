import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { ROOT } from './lib/ai-eval-cases'
import { loadSupplierCases, SUPPLIER_DOCS_DIR, type SupplierCase } from './lib/ai-eval-supplier'

// `pnpm exec tsx scripts/ai-docs-supplier.ts` (S7-15 · ADR-146): draws the 12 documents of the Supplier Onboarding Agent's
// evaluation set from tests/fixtures/ai-docs/supplier/cases.yaml as the file a supplier sends — a typed A4 PDF, a grey
// scan or a photo of a page on a desk — with Sarabun (OFL) from assets/fonts and CSS for tilt, blur and a stamp. A
// company certificate (หนังสือรับรองบริษัท) and a VAT registration (ภ.พ.20) are drawn in a layout of their own, marked
// as synthetic; no seal or logo of a real office. Writes tests/fixtures/ai-docs/supplier/<id>.<pdf|jpg> and
// manifest.json (sha256 of each file). The PDF renderer stamps its own creation time, so drawing again changes the bytes
// and the recorded answers: the committed files are the evaluation set, drawn again only when cases change.

const SARABUN = path.join(ROOT, 'assets', 'fonts', 'sarabun')
const fontFace = (weight: number, file: string) =>
  `@font-face{font-family:Sarabun;font-weight:${weight};src:url(data:font/ttf;base64,${readFileSync(path.join(SARABUN, file)).toString('base64')}) format('truetype')}`
const FONTS = fontFace(400, 'Sarabun-Regular.ttf') + fontFace(700, 'Sarabun-Bold.ttf')

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'
const MONTHS_LONG = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
const MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function dateText(c: SupplierCase, iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return c.dates === 'BE_SHORT' ? `${d} ${MONTHS_SHORT[m - 1]} ${String(y + 543).slice(2)}` : `${d} ${MONTHS_LONG[m - 1]} พ.ศ. ${y + 543}`
}
const grouped = (n: string) => n.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
/** A tax id as the registries print it: 0-9999-98020-01-0 */
const taxIdText = (t: string) => `${t[0]}-${t.slice(1, 5)}-${t.slice(5, 10)}-${t.slice(10, 12)}-${t[12]}`
/** The header's name: the legal form abbreviated when the case says so */
const headerName = (c: SupplierCase) => (c.name === 'ABBREVIATED' ? c.nameTh.replace(/^บริษัท /, 'บจก. ').replace(/ จำกัด$/, '') : c.nameTh)

function companyCertificate(c: SupplierCase): string {
  const kind = c.nameTh.startsWith('ห้างหุ้นส่วน') ? 'ห้างหุ้นส่วนจำกัด' : c.nameTh.includes('(มหาชน)') ? 'บริษัทมหาชนจำกัด' : 'บริษัทจำกัด'
  const directors = (c.directors ?? []).map((d, i) => `<li>${i + 1}. ${esc(d)}</li>`).join('')
  return `
    <div class=title>หนังสือรับรอง</div>
    <div class=sub>สำนักงานทะเบียนหุ้นส่วนบริษัท (แบบจำลองเพื่อทดสอบระบบ)</div>
    <p class=lead>ขอรับรองว่า ${esc(headerName(c))} ได้จดทะเบียนเป็นนิติบุคคลประเภท${kind} ตามประมวลกฎหมายแพ่งและพาณิชย์
      เมื่อวันที่ ${esc(dateText(c, c.registrationDate))} ทะเบียนนิติบุคคลเลขที่ ${taxIdText(c.taxId)} ปรากฏข้อความในรายการตามเอกสารทะเบียนนิติบุคคล ณ วันออกหนังสือนี้ ดังนี้</p>
    <ol class=items>
      <li>ชื่อนิติบุคคล "${esc(c.nameTh)}"${c.nameEn ? ` (${esc(c.nameEn)})` : ''}</li>
      <li>กรรมการหรือหุ้นส่วนผู้จัดการ มี ${(c.directors ?? []).length} คน ตามรายชื่อดังต่อไปนี้<ul>${directors}</ul></li>
      <li>จำนวนหรือชื่อกรรมการซึ่งลงชื่อผูกพันนิติบุคคลได้ คือ กรรมการคนใดคนหนึ่งลงลายมือชื่อและประทับตราสำคัญของนิติบุคคล</li>
      ${c.capital ? `<li>ทุนจดทะเบียน ${grouped(c.capital)}.00 บาท</li>` : ''}
      <li>สำนักงานแห่งใหญ่ตั้งอยู่เลขที่ ${esc(c.registeredAddress)}</li>
      <li>วัตถุประสงค์ของนิติบุคคลมี 25 ข้อ ตามแบบ ว. ที่แนบ</li>
    </ol>
    <p class=issued>ออกให้ ณ วันที่ ${esc(dateText(c, c.issuedOn))}</p>
    <p class=sign>ลงชื่อ ................................................ นายทะเบียน</p>
    <p class=note>เอกสารสังเคราะห์สำหรับชุดประเมิน AI ของ BCS ไม่ใช่เอกสารราชการ</p>`
}

function vatRegistration(c: SupplierCase): string {
  const branch = c.branchCode === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${c.branchCode}`
  return `
    <div class=form>ภ.พ.20</div>
    <div class=title>ใบทะเบียนภาษีมูลค่าเพิ่ม</div>
    <div class=sub>(แบบจำลองเพื่อทดสอบระบบ)</div>
    <table class=grid>
      <tr><th>เลขประจำตัวผู้เสียภาษีอากร</th><td>${taxIdText(c.taxId)}</td></tr>
      <tr><th>ชื่อผู้ประกอบการ</th><td>${esc(headerName(c))}</td></tr>
      <tr><th>ชื่อสถานประกอบการ</th><td>${esc(c.nameTh)} (${esc(branch)})</td></tr>
      <tr><th>ที่ตั้งสถานประกอบการ</th><td>${esc(c.registeredAddress)}</td></tr>
      <tr><th>วันที่เริ่มประกอบกิจการ</th><td>${esc(dateText(c, c.registrationDate))}</td></tr>
    </table>
    <p class=lead>ได้จดทะเบียนภาษีมูลค่าเพิ่มตามประมวลรัษฎากร</p>
    <p class=issued>ให้ไว้ ณ วันที่ ${esc(dateText(c, c.issuedOn))}</p>
    <p class=sign>ลงชื่อ ................................................ เจ้าพนักงานสรรพากร</p>
    <p class=note>เอกสารสังเคราะห์สำหรับชุดประเมิน AI ของ BCS ไม่ใช่เอกสารราชการ</p>`
}

function html(c: SupplierCase): string {
  const scan = c.layout === 'A4_SCANNED'
  const photo = c.layout === 'PHOTO'
  const tilt = c.quality === 'SKEWED' ? (photo ? 3.2 : 1.6) : photo ? 2.2 : scan ? 0.5 : 0
  const blur = c.quality === 'BLURRY' ? 0.8 : photo ? 0.3 : 0
  const body = c.docType === 'COMPANY_CERT' ? companyCertificate(c) : vatRegistration(c)
  const thai = (s: string) => (c.digits === 'THAI' ? s.replace(/(>[^<]*)/g, (m) => m.replace(/\d/g, (d) => THAI_DIGITS[Number(d)]!)) : s)
  const stamp = c.quality === 'STAMPED' ? `<div class=stamp>สำเนาถูกต้อง</div><div class=signature>${esc(c.nameTh.split(' ')[1] ?? 'ลงชื่อ')}</div>` : ''
  return `<!doctype html><html lang=th><head><meta charset=utf-8><style>${FONTS}
    *{box-sizing:border-box} body{margin:0;background:${photo ? '#5d5a55' : scan ? '#d9d6cf' : '#fff'};font-family:Sarabun,sans-serif}
    .wrap{position:relative}
    .page{width:794px;min-height:1080px;margin:${photo ? '40px auto' : '0 auto'};padding:64px 72px;background:${scan ? '#f3f0e8' : '#fff'};color:#151515;font-size:16px;line-height:1.75;
      transform:rotate(${tilt}deg);filter:blur(${blur}px)${scan ? ' contrast(1.1) grayscale(0.5)' : ''};${photo ? 'box-shadow:0 18px 40px rgba(0,0,0,.45);' : ''}}
    .title{text-align:center;font-size:28px;font-weight:700;margin-top:8px} .sub{text-align:center;color:#444;margin-bottom:24px}
    .form{position:absolute;right:80px;top:56px;border:1px solid #333;padding:2px 10px;font-weight:700}
    .lead{text-indent:48px} .items{padding-left:24px} .items li{margin-bottom:6px} .items ul{list-style:none;padding-left:24px;margin:4px 0}
    .grid{width:100%;border-collapse:collapse;margin:12px 0 20px} .grid th{text-align:left;width:38%;padding:6px 8px;border-bottom:1px solid #999;font-weight:700;vertical-align:top}
    .grid td{padding:6px 8px;border-bottom:1px solid #999}
    .issued{margin-top:28px;text-align:right} .sign{margin-top:56px;text-align:right} .note{margin-top:48px;font-size:13px;color:#666;text-align:center}
    .stamp{position:absolute;left:330px;top:520px;border:5px double #1f3fa8;color:#1f3fa8;padding:10px 28px;font-size:26px;font-weight:700;transform:rotate(-14deg);opacity:.7}
    .signature{position:absolute;left:470px;top:590px;font-size:34px;font-style:italic;color:#1d2f7a;transform:rotate(-8deg);opacity:.8}
  </style></head><body><div class=wrap><div class=page>${thai(body)}</div>${stamp}</div></body></html>`
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function main() {
  const cases = loadSupplierCases()
  mkdirSync(SUPPLIER_DOCS_DIR, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 1240 }, deviceScaleFactor: 1 })
  const files: Array<{ id: string; file: string; mediaType: string; sha256: string }> = []
  for (const c of cases) {
    await page.setContent(html(c), { waitUntil: 'load' })
    // a typed document is a PDF file; a scan and a photo are pictures
    const pdf = c.layout === 'A4_TYPED'
    const bytes = pdf ? Buffer.from(await page.pdf({ format: 'A4', printBackground: true })) : Buffer.from(await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true }))
    const file = `${c.id}.${pdf ? 'pdf' : 'jpg'}`
    writeFileSync(path.join(SUPPLIER_DOCS_DIR, file), bytes)
    files.push({ id: c.id, file, mediaType: pdf ? 'application/pdf' : 'image/jpeg', sha256: sha256(bytes) })
  }
  await browser.close()
  writeFileSync(path.join(SUPPLIER_DOCS_DIR, 'manifest.json'), `${JSON.stringify({ files }, null, 2)}\n`)
  console.log(`ai:docs supplier ${files.length} files → ${path.relative(ROOT, SUPPLIER_DOCS_DIR)}`)
}

void main()

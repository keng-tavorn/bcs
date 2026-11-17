import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { ROOT } from './lib/ai-eval-cases'
import { loadRiskCases, RISK_DOCS_DIR, type RiskCase } from './lib/ai-eval-risk'

// `pnpm exec tsx scripts/ai-docs-risk.ts` (S11-14 · ADR-146): draws the 10 documents of the Risk Agent's evaluation set
// from tests/fixtures/ai-docs/risk/cases.yaml as the file a supplier sends — a typed A4 PDF, a grey scan or a photo of a
// page on a desk — with Sarabun (OFL) from assets/fonts and CSS for tilt, blur and a stamp: privacy, security and
// site-safety papers with their numbered sections, and company certificates (หนังสือรับรอง) in a layout of their own,
// each marked as synthetic, no seal or logo of a real office. Writes tests/fixtures/ai-docs/risk/<id>.<pdf|jpg> and
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

/** A date as the paper prints it: the Buddhist era, short when the case writes Thai digits (a photo of an older form) */
function dateText(c: RiskCase, iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return c.digits === 'THAI' ? `${d} ${MONTHS_SHORT[m - 1]} ${String(y + 543).slice(2)}` : `${d} ${MONTHS_LONG[m - 1]} พ.ศ. ${y + 543}`
}
const grouped = (n: string) => n.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const taxIdText = (t: string) => `${t[0]}-${t.slice(1, 5)}-${t.slice(5, 10)}-${t.slice(10, 12)}-${t[12]}`
const NOTE = '<p class=note>เอกสารสังเคราะห์สำหรับชุดประเมิน AI ของ BCS ไม่ใช่เอกสารจริงของบริษัทใด</p>'

function paper(c: RiskCase): string {
  const sections = (c.sections ?? []).map((s, i) => `<h2>${i + 1}. ${esc(s.heading)}</h2><p>${esc(s.body)}</p>`).join('')
  return `
    <div class=org>${esc(c.supplier)}</div>
    <div class=title>${esc(c.title)}</div>
    <div class=sub>ประกาศใช้ ณ วันที่ ${esc(dateText(c, c.issuedOn))}</div>
    ${sections}
    <p class=sign>ลงชื่อ ................................................ กรรมการผู้จัดการ</p>
    ${NOTE}`
}

function companyCertificate(c: RiskCase): string {
  const cert = c.certificate!
  const directors = cert.directors.map((d, i) => `<li>${i + 1}. ${esc(d)}</li>`).join('')
  return `
    <div class=title>${esc(c.title)}</div>
    <div class=sub>สำนักงานทะเบียนหุ้นส่วนบริษัท (แบบจำลองเพื่อทดสอบระบบ)</div>
    <p class=lead>ขอรับรองว่า ${esc(c.supplier)} ได้จดทะเบียนเป็นนิติบุคคลประเภทบริษัทจำกัด ตามประมวลกฎหมายแพ่งและพาณิชย์
      เมื่อวันที่ ${esc(dateText(c, cert.registrationDate))} ทะเบียนนิติบุคคลเลขที่ ${taxIdText(cert.taxId)} ปรากฏข้อความในรายการตามเอกสารทะเบียนนิติบุคคล ณ วันออกหนังสือนี้ ดังนี้</p>
    <ol class=items>
      <li>ชื่อนิติบุคคล "${esc(c.supplier)}"</li>
      <li>กรรมการ มี ${cert.directors.length} คน ตามรายชื่อดังต่อไปนี้<ul>${directors}</ul></li>
      <li>กรรมการคนใดคนหนึ่งลงลายมือชื่อและประทับตราสำคัญของบริษัท มีอำนาจลงนามผูกพันบริษัท</li>
      <li>ทุนจดทะเบียน ${grouped(cert.capital)}.00 บาท</li>
      <li>สำนักงานแห่งใหญ่ตั้งอยู่เลขที่ ${esc(cert.address)}</li>
    </ol>
    <p class=issued>ออกให้ ณ วันที่ ${esc(dateText(c, c.issuedOn))}</p>
    <p class=sign>ลงชื่อ ................................................ นายทะเบียน</p>
    ${NOTE}`
}

function html(c: RiskCase): string {
  const scan = c.layout === 'A4_SCANNED'
  const photo = c.layout === 'PHOTO'
  const tilt = c.quality === 'SKEWED' ? (photo ? 3.2 : 1.6) : photo ? 2.2 : scan ? 0.5 : 0
  const blur = c.quality === 'BLURRY' ? 0.8 : photo ? 0.3 : 0
  const body = c.group === 'COMPANY_CERT' ? companyCertificate(c) : paper(c)
  const thai = (s: string) => (c.digits === 'THAI' ? s.replace(/(>[^<]*)/g, (m) => m.replace(/\d/g, (d) => THAI_DIGITS[Number(d)]!)) : s)
  const stamp = c.quality === 'STAMPED' ? `<div class=stamp>สำเนาถูกต้อง</div><div class=signature>${esc(c.supplier.split(' ')[1] ?? 'ลงชื่อ')}</div>` : ''
  return `<!doctype html><html lang=th><head><meta charset=utf-8><style>${FONTS}
    *{box-sizing:border-box} body{margin:0;background:${photo ? '#5d5a55' : scan ? '#d9d6cf' : '#fff'};font-family:Sarabun,sans-serif}
    .wrap{position:relative}
    .page{width:794px;min-height:1080px;margin:${photo ? '40px auto' : '0 auto'};padding:56px 72px;background:${scan ? '#f3f0e8' : '#fff'};color:#151515;font-size:16px;line-height:1.7;
      transform:rotate(${tilt}deg);filter:blur(${blur}px)${scan ? ' contrast(1.1) grayscale(0.5)' : ''};${photo ? 'box-shadow:0 18px 40px rgba(0,0,0,.45);' : ''}}
    .org{text-align:right;font-weight:700;color:#333} .title{text-align:center;font-size:26px;font-weight:700;margin-top:8px} .sub{text-align:center;color:#444;margin-bottom:20px}
    h2{font-size:17px;margin:16px 0 4px} p{margin:0 0 6px} .lead{text-indent:48px}
    .items{padding-left:24px} .items li{margin-bottom:6px} .items ul{list-style:none;padding-left:24px;margin:4px 0}
    .issued{margin-top:28px;text-align:right} .sign{margin-top:48px;text-align:right} .note{margin-top:40px;font-size:13px;color:#666;text-align:center}
    .stamp{position:absolute;left:330px;top:480px;border:5px double #1f3fa8;color:#1f3fa8;padding:10px 28px;font-size:26px;font-weight:700;transform:rotate(-14deg);opacity:.7}
    .signature{position:absolute;left:470px;top:550px;font-size:34px;font-style:italic;color:#1d2f7a;transform:rotate(-8deg);opacity:.8}
  </style></head><body><div class=wrap><div class=page>${thai(body)}</div>${stamp}</div></body></html>`
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function main() {
  const { cases } = loadRiskCases()
  mkdirSync(RISK_DOCS_DIR, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 1240 }, deviceScaleFactor: 1 })
  const files: Array<{ id: string; file: string; mediaType: string; sha256: string }> = []
  for (const c of cases) {
    await page.setContent(html(c), { waitUntil: 'load' })
    // a typed document is a PDF file; a scan and a photo are pictures
    const pdf = c.layout === 'A4_TYPED'
    const bytes = pdf ? Buffer.from(await page.pdf({ format: 'A4', printBackground: true })) : Buffer.from(await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true }))
    const file = `${c.id}.${pdf ? 'pdf' : 'jpg'}`
    writeFileSync(path.join(RISK_DOCS_DIR, file), bytes)
    files.push({ id: c.id, file, mediaType: pdf ? 'application/pdf' : 'image/jpeg', sha256: sha256(bytes) })
  }
  await browser.close()
  writeFileSync(path.join(RISK_DOCS_DIR, 'manifest.json'), `${JSON.stringify({ files }, null, 2)}\n`)
  console.log(`ai:docs risk ${files.length} files → ${path.relative(ROOT, RISK_DOCS_DIR)}`)
}

void main()

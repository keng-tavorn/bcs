import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { amountToSatang, satangToAmount } from '../../src/core/money/dto'
import { lineNet } from '../../src/core/money/math'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '../../src/server/seed/workbook'

// The documents of the AI evaluation set, demo tier (S13-05, ADR-146, docs/sub-specs/S13.md "ชุดประเมิน"): the sheet
// DocSamples of the phase-1 workbook (the e-Tax files are left out: they never go to the AI, BR-AI-12) and the extra
// cases of tests/fixtures/ai-docs/cases.yaml. One shape for the file generator (pnpm ai:docs), the evaluation
// (pnpm ai:eval) and the tests. Dates are counted back from a fixed day so the files never change with the run date.

export const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const AI_DOCS_DIR = path.join(ROOT, 'tests', 'fixtures', 'ai-docs')
export const AI_ANSWERS_DIR = path.join(ROOT, 'tests', 'fixtures', 'ai')
/** The day the documents' dates count back from (ADR-146) */
export const DOC_BASE_DATE = '2026-10-01'

export type EvalDocType = 'QUOTATION' | 'DELIVERY_NOTE' | 'TAX_INVOICE'
export type EvalPurpose = 'QUOTATION_READ' | 'DELIVERY_NOTE_READ' | 'INVOICE_READ'
export const PURPOSE_OF_DOC: Readonly<Record<EvalDocType, EvalPurpose>> = { QUOTATION: 'QUOTATION_READ', DELIVERY_NOTE: 'DELIVERY_NOTE_READ', TAX_INVOICE: 'INVOICE_READ' }

export interface EvalLine {
  readonly description: string
  readonly qty: string
  readonly unit: string
  readonly unitPrice: string | null
  /** qty × unitPrice rounded half up (BR-MONEY-02); null on a delivery note */
  readonly amount: string | null
}

export interface EvalDocument {
  readonly id: string
  readonly source: 'DocSamples' | 'cases.yaml'
  readonly docType: EvalDocType
  readonly purpose: EvalPurpose
  readonly supplierCode: string
  readonly sellerName: string
  readonly sellerTaxId: string
  readonly sellerBranch: string
  readonly buyerTaxId: string
  /** null when the document has no number (DocSamples writes "ไม่มีเลขที่") */
  readonly docNo: string | null
  readonly docDate: string
  readonly currency: string
  readonly priceIncludesVat: boolean
  readonly vatRegistered: boolean
  readonly lines: readonly EvalLine[]
  readonly discountTotal: string | null
  readonly net: string | null
  readonly vat: string | null
  readonly gross: string | null
  readonly layout: string
  readonly quality: string
  readonly language: string
  /** How the date is printed: BE (dd/mm/yyyy in the Buddhist year, the default in Thai), BE_LONG (1 ตุลาคม 2569), CE */
  readonly dateStyle: 'BE' | 'BE_LONG' | 'CE'
  readonly digits: 'ARABIC' | 'THAI'
  readonly note: string | null
}

const money = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : satangToAmount(amountToSatang(String(v))))

export function docDateOf(daysAgo: number): string {
  const d = new Date(`${DOC_BASE_DATE}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

function lineOf(l: { description: string; qty: string | number; unit: string; unitPrice?: string | number | null }): EvalLine {
  const qty = String(l.qty)
  const unitPrice = money(l.unitPrice)
  return { description: l.description, qty, unit: l.unit, unitPrice, amount: unitPrice === null ? null : satangToAmount(lineNet(qty, amountToSatang(unitPrice))) }
}

const NO_NUMBER = 'ไม่มีเลขที่'

/** A document of tests/fixtures/ai-docs/cases.yaml as written */
interface CaseRow {
  sampleId: string
  docType: EvalDocType
  note?: string
  supplierCode: string
  sellerNameTh: string
  sellerTaxId: string
  sellerBranch: string
  docNo: string
  docDaysAgo: number
  priceIncludesVat: 'Y' | 'N'
  vatRegistered?: 'Y' | 'N'
  currency?: string
  lines: Array<{ description: string; qty: string; unit: string; unitPrice?: string }>
  discountTotal?: string
  net?: string
  vat?: string
  gross?: string
  layout: string
  quality: string
  language: string
  dateStyle?: EvalDocument['dateStyle']
  digits?: EvalDocument['digits']
}

export async function loadEvalDocuments(): Promise<EvalDocument[]> {
  const workbook = await loadInputWorkbook(path.join(ROOT, INPUT_WORKBOOKS.p1))
  const fromSheet = workbook
    .table('DocSamples')
    .map((r) => r.values)
    .filter((v) => v.docType !== 'ETAX_XML')
    .map((v): EvalDocument => {
      const docType = v.docType as EvalDocType
      return {
        id: v.sampleId!,
        source: 'DocSamples',
        docType,
        purpose: PURPOSE_OF_DOC[docType],
        supplierCode: v.supplierCode!,
        sellerName: v.sellerNameTh!,
        sellerTaxId: v.sellerTaxId!,
        sellerBranch: v.sellerBranch!,
        buyerTaxId: v.buyerTaxId!,
        docNo: v.docNo === NO_NUMBER ? null : (v.docNo ?? null),
        docDate: docDateOf(Number(v.docDaysAgo)),
        currency: 'THB',
        priceIncludesVat: v.priceIncludesVat === 'Y',
        vatRegistered: true,
        lines: (JSON.parse(v.linesJson ?? '[]') as Array<{ description: string; qty: number; unit: string; unitPrice?: string }>).map(lineOf),
        discountTotal: null,
        net: money(v.net),
        vat: money(v.vat),
        gross: money(v.gross),
        layout: v.layout!,
        quality: v.quality!,
        language: v.language!,
        dateStyle: 'BE',
        digits: 'ARABIC',
        note: v.notes ?? null,
      }
    })
  const file = parse(readFileSync(path.join(AI_DOCS_DIR, 'cases.yaml'), 'utf8')) as { buyerTaxId: string; cases: CaseRow[] }
  const extra = file.cases.map((c): EvalDocument => {
    const docType = c.docType
    return {
      id: c.sampleId,
      source: 'cases.yaml',
      docType,
      purpose: PURPOSE_OF_DOC[docType],
      supplierCode: c.supplierCode,
      sellerName: c.sellerNameTh,
      sellerTaxId: c.sellerTaxId,
      sellerBranch: c.sellerBranch,
      buyerTaxId: file.buyerTaxId,
      docNo: c.docNo === NO_NUMBER ? null : c.docNo,
      docDate: docDateOf(Number(c.docDaysAgo)),
      currency: c.currency ?? 'THB',
      priceIncludesVat: c.priceIncludesVat === 'Y',
      vatRegistered: c.vatRegistered !== 'N',
      lines: c.lines.map(lineOf),
      discountTotal: money(c.discountTotal),
      net: money(c.net),
      vat: money(c.vat),
      gross: money(c.gross),
      layout: c.layout,
      quality: c.quality,
      language: c.language,
      dateStyle: c.dateStyle ?? 'BE',
      digits: c.digits ?? 'ARABIC',
      note: c.note ?? null,
    }
  })
  return [...fromSheet, ...extra]
}

/** The reading a perfect answer gives (the evaluation's truth as the Document Agent's schema shapes it) */
export function truthReading(d: EvalDocument) {
  const fields = ['docNo', 'docDate', 'seller.taxId', 'seller.branch', 'buyer.taxId', 'net', 'vat', 'gross']
  return {
    docType: d.docType,
    docNo: d.docNo,
    docDate: d.docDate,
    currency: d.currency,
    priceIncludesVat: d.docType === 'DELIVERY_NOTE' ? null : d.priceIncludesVat,
    seller: { name: d.sellerName, taxId: d.sellerTaxId, branch: d.sellerBranch },
    buyer: { taxId: d.buyerTaxId },
    lines: d.lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, amount: l.amount })),
    discountTotal: d.discountTotal,
    net: d.net,
    vat: d.vat,
    gross: d.gross,
    confidence: fields.map((field) => ({ field, value: 95 })),
  }
}


import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { lineNet, vatFromGross, vatFromNet } from '@/core/money/math'
import { DocumentReading } from '@/lib/ai-schemas/document'
import { AI_ANSWERS_DIR, AI_DOCS_DIR, loadEvalDocuments, truthReading, type EvalDocument } from '../../scripts/lib/ai-eval-cases'

// The AI evaluation set, demo tier (S13-05, ADR-146, docs/sub-specs/S13.md "ชุดประเมิน"): at least 67 documents the AI
// reads (DocSamples without the e-Tax files, plus tests/fixtures/ai-docs/cases.yaml), each file exactly the one the
// manifest names, every amount of the extra cases what src/core/money computes, and a recorded answer for each so
// fixture mode runs without a key.

const VAT_BP = 700
let docs: EvalDocument[]
let manifest: { files: Array<{ id: string; file: string; mediaType: string; sha256: string; purpose: string }> }

beforeAll(async () => {
  docs = await loadEvalDocuments()
  manifest = JSON.parse(readFileSync(path.join(AI_DOCS_DIR, 'manifest.json'), 'utf8'))
}, 60_000)

describe('[BR-AI-26] the evaluation documents and their files', () => {
  it('[BR-AI-26] holds at least 67 documents the AI reads, at least 12 of them extra cases', () => {
    expect(docs.length).toBeGreaterThanOrEqual(67)
    expect(docs.filter((d) => d.source === 'cases.yaml').length).toBeGreaterThanOrEqual(12)
    const kinds = new Set(docs.map((d) => d.docType))
    expect([...kinds].sort()).toEqual(['DELIVERY_NOTE', 'QUOTATION', 'TAX_INVOICE'])
  })

  it('[BR-AI-26] every document has its file, and every file is byte for byte the one the manifest names', () => {
    const read = manifest.files.filter((f) => f.purpose !== 'DOA_DRAFT')
    expect(read.map((f) => f.id).sort()).toEqual(docs.map((d) => d.id).sort())
    // The two synthetic regulations of the DOA drafter (FR-AI-308)
    expect(manifest.files.filter((f) => f.purpose === 'DOA_DRAFT').map((f) => f.id)).toEqual(['REG-A', 'REG-B'])
    for (const f of manifest.files) {
      const bytes = readFileSync(path.join(AI_DOCS_DIR, f.file))
      expect(createHash('sha256').update(bytes).digest('hex'), f.file).toBe(f.sha256)
      const magic = bytes.subarray(0, 4).toString('latin1')
      expect(f.mediaType === 'application/pdf' ? magic === '%PDF' : bytes[0] === 0xff && bytes[1] === 0xd8, f.file).toBe(true)
    }
  })

  it('[BR-AI-26] every file has a recorded answer of the current prompt that fits the reading schema', () => {
    for (const f of manifest.files.filter((x) => x.purpose !== 'DOA_DRAFT')) {
      const answer = JSON.parse(readFileSync(path.join(AI_ANSWERS_DIR, f.purpose, `${f.sha256}.json`), 'utf8'))
      expect(DocumentReading.safeParse(answer.output).success, f.id).toBe(true)
      expect(answer.promptVersion, f.id).toBe(`${f.purpose}@1`)
    }
  })
})

describe('[BR-AI-14] every amount of the extra cases is what src/core/money computes', () => {
  it('[BR-AI-14] lines, discount, VAT on the net or inside the gross, and none for a seller not registered for VAT', () => {
    for (const d of docs.filter((x) => x.source === 'cases.yaml' && x.docType !== 'DELIVERY_NOTE')) {
      const sum = d.lines.reduce((n, l) => n + lineNet(l.qty, amountToSatang(l.unitPrice!)), 0n)
      expect(d.lines.map((l) => l.amount), d.id).toEqual(d.lines.map((l) => satangToAmount(lineNet(l.qty, amountToSatang(l.unitPrice!)))))
      const base = sum - (d.discountTotal ? amountToSatang(d.discountTotal) : 0n)
      if (!d.vatRegistered) {
        expect([d.net, d.vat, d.gross], d.id).toEqual([satangToAmount(base), '0.00', satangToAmount(base)])
      } else if (d.priceIncludesVat) {
        const v = vatFromGross(base, VAT_BP)
        expect([d.net, d.vat, d.gross], d.id).toEqual([satangToAmount(v.net), satangToAmount(v.vat), satangToAmount(base)])
      } else {
        const v = vatFromNet(base, VAT_BP)
        expect([d.net, d.vat, d.gross], d.id).toEqual([satangToAmount(base), satangToAmount(v.vat), satangToAmount(v.gross)])
      }
    }
  })

  it('[BR-AI-14] the truth of a reading keeps every document field the evaluation scores', () => {
    const doc049 = docs.find((d) => d.id === 'DOC-049')!
    expect(truthReading(doc049)).toMatchObject({ docNo: 'QT-05317', priceIncludesVat: true, net: '121200.00', vat: '8484.00', gross: '129684.00', seller: { taxId: '0999998010685' } })
    expect(docs.find((d) => d.id === 'DOC-055')!.docNo).toBeNull()
  })
})

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fieldScore } from '@/core/ai-checks'
import { fixtureKey } from '@/integrations/ai'
import { AWAITING_EVALUATION, EVAL_GATES, PROMPT_VERSIONS } from '@/lib/ai-config'
import { SupplierDocumentReading } from '@/lib/ai-schemas/supplier-document'
import { AI_ANSWERS_DIR, ROOT } from '../../scripts/lib/ai-eval-cases'
import { loadSupplierCases, SUPPLIER_DOCS_DIR, SUPPLIER_EVAL_FIELDS, supplierConfidenceOf, supplierFieldCorrect, supplierTruthReading } from '../../scripts/lib/ai-eval-supplier'

// S7-15 (FR-AI-304 AC5 · OQ-186 · ADR-146): the evaluation set of the Supplier Onboarding Agent, demo tier — 12 synthetic
// documents (7 company certificates, 5 VAT registrations of juristic persons, no bank book) drawn from their cases, each
// with the answer Claude gave when the gated prompt and model ran on the real API (recorded LIVE), and those answers
// score at or above every floor of OQ-186: the gate of src/lib/ai-config.ts names a report that is in the repository.

const cases = loadSupplierCases()
const manifest = new Map(
  (JSON.parse(readFileSync(path.join(SUPPLIER_DOCS_DIR, 'manifest.json'), 'utf8')) as { files: Array<{ id: string; file: string; mediaType: string; sha256: string }> }).files.map((f) => [f.id, f]),
)
const gate = EVAL_GATES.find((g) => g.purpose === 'SUPPLIER_DOC_READ')

function answerOf(id: string): { promptVersion: string; model: string; recorded?: string; output: unknown } | null {
  const m = manifest.get(id)!
  const key = fixtureKey({ purpose: 'SUPPLIER_DOC_READ', files: [{ bytes: readFileSync(path.join(SUPPLIER_DOCS_DIR, m.file)), mediaType: m.mediaType as 'application/pdf' }] } as never)
  const file = path.join(AI_ANSWERS_DIR, `${key}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { promptVersion: string; model: string; recorded?: string; output: unknown }) : null
}

describe('[FR-AI-304/AC5] the evaluation set of the Supplier Onboarding Agent, demo tier', () => {
  it('[FR-AI-304/AC5] holds 12 documents: 7 company certificates and 5 VAT registrations, no bank book (OQ-186), each a file of the manifest', () => {
    expect(cases).toHaveLength(12)
    expect(cases.filter((c) => c.docType === 'COMPANY_CERT')).toHaveLength(7)
    expect(cases.filter((c) => c.docType === 'VAT_CERT')).toHaveLength(5)
    expect(new Set(cases.map((c) => c.id)).size).toBe(12)
    for (const c of cases) {
      const m = manifest.get(c.id)
      expect(m, c.id).toBeDefined()
      const bytes = readFileSync(path.join(SUPPLIER_DOCS_DIR, m!.file))
      expect(createHash('sha256').update(bytes).digest('hex'), `${c.id}: the file is the one the manifest holds`).toBe(m!.sha256)
    }
    // the hard ones of the sub-spec: tilted photos, faded scans, a stamp across the text, an abbreviated name
    expect(cases.some((c) => c.layout === 'PHOTO')).toBe(true)
    expect(cases.some((c) => c.layout === 'A4_SCANNED')).toBe(true)
    expect(cases.some((c) => c.quality === 'STAMPED')).toBe(true)
    expect(cases.some((c) => c.name === 'ABBREVIATED')).toBe(true)
  })

  it('[FR-AI-304/AC5] the gate is SYNTHETIC for the prompt and model in use, and its report is in the repository', () => {
    expect(gate).toMatchObject({ agent: 'SUPPLIER_ONBOARDING', promptVersion: PROMPT_VERSIONS.SUPPLIER_DOC_READ, tier: 'SYNTHETIC' })
    expect(AWAITING_EVALUATION).not.toContain('SUPPLIER_DOC_READ')
    expect(existsSync(path.join(ROOT, 'docs', 'reports', 'ai-eval', gate!.report)), gate!.report).toBe(true)
  })

  it('[FR-AI-304/AC5] every document has the answer Claude gave with the gated prompt and model, and the answers meet every floor of OQ-186', () => {
    const tally = new Map<string, { correct: number; total: number; missed: number }>()
    for (const c of cases) {
      const answer = answerOf(c.id)
      expect(answer, `${c.id}: a recorded answer`).not.toBeNull()
      expect(answer!.recorded, c.id).toBe('LIVE')
      expect(answer!.promptVersion, c.id).toBe(gate!.promptVersion)
      expect(answer!.model, c.id).toBe(gate!.model)
      const read = SupplierDocumentReading.parse(answer!.output)
      expect(read).not.toHaveProperty('accountNo')
      for (const f of SUPPLIER_EVAL_FIELDS) {
        const key = `${c.docType}|${f.field}`
        const t = tally.get(key) ?? { correct: 0, total: 0, missed: 0 }
        const ok = supplierFieldCorrect(f.field, c, read)
        t.total++
        if (ok) t.correct++
        else if (supplierConfidenceOf(read, f.field) >= 90) t.missed++
        tally.set(key, t)
      }
    }
    for (const f of SUPPLIER_EVAL_FIELDS) {
      for (const docType of ['COMPANY_CERT', 'VAT_CERT']) {
        const t = tally.get(`${docType}|${f.field}`)!
        expect(fieldScore({ ...t, thresholdBp: f.thresholdBp, critical: f.critical }).pass, `${docType} ${f.field}: ${t.correct}/${t.total} · missed ${t.missed}`).toBe(true)
      }
    }
  })

  it('[FR-AI-304/AC5] the scorer reads a value the way a person checks it: the truth passes, a wrong digit or the label of the address does not', () => {
    const c = cases.find((x) => x.id === 'SC-01')!
    const truth = supplierTruthReading(c)
    for (const f of SUPPLIER_EVAL_FIELDS) expect(supplierFieldCorrect(f.field, c, truth), f.field).toBe(true)
    expect(supplierFieldCorrect('taxId', c, { taxId: '0-9999-98020-01-0' })).toBe(true)
    expect(supplierFieldCorrect('taxId', c, { taxId: '0999998020011' })).toBe(false)
    expect(supplierFieldCorrect('nameTh', c, { nameTh: 'บจก. ราชบุรีคอนสตรัคชั่น' })).toBe(true)
    expect(supplierFieldCorrect('registeredAddress', c, { registeredAddress: `สำนักงานแห่งใหญ่ตั้งอยู่เลขที่ ${c.registeredAddress}` })).toBe(false)
    expect(supplierFieldCorrect('registeredAddress', c, { registeredAddress: '๙๙ หมู่ ๔ ต.เจดีย์หัก อ.เมือง จ.ราชบุรี ๗๐๐๐๐' })).toBe(true)
    expect(supplierFieldCorrect('issuedOn', c, { issuedOn: null })).toBe(false)
  })
})

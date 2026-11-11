import { describe, expect, it } from 'vitest'
import { checkSupplierReading, shouldReadDocument, supplierFieldConfidence, type PayeeKind, type SupplierReading } from '@/core/ai-checks/supplier'
import { loadGolden } from './support'

// tests/golden/ai-supplier-verify.yaml (spec §12.7 · BR-AI-29 BR-AI-16 BR-AI-30 · S7-14): GC-AI-92 to GC-AI-95. expect is
// a subset: the checks named must be in the result, the confidence of the fields named, the fields confirmed one by one
// exactly.

type DocType = { validityDays?: number; aiReadable: boolean; aiReadablePayeeTypes: string[] }
interface Suite {
  fixture: { today: string; minConfidenceBp: number }
  types: Record<string, DocType>
  application: { taxId: string; branchCode: string; payeeType: PayeeKind; nameTh: string; address: string }
  registryData: { name: string; address: string }
  cases: Array<
    | { id: string; fn?: undefined; input: { docType: string; validityDays?: number; read: SupplierReading; confidence: Record<string, number> }; expect: { checks: { code: string; result: string }[]; confidenceBp: Record<string, number>; mustConfirm: string[] } }
    | { id: string; fn: 'shouldReadDocument'; input: { docType: string; payeeType: string }[]; expect: unknown[] }
  >
}

describe('[FR-AI-304/AC2] [BR-AI-29] golden ai-supplier-verify.yaml', () => {
  const suite = loadGolden('ai-supplier-verify') as unknown as Suite
  for (const c of suite.cases) {
    it(`${c.id}`, () => {
      if (c.fn === 'shouldReadDocument') {
        expect(c.input.map((i) => shouldReadDocument(suite.types[i.docType]!, i.payeeType))).toEqual(c.expect)
        return
      }
      const validityDays = c.input.validityDays ?? suite.types[c.input.docType]?.validityDays ?? null
      const checks = checkSupplierReading(c.input.read, { application: suite.application, registry: suite.registryData, validityDays, today: suite.fixture.today })
      expect(checks).toEqual(expect.arrayContaining(c.expect.checks))
      const confidence = supplierFieldConfidence(c.input.read, c.input.confidence, checks, suite.fixture.minConfidenceBp)
      for (const [field, bp] of Object.entries(c.expect.confidenceBp)) expect(confidence[field]?.confidenceBp, `${c.id} ${field}`).toBe(bp)
      expect(Object.entries(confidence).filter(([, v]) => v.mustConfirm).map(([k]) => k).sort()).toEqual([...c.expect.mustConfirm].sort())
    })
  }
})

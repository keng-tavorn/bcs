import { describe, expect, it } from 'vitest'
import { canVerify, documentExpiry, documentStatus, supersedeTargets, type ScanState, type SupplierDocumentState } from '@/core/supplier-docs'
import { loadYaml } from './doa-fixtures'

// tests/golden/supplier-documents.yaml (spec §7.22 · S7-03 · BR-SDOC-02 to BR-SDOC-04 · BR-PORTAL-07): GC-SUP-34 to
// GC-SUP-47 and GC-SUP-52 to GC-SUP-54. Every result is compared whole.

interface DocumentCase {
  id: string
  title?: string
  fn: 'documentExpiry' | 'documentStatus' | 'canVerify' | 'supersedeTargets'
  input: Record<string, unknown>
  expect: unknown
}
interface Suite {
  timezone: string
  types: Record<string, { validityDays: number | null; reminderDaysBefore: number }>
  cases: DocumentCase[]
}

const suite = loadYaml<Suite>('supplier-documents.yaml')

function run(c: DocumentCase): unknown {
  const i = c.input
  switch (c.fn) {
    case 'documentExpiry': {
      const type = suite.types[i.type as string]!
      const terms = {
        validityDays: 'validityDaysOverride' in i ? (i.validityDaysOverride as number) : type.validityDays,
        reminderDaysBefore: 'reminderDaysBefore' in i ? (i.reminderDaysBefore as number) : type.reminderDaysBefore,
      }
      const r = documentExpiry(terms, { issuedOn: i.issuedOn as string, expiresOn: (i.expiresOn as string | undefined) ?? null })
      if (!r.ok) return { error: r.code, reason: r.reason }
      const { ok: _ok, ...dates } = r
      return dates
    }
    case 'documentStatus':
      return documentStatus({ expiresOn: i.expiresOn as string, remindOn: i.remindOn as string }, new Date(i.now as string), suite.timezone)
    case 'canVerify': {
      const r = canVerify({ status: i.status as SupplierDocumentState, scanStatus: i.scanStatus as ScanState })
      return r.ok ? { ok: true } : { error: r.code, reason: r.reason }
    }
    case 'supersedeTargets':
      return supersedeTargets({ singleInstance: i.singleInstance as boolean }, i.newDoc as { scope: string | null }, i.verified as Array<{ id: string; scope: string | null }>)
  }
}

describe('[BR-SDOC-02] [BR-SDOC-03] [BR-SDOC-04] golden supplier-documents.yaml', () => {
  it('has the 17 cases of S7-03', () => {
    const ids = suite.cases.map((c) => c.id)
    expect(ids).toHaveLength(17)
    expect(ids[0]).toBe('GC-SUP-34')
    expect(ids.at(-1)).toBe('GC-SUP-54')
  })
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? c.fn}`, () => expect(run(c)).toEqual(c.expect))
  }
})

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  boundaryTable,
  DOA_DOCUMENT_TYPES,
  DOC_TYPE_TRAITS,
  lintDoaVersion,
  NO_AMOUNT_DOCUMENT_TYPES,
  requiredDocumentTypes,
  resolveRoute,
  type DoaVersionSnapshot,
  type RouteInput,
} from '@/core/doa'
import { APPROVAL_SUBJECTS } from '@/core/sod'
import { doaYaml, parseDoaYaml } from '@/server/doa/yaml'
import { DOC_TYPES, NO_AMOUNT_TYPES } from '@/ui/admin-doa/editor-model'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'

// The phase-1 document types of the shared base (P1-07, docs/sub-specs/P1.md "ชนิดเอกสาร DOA ใหม่"): traits as data,
// the amount rules BR-DOA-21 BR-DOA-22, the required types BR-DOA-23, and the lists screens keep of their own. The
// golden files doa-p1.yaml and doa-p1-lint.yaml hold the numbers; these tests hold what the golden format cannot say.

const P1 = { org: 'fixtures/org-p1.yaml', versions: 'fixtures/doa-versions-p1.yaml' }
const p1Version = (): DoaVersionSnapshot => versionSnapshots(P1.versions)[0]!
const AT = new Date('2026-10-06T03:00:00Z')

function route(input: Partial<RouteInput> & Pick<RouteInput, 'documentType'>) {
  return resolveRoute(
    { requesterMemberId: 'fin_officer', chargedDepartmentId: 'HQ', conflictMemberIds: ['fin_officer'], at: AT, ...input },
    { versions: [p1Version()], org: orgSnapshot([], P1.org), delegations: [] },
  )
}

describe('[FR-DOA-003/AC4] the phase-1 types through resolveRoute', () => {
  it('a type without an amount refuses one with reason AMOUNT_NOT_ALLOWED (BR-DOA-22)', () => {
    const r = route({ documentType: 'BANK_ACCOUNT_CHANGE', amount: { netSatang: 100n, vatSatang: 0n } })
    expect(r.ok ? null : { code: r.error.code, reason: r.error.details?.reason }).toEqual({ code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_ALLOWED' })
  })

  it('a type that needs an amount says which is wrong: none, or not above zero (BR-DOA-21)', () => {
    const none = route({ documentType: 'PAYMENT_RUN' })
    const zero = route({ documentType: 'BUDGET_TRANSFER', amount: { netSatang: 0n, vatSatang: 0n } })
    expect(none.ok ? null : none.error.details?.reason).toBe('AMOUNT_REQUIRED')
    expect(zero.ok ? null : zero.error.details?.reason).toBe('AMOUNT_NOT_POSITIVE')
  })

  it('the route explains the new types in Thai with their name', () => {
    const r = route({ documentType: 'PAYMENT_RUN', amount: { netSatang: 320_000_000n, vatSatang: 0n } })
    expect(r.ok && r.data.explanationTh).toContain('DOA-P1 ฉบับ 1 ข้อ PAY-01: รอบจ่ายเงินยอด 3,200,000.00 บาท')
  })

  it('every tier-1 type keeps its amount rule, so GC-DOA-01 to GC-DOA-27 cannot move (INV-DOA-03)', () => {
    expect(DOA_DOCUMENT_TYPES.slice(0, 5).map((t) => DOC_TYPE_TRAITS[t].amount)).toEqual(['REQUIRED', 'REQUIRED', 'OPTIONAL', 'OPTIONAL', 'OPTIONAL'])
  })
})

describe('[FR-DOA-003/AC5] a type the version has no rule for', () => {
  it('routes to DOA_NOT_CONFIGURED reason NO_RULE, never to a guessed approver', () => {
    const demo = versionSnapshots()[0]!
    const r = resolveRoute(
      { documentType: 'PO_CHANGE', amount: { netSatang: 100_000n, vatSatang: 7_000n }, requesterMemberId: 'proc_officer', chargedDepartmentId: 'CON', conflictMemberIds: ['proc_officer'], at: AT },
      { versions: [demo], org: orgSnapshot(), delegations: [] },
    )
    expect(r.ok ? null : { code: r.error.code, reason: r.error.details?.reason }).toEqual({ code: 'DOA_NOT_CONFIGURED', reason: 'NO_RULE' })
  })
})

describe('[FR-DOA-002/AC5] required types follow the modules that are on (BR-DOA-23)', () => {
  it('governance types always, the three PAY types only with PAY, in DOA_DOCUMENT_TYPES order', () => {
    expect(requiredDocumentTypes()).toEqual(['DOA_CHANGE', 'ORG_AUTHORITY_CHANGE'])
    expect(requiredDocumentTypes(['AI', 'PAY'])).toEqual(['DOA_CHANGE', 'ORG_AUTHORITY_CHANGE', 'INVOICE_EXCEPTION', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE'])
  })

  it('a version without the new types still lints clean when no module is passed (INV-DOA-03)', () => {
    const demo = versionSnapshots()[0]!
    expect(lintDoaVersion(demo, orgSnapshot(), demo.effectiveFrom)).toEqual({ errors: [], warnings: [] })
    expect(lintDoaVersion(demo, orgSnapshot(), demo.effectiveFrom, { modules: ['PAY'] }).errors.map((e) => e.documentType)).toEqual(['INVOICE_EXCEPTION', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE'])
  })
})

describe('[FR-DOA-009/AC5] a type without an amount has no boundary table', () => {
  it('even when a rule of it wrongly carries a band, the table stays empty and lint names the rule', () => {
    const v = p1Version()
    const banded = { ...v, rules: v.rules.map((r) => (r.code === 'BA-01' ? { ...r, when: { amount: { gt: 0n, lte: 100n } } } : r)) }
    expect(boundaryTable(banded, 'BANK_ACCOUNT_CHANGE')).toEqual([])
    expect(lintDoaVersion(banded, orgSnapshot([], P1.org), v.effectiveFrom, { modules: ['PAY'] }).errors).toEqual([{ code: 'DOA_LINT_AMOUNT_NOT_ALLOWED', rule: 'BA-01' }])
  })
})

describe('[FR-DOA-001/AC4] the editor knows every type', () => {
  it("the screens' lists equal the engine's (screens may not import src/core/doa)", () => {
    expect([...DOC_TYPES]).toEqual([...DOA_DOCUMENT_TYPES])
    expect([...NO_AMOUNT_TYPES]).toEqual([...NO_AMOUNT_DOCUMENT_TYPES])
  })

  it('every approval subject routes with exactly one document type (BR-DOA-20)', () => {
    const owners = APPROVAL_SUBJECTS.map((s) => DOA_DOCUMENT_TYPES.filter((t) => DOC_TYPE_TRAITS[t].subjects.includes(s)))
    expect(owners.map((o) => o.length)).toEqual(APPROVAL_SUBJECTS.map(() => 1))
  })

  it('YAML with the new types round-trips: import → export → import gives the same data', () => {
    const text = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions-p1.yaml'), 'utf8')
    const first = parseDoaYaml(text, new Map())
    if (!first.ok) throw new Error(JSON.stringify(first.error))
    expect(first.data[0]!.rules.map((r) => r.documentType)).toContain('BANK_ACCOUNT_CHANGE')
    expect(parseDoaYaml(doaYaml(first.data, new Map()), new Map())).toEqual(first)
  })
})

describe('[FR-DOA-001/AC5] YAML with a document type nobody knows', () => {
  it('is VALIDATION_FAILED with the path of the rule', () => {
    const text = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions-p1.yaml'), 'utf8').replace('documentType: PAYMENT_RUN', 'documentType: PAYMENT_BATCH')
    const parsed = parseDoaYaml(text, new Map())
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('VALIDATION_FAILED')
    const problems = parsed.error.details?.problems as { path: string }[]
    expect(problems.map((p) => p.path)).toContain('versions.0.rules.19.documentType')
  })
})

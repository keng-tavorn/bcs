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
    expect(r.ok && r.data.explanationTh).toContain('DOA-P1 ฉบับ 1 ข้อ PAY-01: รอบจ่ายเงินยอด 3,200,000.00 บาท อยู่ในช่วง')
    // A payment run carries no VAT, so the record never claims the amount includes it
    expect(r.ok && r.data.explanationTh).not.toContain('VAT')
  })

  it('a type with VAT keeps the basis in its explanation', () => {
    const r = route({ documentType: 'INVOICE_EXCEPTION', amount: { netSatang: 1_900_000n, vatSatang: 133_000n }, chargedDepartmentId: 'CON' })
    expect(r.ok && r.data.explanationTh).toContain('ยอด 20,330.00 บาท (รวม VAT)')
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

describe('[BR-DOA-26] the phase-2 type SUPPLIER_APPROVAL (S7-02 · ADR-182)', () => {
  it('has no amount, no VAT, is no policy change, routes SUPPLIER_APPLICATION, and SUPPLIER requires it with BANK_ACCOUNT_CHANGE', () => {
    expect(DOA_DOCUMENT_TYPES.indexOf('SUPPLIER_APPROVAL')).toBe(DOA_DOCUMENT_TYPES.indexOf('BANK_ACCOUNT_CHANGE') + 1)
    expect(DOC_TYPE_TRAITS.SUPPLIER_APPROVAL).toEqual({ amount: 'NONE', vat: false, governance: false, requiredWithModules: ['SUPPLIER'], subjects: ['SUPPLIER_APPLICATION'] })
    expect(DOC_TYPE_TRAITS.BANK_ACCOUNT_CHANGE.requiredWithModules).toEqual(['PAY', 'SUPPLIER'])
    expect(requiredDocumentTypes(['SUPPLIER'])).toEqual(['DOA_CHANGE', 'ORG_AUTHORITY_CHANGE', 'BANK_ACCOUNT_CHANGE', 'SUPPLIER_APPROVAL'])
    expect(requiredDocumentTypes(['PAY'])).not.toContain('SUPPLIER_APPROVAL')
    expect(NO_AMOUNT_DOCUMENT_TYPES).toContain('SUPPLIER_APPROVAL')
    // the editor hides its limit (NO_AMOUNT_TYPES is NO_AMOUNT_DOCUMENT_TYPES in the screen's own list)
    expect([...NO_AMOUNT_TYPES].sort()).toEqual([...NO_AMOUNT_DOCUMENT_TYPES].sort())
    expect([...DOC_TYPES]).toEqual([...DOA_DOCUMENT_TYPES])
  })

  it('YAML with SA-01 round-trips; an amount on it is refused by the engine', () => {
    const text = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions-p2.yaml'), 'utf8')
    const first = parseDoaYaml(text, new Map())
    if (!first.ok) throw new Error(JSON.stringify(first.error))
    expect(first.data[0]!.rules.map((r) => r.documentType)).toContain('SUPPLIER_APPROVAL')
    expect(parseDoaYaml(doaYaml(first.data, new Map()), new Map())).toEqual(first)
    const version = versionSnapshots('fixtures/doa-versions-p2.yaml')
    const input: RouteInput = { documentType: 'SUPPLIER_APPROVAL', amount: { netSatang: 100n, vatSatang: 0n }, requesterMemberId: 'proc_officer', chargedDepartmentId: 'PROC', conflictMemberIds: ['proc_officer'], at: new Date('2026-11-02T03:00:00Z') }
    expect(resolveRoute(input, { versions: version, org: orgSnapshot([], 'fixtures/org-p1.yaml'), delegations: [] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(boundaryTable(version[0]!, 'SUPPLIER_APPROVAL')).toEqual([])
  })
})

describe('[BR-DOA-27] the phase-2 type RFX_AWARD (S10-02 · ADR-202)', () => {
  it('has an amount with VAT, is no policy change, routes AWARD_DECISION, SOURCING requires it, and it follows SUPPLIER_APPROVAL', () => {
    // right after S7's type; S11's RISK_OVERRIDE follows it (ADR-069 appends, so no test pins the end of the list)
    expect(DOA_DOCUMENT_TYPES.indexOf('RFX_AWARD')).toBe(DOA_DOCUMENT_TYPES.indexOf('SUPPLIER_APPROVAL') + 1)
    expect(DOC_TYPE_TRAITS.RFX_AWARD).toEqual({ amount: 'REQUIRED', vat: true, governance: false, requiredWithModules: ['SOURCING'], subjects: ['AWARD_DECISION'] })
    expect(requiredDocumentTypes(['SUPPLIER', 'SOURCING'])).toEqual(['DOA_CHANGE', 'ORG_AUTHORITY_CHANGE', 'BANK_ACCOUNT_CHANGE', 'SUPPLIER_APPROVAL', 'RFX_AWARD'])
    expect(requiredDocumentTypes(['PAY', 'SUPPLIER'])).not.toContain('RFX_AWARD')
    expect(NO_AMOUNT_DOCUMENT_TYPES).not.toContain('RFX_AWARD')
    expect([...DOC_TYPES]).toEqual([...DOA_DOCUMENT_TYPES])
  })

  it('YAML with RA-01..03 round-trips; an award of no amount is refused; its boundary table has the RA bands', () => {
    const text = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions-p2.yaml'), 'utf8')
    const first = parseDoaYaml(text, new Map())
    if (!first.ok) throw new Error(JSON.stringify(first.error))
    expect(first.data[0]!.rules.filter((r) => r.documentType === 'RFX_AWARD').map((r) => r.code)).toEqual(['RA-01', 'RA-02', 'RA-03'])
    expect(parseDoaYaml(doaYaml(first.data, new Map()), new Map())).toEqual(first)
    const version = versionSnapshots('fixtures/doa-versions-p2.yaml')
    const org = orgSnapshot([], 'fixtures/org-p1.yaml')
    const input = (netSatang: bigint, vatSatang: bigint): RouteInput => ({
      documentType: 'RFX_AWARD',
      amount: { netSatang, vatSatang },
      requesterMemberId: 'proc_officer',
      chargedDepartmentId: 'PROC',
      conflictMemberIds: ['proc_officer'],
      at: new Date('2026-11-08T03:00:00Z'),
    })
    expect(resolveRoute(input(0n, 0n), { versions: version, org, delegations: [] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const noAmount: RouteInput = { documentType: 'RFX_AWARD', requesterMemberId: 'proc_officer', chargedDepartmentId: 'PROC', conflictMemberIds: ['proc_officer'], at: new Date('2026-11-08T03:00:00Z') }
    expect(resolveRoute(noAmount, { versions: version, org, delegations: [] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    // GROSS basis: 467,289.72 + VAT 32,710.28 = 500,000.00 stays with RA-01; one satang more goes to RA-02
    expect(resolveRoute(input(46_728_972n, 3_271_028n), { versions: version, org, delegations: [] })).toMatchObject({ ok: true, data: { ruleCode: 'RA-01' } })
    expect(resolveRoute(input(46_728_973n, 3_271_028n), { versions: version, org, delegations: [] })).toMatchObject({ ok: true, data: { ruleCode: 'RA-02' } })
    expect(boundaryTable(version[0]!, 'RFX_AWARD').length).toBeGreaterThan(0)
  })
})

describe('[FR-RSK-203/AC2] [BR-DOA-28] the phase-2 type RISK_OVERRIDE (S11-02 · ADR-226)', () => {
  const version = () => versionSnapshots('fixtures/doa-versions-p2.yaml')
  const org = () => orgSnapshot([], 'fixtures/org-p1.yaml')
  // the cap with VAT goes as the amount before VAT with VAT 0 (BR-DOA-28), so every basis gives the same band
  const override = (capSatang: bigint | null): RouteInput => ({
    documentType: 'RISK_OVERRIDE',
    ...(capSatang === null ? {} : { amount: { netSatang: capSatang, vatSatang: 0n } }),
    requesterMemberId: 'proc_officer',
    chargedDepartmentId: 'PROC',
    conflictMemberIds: ['proc_officer'],
    at: new Date('2026-11-09T03:00:00Z'),
  })

  it('has an amount without VAT, is no policy change, routes RISK_OVERRIDE, RISK requires it, and it follows RFX_AWARD', () => {
    expect(DOA_DOCUMENT_TYPES.indexOf('RISK_OVERRIDE')).toBe(DOA_DOCUMENT_TYPES.indexOf('RFX_AWARD') + 1)
    expect(DOC_TYPE_TRAITS.RISK_OVERRIDE).toEqual({ amount: 'REQUIRED', vat: false, governance: false, requiredWithModules: ['RISK'], subjects: ['RISK_OVERRIDE'] })
    expect(APPROVAL_SUBJECTS.indexOf('RISK_OVERRIDE')).toBe(APPROVAL_SUBJECTS.indexOf('AWARD_DECISION') + 1)
    expect(requiredDocumentTypes(['SUPPLIER', 'SOURCING', 'RISK'])).toEqual(['DOA_CHANGE', 'ORG_AUTHORITY_CHANGE', 'BANK_ACCOUNT_CHANGE', 'SUPPLIER_APPROVAL', 'RFX_AWARD', 'RISK_OVERRIDE'])
    expect(requiredDocumentTypes(['PAY', 'SUPPLIER', 'SOURCING'])).not.toContain('RISK_OVERRIDE')
    expect(NO_AMOUNT_DOCUMENT_TYPES).not.toContain('RISK_OVERRIDE')
    expect([...DOC_TYPES]).toEqual([...DOA_DOCUMENT_TYPES])
  })

  it('YAML with RO-01 RO-02 round-trips; a cap of zero or none is refused AMOUNT_NOT_POSITIVE / AMOUNT_REQUIRED', () => {
    const text = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions-p2.yaml'), 'utf8')
    const first = parseDoaYaml(text, new Map())
    if (!first.ok) throw new Error(JSON.stringify(first.error))
    expect(first.data[0]!.rules.filter((r) => r.documentType === 'RISK_OVERRIDE').map((r) => r.code)).toEqual(['RO-01', 'RO-02'])
    expect(parseDoaYaml(doaYaml(first.data, new Map()), new Map())).toEqual(first)
    const context = { versions: version(), org: org(), delegations: [] }
    expect(resolveRoute(override(0n), context)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'amount', reason: 'AMOUNT_NOT_POSITIVE' } } })
    expect(resolveRoute(override(null), context)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'amount', reason: 'AMOUNT_REQUIRED' } } })
  })

  it('the boundary table of RISK_OVERRIDE is [1,000,000.00 RO-01, 1,000,000.01 RO-02] and routing agrees with it', () => {
    expect(boundaryTable(version()[0]!, 'RISK_OVERRIDE')).toEqual([
      { amountSatang: 100_000_000n, ruleCode: 'RO-01' },
      { amountSatang: 100_000_001n, ruleCode: 'RO-02' },
    ])
    const context = { versions: version(), org: org(), delegations: [] }
    expect(resolveRoute(override(100_000_000n), context)).toMatchObject({ ok: true, data: { ruleCode: 'RO-01' } })
    expect(resolveRoute(override(100_000_001n), context)).toMatchObject({ ok: true, data: { ruleCode: 'RO-02' } })
  })

  it('the RO rules change no other type: every boundary table and route of phase 1, S7 and S10 is the same without them (ADR-069)', () => {
    const p2 = version()[0]!
    const withoutRo = { ...p2, rules: p2.rules.filter((r) => r.documentType !== 'RISK_OVERRIDE') }
    expect(withoutRo.rules.length).toBe(p2.rules.length - 2)
    for (const type of DOA_DOCUMENT_TYPES.filter((t) => t !== 'RISK_OVERRIDE')) {
      expect(boundaryTable(p2, type), type).toEqual(boundaryTable(withoutRo, type))
      for (const row of boundaryTable(p2, type)) {
        const input: RouteInput = { documentType: type, amount: { netSatang: row.amountSatang, vatSatang: 0n }, requesterMemberId: 'proc_officer', chargedDepartmentId: 'PROC', conflictMemberIds: ['proc_officer'], at: new Date('2026-11-09T03:00:00Z') }
        expect(resolveRoute(input, { versions: [p2], org: org(), delegations: [] }), type).toEqual(resolveRoute(input, { versions: [withoutRo], org: org(), delegations: [] }))
      }
    }
  })

  it('a version without RO rules lints clean until RISK is on, then misses RISK_OVERRIDE alone (BR-DOA-23)', () => {
    const p2 = version()[0]!
    const withoutRo = { ...p2, rules: p2.rules.filter((r) => r.documentType !== 'RISK_OVERRIDE') }
    expect(lintDoaVersion(withoutRo, org(), p2.effectiveFrom, { modules: ['PAY', 'SUPPLIER', 'SOURCING'] }).errors).toEqual([])
    expect(lintDoaVersion(withoutRo, org(), p2.effectiveFrom, { modules: ['PAY', 'SUPPLIER', 'SOURCING', 'RISK'] }).errors).toMatchObject([{ code: 'DOA_LINT_MISSING_DOCTYPE', documentType: 'RISK_OVERRIDE' }])
    expect(lintDoaVersion(p2, org(), p2.effectiveFrom, { modules: ['PAY', 'SUPPLIER', 'SOURCING', 'RISK'] }).errors).toEqual([])
  })
})


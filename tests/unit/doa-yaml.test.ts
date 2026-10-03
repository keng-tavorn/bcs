import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lintDoaVersion } from '@/core/doa'
import { doaYaml, parseDoaYaml } from '@/server/doa/yaml'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'

// FR-DOA-001 AC2: DOA YAML in the shape of the §7.4 fixture is imported and exported, and exporting an import gives
// the same data back (round trip).

const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
const noMembers = new Map<string, string>()

describe('[FR-DOA-001/AC2] DOA YAML import and export', () => {
  it('reads the §7.4 fixture into the same rules the golden runner builds', () => {
    const parsed = parseDoaYaml(FIXTURE, noMembers)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const golden = versionSnapshots()
    expect(parsed.data.map((v) => v.rules)).toEqual(golden.map((v) => v.rules))
    expect(parsed.data.map((v) => [v.code, v.versionNo, v.effectiveFrom.toISOString()])).toEqual(golden.map((v) => [v.code, v.versionNo, v.effectiveFrom.toISOString()]))
    expect(parsed.data[0]).toMatchObject({ stepUpThresholdSatang: 10_000_000n, sodPolicy: { approverMayReceive: false, requesterMayReceive: true } })
  })

  it('exports an import to the same data: import → export → import is unchanged, and times stay in Thai time', () => {
    const first = parseDoaYaml(FIXTURE, noMembers)
    if (!first.ok) throw new Error('fixture did not parse')
    const text = doaYaml(first.data, new Map())
    expect(text).toContain('effectiveFrom: 2026-10-01T00:00:00+07:00')
    expect(text).toContain('gt: "20000.00"')
    const second = parseDoaYaml(text, noMembers)
    expect(second).toEqual(first)
  })

  it('an imported version is ready for the full lint (BR-DOA-08)', () => {
    const parsed = parseDoaYaml(FIXTURE, noMembers)
    if (!parsed.ok) throw new Error('fixture did not parse')
    const v1 = { ...versionSnapshots()[0]!, rules: parsed.data[0]!.rules }
    expect(lintDoaVersion(v1, orgSnapshot(), new Date('2026-10-02T03:00:00Z')).errors).toEqual([])
  })

  it('a MEMBER approver is written with the member code and read back to the member id', () => {
    const memberRule = FIXTURE.replace('approver: { kind: POSITION_OF_ORG, position: COO }', 'approver: { kind: MEMBER, member: coo }')
    const parsed = parseDoaYaml(memberRule, new Map([['coo', 'member-id-coo']]))
    expect(parsed.ok && parsed.data[0]!.rules.find((r) => r.code === 'PO-01')!.steps[0]!.approver).toEqual({ kind: 'MEMBER', memberId: 'member-id-coo' })
    if (!parsed.ok) return
    expect(doaYaml(parsed.data, new Map([['member-id-coo', 'coo']]))).toContain('member: coo')
  })

  it.each([
    ['money without two decimals', FIXTURE.replace('lte: "20000.00"', 'lte: "20000"'), 'versions.0.rules.0.when.amount.lte'],
    ['an unknown document type', FIXTURE.replace('documentType: GR_VARIANCE', 'documentType: INVOICE'), 'versions.0.rules.5.documentType'],
    ['an extra key', FIXTURE.replace('collapseDuplicateApprovers: true', 'collapseDuplicateApprovers: true\n    approvers: []'), 'versions.0'],
    ['a time without an offset', FIXTURE.replace('"2026-10-01T00:00:00+07:00"', '"2026-10-01T00:00:00"'), 'versions.0.effectiveFrom'],
    ['an unknown member', FIXTURE.replace('approver: { kind: POSITION_OF_ORG, position: COO }', 'approver: { kind: MEMBER, member: ghost }'), 'versions.0.rules.3.approver.member'],
    ['a rule code used twice', FIXTURE.replace('code: PR-02, documentType', 'code: PR-01, documentType'), 'versions.0.rules.1.code'],
  ])('refuses %s and says where', (_label, text, where) => {
    const parsed = parseDoaYaml(text, noMembers)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('VALIDATION_FAILED')
    expect((parsed.error.details?.problems as Array<{ path: string }>).map((p) => p.path)).toContain(where)
  })

  it('refuses text that is not YAML', () => {
    expect(parseDoaYaml('versions: [', noMembers)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })
})

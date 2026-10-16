import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lintDoaVersion } from '@/core/doa'
import { ruleJson, ruleSnapshotFromRow } from '@/server/doa/snapshot'
import { doaYaml, parseDoaYaml } from '@/server/doa/yaml'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'

// S6-02 (FR-WF-102 AC3, FR-DOA-001 AC2): a committee step travels through the DOA YAML as `step: { mode: PARALLEL,
// quorum, quorumCount?, approvers }` and through DoaRule.steps (JSON) unchanged: exported and imported again it is the
// same data, and the fixture of suite workflow reads as the golden runner reads it.

const FIXTURE = readFileSync('tests/golden/fixtures/doa-committee.yaml', 'utf8')
const noMembers = new Map<string, string>()

describe('[FR-WF-102/AC3] committee steps in the DOA YAML and in DoaRule.steps', () => {
  it('the committee fixture imports as the golden runner reads it, and passes the full lint', () => {
    const parsed = parseDoaYaml(FIXTURE, noMembers)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
    const golden = versionSnapshots('fixtures/doa-committee.yaml')[0]!
    expect(parsed.data[0]!.rules).toEqual(golden.rules)
    const v1 = { ...golden, rules: parsed.data[0]!.rules }
    expect(lintDoaVersion(v1, orgSnapshot([], 'fixtures/org-s6.yaml'), v1.effectiveFrom)).toEqual({ errors: [], warnings: [] })
  })

  it('exported and imported again gives the same data (round trip)', () => {
    const parsed = parseDoaYaml(FIXTURE, noMembers)
    if (!parsed.ok) throw new Error('fixture did not parse')
    const text = doaYaml(parsed.data, new Map())
    expect(text).toContain('step:')
    expect(text).toContain('quorum: MAJORITY')
    const again = parseDoaYaml(text, noMembers)
    expect(again.ok && again.data).toEqual(parsed.data)
  })

  it('a COUNT committee keeps its count, and a named member travels by code', () => {
    const count = FIXTURE.replace('step: { mode: PARALLEL, quorum: MAJORITY,', 'step: { mode: PARALLEL, quorum: COUNT, quorumCount: 3,').replace(
      '{ kind: POSITION_OF_ORG, position: PC3 }',
      '{ kind: MEMBER, member: E-PROC }',
    )
    const parsed = parseDoaYaml(count, new Map([['E-PROC', 'member-id-proc']]))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
    const step = parsed.data[0]!.rules.find((r) => r.code === 'PR-02')!.steps[0]!
    expect(step).toEqual({
      approvers: [
        { kind: 'POSITION_OF_ORG', position: 'PC1' },
        { kind: 'POSITION_OF_ORG', position: 'PC2' },
        { kind: 'MEMBER', memberId: 'member-id-proc' },
      ],
      slaBusinessMinutes: 960,
      mode: 'PARALLEL',
      quorum: 'COUNT',
      quorumCount: 3,
    })
    const text = doaYaml(parsed.data, new Map([['member-id-proc', 'E-PROC']]))
    expect(text).toContain('member: E-PROC')
    expect(parseDoaYaml(text, new Map([['E-PROC', 'member-id-proc']]))).toEqual(parsed)
  })

  it('a rule names either an approver or a committee, and an unknown committee member is named with its path', () => {
    const both = FIXTURE.replace('step: { mode: PARALLEL,', 'approver: { kind: POSITION_OF_ORG, position: CEO }, step: { mode: PARALLEL,')
    expect(parseDoaYaml(both, noMembers)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const unknown = FIXTURE.replace('{ kind: POSITION_OF_ORG, position: PC3 }', '{ kind: MEMBER, member: NOBODY }')
    expect(parseDoaYaml(unknown, noMembers)).toMatchObject({ ok: false, error: { details: { problems: [{ path: 'versions.0.rules.1.step.approvers.2.member', issue: 'UNKNOWN_MEMBER' }] } } })
  })

  it('DoaRule.steps stores a committee and reads it back unchanged', () => {
    const rule = versionSnapshots('fixtures/doa-committee.yaml')[0]!.rules.find((r) => r.code === 'PR-02')!
    const json = ruleJson(rule)
    expect(json.steps).toEqual([
      { approvers: [{ kind: 'POSITION_OF_ORG', position: 'PC1' }, { kind: 'POSITION_OF_ORG', position: 'PC2' }, { kind: 'POSITION_OF_ORG', position: 'PC3' }], slaBusinessMinutes: 960, mode: 'PARALLEL', quorum: 'MAJORITY' },
    ])
    const back = ruleSnapshotFromRow({ code: rule.code, documentType: json.documentType, priority: rule.priority, when: json.when, steps: json.steps, descriptionTh: null })
    expect(back).toEqual(rule)
    // A step with both an approver and a committee, or a committee mode other than PARALLEL, is not a stored step
    expect(() => ruleSnapshotFromRow({ code: 'X', documentType: 'PURCHASE_REQUEST', priority: 1, when: {}, steps: [{ approvers: [], slaBusinessMinutes: 60, mode: 'PARALLEL', quorum: 'ALL' }], descriptionTh: null })).toThrow(/DOA rule X/)
    expect(() =>
      ruleSnapshotFromRow({ code: 'Y', documentType: 'PURCHASE_REQUEST', priority: 1, when: {}, steps: [{ approvers: [{ kind: 'POSITION_OF_ORG', position: 'CEO' }], slaBusinessMinutes: 60, mode: 'SEQUENTIAL', quorum: 'ALL' }], descriptionTh: null }),
    ).toThrow(/DOA rule Y/)
  })
})

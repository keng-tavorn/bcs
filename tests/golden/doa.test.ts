import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { boundaryTable, lintDoaVersion, resolveRoute, type DoaDocumentType, type DoaVersionSnapshot, type LintIssue } from '@/core/doa'
import { baht, fixturesOf, GOLDEN_DIR, loadYaml, orgSnapshot, pick, ruleSnapshot, versionSnapshots, type FixturePair, type RuleFixture } from './doa-fixtures'

// Every golden file of suite doa and doa-lint (spec §7.4): doa.yaml doa-lint.yaml (GC-DOA-01 to GC-DOA-27) and
// doa-p1.yaml doa-p1-lint.yaml (GC-DOA-28 to GC-DOA-68). Each file names its own fixtures (ADR-069). The runner finds
// and counts the cases itself; every test name carries the case id.

interface Suite<C> {
  suite: string
  fixtures?: string[]
  defaults?: Record<string, unknown>
  cases: C[]
}

const filesOf = (suite: string) =>
  readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .filter((f) => loadYaml<{ suite?: string }>(f).suite === suite)

interface RouteCase {
  id: string
  title?: string
  input: Record<string, unknown>
  expect: Record<string, unknown>
}

describe.each(filesOf('doa'))('golden %s (resolveRoute)', (file) => {
  const doa = loadYaml<Suite<RouteCase>>(file)
  const fx = fixturesOf(doa.fixtures)
  const defaults = doa.defaults as { documentType: DoaDocumentType; requester: string; department: string; at: string }
  it('has cases', () => expect(doa.cases.length).toBeGreaterThan(0))
  for (const c of doa.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const i = { ...defaults, ...c.input } as typeof defaults & {
        amount?: string
        net?: string
        vat?: string
        alsoConflicting?: string[]
        vacate?: string[]
        amountBasis?: 'GROSS' | 'NET'
      }
      let versions = versionSnapshots(fx.versions)
      if (i.amountBasis) versions = versions.map((v) => ({ ...v, amountBasis: i.amountBasis! }))
      const amount =
        i.net !== undefined ? { netSatang: amountToSatang(i.net), vatSatang: amountToSatang(i.vat ?? '0') } : i.amount !== undefined ? { netSatang: amountToSatang(i.amount), vatSatang: 0n } : undefined
      const result = resolveRoute(
        {
          documentType: i.documentType,
          ...(amount ? { amount } : {}),
          requesterMemberId: i.requester,
          chargedDepartmentId: i.department,
          conflictMemberIds: [i.requester, ...(i.alsoConflicting ?? [])],
          at: new Date(i.at),
        },
        { versions, org: orgSnapshot(i.vacate ?? [], fx.org), delegations: [] },
      )
      const actual = result.ok
        ? {
            version: result.data.versionNo,
            rule: result.data.escalatedFromRuleCode ?? result.data.ruleCode,
            ...(result.data.escalatedFromRuleCode ? { escalatedTo: result.data.ruleCode } : {}),
            approvers: result.data.steps.map((s) => s.assigneeMemberId),
          }
        : { error: result.error.code }
      expect(pick(actual, c.expect)).toEqual(c.expect)
      // No stated escalation means none happened
      if (result.ok && !('escalatedTo' in c.expect)) expect(result.data.escalatedFromRuleCode).toBeNull()
    })
  }
})

interface LintCase {
  id: string
  title?: string
  fn: 'lintDoaVersion' | 'boundaryTable'
  input: { base: number; replaceRules?: RuleFixture[]; removeRules?: string[]; vacate?: string[]; documentType?: DoaDocumentType; modules?: string[] }
  expect: Record<string, unknown>
}

function baseVersion(input: LintCase['input'], fx: FixturePair): DoaVersionSnapshot {
  const base = versionSnapshots(fx.versions).find((v) => v.versionNo === input.base)!
  const replaced = new Map((input.replaceRules ?? []).map((r) => [r.code, ruleSnapshot(r)]))
  const rules = base.rules.filter((r) => !(input.removeRules ?? []).includes(r.code)).map((r) => replaced.get(r.code) ?? r)
  return { ...base, rules }
}

const issueOut = (issue: LintIssue) => ({
  code: issue.code,
  ...(issue.documentType ? { documentType: issue.documentType } : {}),
  ...(issue.rule ? { rule: issue.rule } : {}),
  ...(issue.gt !== undefined ? { gt: baht(issue.gt) } : {}),
  ...(issue.lte !== undefined ? { lte: issue.lte === null ? null : baht(issue.lte) } : {}),
})

describe.each(filesOf('doa-lint'))('golden %s (lintDoaVersion, boundaryTable)', (file) => {
  const lint = loadYaml<Suite<LintCase>>(file)
  const fx = fixturesOf(lint.fixtures)
  it('has cases', () => expect(lint.cases.length).toBeGreaterThan(0))
  for (const c of lint.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const version = baseVersion(c.input, fx)
      if (c.fn === 'boundaryTable') {
        const rows = boundaryTable(version, c.input.documentType!).map((r) => ({ amount: baht(r.amountSatang), rule: r.ruleCode }))
        expect({ rows }).toEqual(c.expect)
        return
      }
      const result = lintDoaVersion(version, orgSnapshot(c.input.vacate ?? [], fx.org), version.effectiveFrom, { modules: c.input.modules ?? [] })
      expect({ errors: result.errors.map(issueOut), warnings: result.warnings.map(issueOut) }).toEqual(c.expect)
    })
  }
})

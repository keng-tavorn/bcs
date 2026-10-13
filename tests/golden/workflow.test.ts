import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { isCommitteeStep, lintDoaVersion, resolveRoute, type ApproverSpec, type CommitteeQuorum, type DoaDocumentType, type DoaVersionSnapshot, type LintIssue, type OrgSnapshot, type RouteStep } from '@/core/doa'
import { lintWorkflowVersion, resolveRequestRoute, stepOutcome, type Quorum, type SlotDecision, type SlotGroup, type WorkflowLintIssue, type WorkflowRuleSnapshot } from '@/core/workflow'
import { baht, GOLDEN_DIR, loadYaml, orgSnapshot, pick, versionSnapshots } from './doa-fixtures'
import { workflowFixture, workflowRuleOf, type WorkflowRuleFixture } from './workflow-fixtures'

// Every golden file of suite workflow (spec §7.17): committees, the outcome of a step of several slots and the DOA lint
// of BR-WF-05 (S6-02); the route of a request with its parallel reviewers and the workflow lint (S6-03). Each file names
// its own fixtures (ADR-069): one org file, the DOA version files (versions told apart by code) and the workflow
// versions. The runner finds and counts the cases itself; every test name carries the case id.

interface Suite {
  suite: string
  fixtures: string[]
  defaults: { documentType: DoaDocumentType; doa: string; workflow: string; requester: string; department: string; at: string }
  cases: Case[]
}

interface Case {
  id: string
  title?: string
  fn: 'resolveRoute' | 'stepOutcome' | 'lintDoaVersion' | 'resolveRequestRoute' | 'lintWorkflowVersion'
  input: Record<string, unknown>
  expect: Record<string, unknown>
}

interface StepReplace {
  rule: string
  quorum?: CommitteeQuorum
  quorumCount?: number
  approvers?: Array<{ kind: 'POSITION_OF_DEPARTMENT' | 'POSITION_OF_ORG'; position: string }>
}

const files = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .filter((f) => loadYaml<{ suite?: string }>(f).suite === 'workflow')

/** The org of the file, with positions vacated and holders replaced ("PC3@HQ": coo) */
function orgOf(file: string, vacate: readonly string[], replaceHolders: Record<string, string>): OrgSnapshot {
  const org = orgSnapshot(vacate, file)
  return {
    ...org,
    holders: org.holders.map((h) => {
      const department = org.departments.find((d) => d.id === h.departmentId)!
      const to = replaceHolders[`${h.positionCode}@${department.code}`]
      return to ? { ...h, memberId: to } : h
    }),
  }
}

/** The versions of one DOA code, with a rule's committee step changed (replaceStep); quorumCount stays on COUNT only */
function versionsOf(suite: Suite, code: string, replace: StepReplace | undefined): DoaVersionSnapshot[] {
  const all = suite.fixtures.filter((f) => f.includes('/doa-')).flatMap((f) => versionSnapshots(f))
  return all
    .filter((v) => v.code === code)
    .map((v) => ({
      ...v,
      rules: v.rules.map((r) => {
        if (!replace || r.code !== replace.rule) return r
        const step = r.steps[0]!
        if (!isCommitteeStep(step)) throw new Error(`${r.code} is not a committee`)
        const quorum = replace.quorum ?? step.quorum
        const quorumCount = quorum === 'COUNT' ? (replace.quorumCount ?? step.quorumCount) : undefined
        const approvers: ApproverSpec[] = replace.approvers ?? [...step.approvers]
        return { ...r, steps: [{ approvers, slaBusinessMinutes: step.slaBusinessMinutes, mode: step.mode, quorum, ...(quorumCount !== undefined ? { quorumCount } : {}) }] }
      }),
    }))
}

const stepOut = (s: RouteStep) =>
  s.committee
    ? { mode: 'PARALLEL', quorum: s.committee.quorum, ...(s.committee.quorumCount !== null ? { quorumCount: s.committee.quorumCount } : {}), approvers: s.committee.slots.map((x) => x.assigneeMemberId) }
    : { mode: 'SEQUENTIAL', approvers: [s.assigneeMemberId] }

const wfIssueOut = (issue: WorkflowLintIssue) => ({ code: issue.code, rule: issue.rule, ...(issue.field ? { field: issue.field } : {}) })

const issueOut = (issue: LintIssue) => ({
  code: issue.code,
  ...(issue.documentType ? { documentType: issue.documentType } : {}),
  ...(issue.rule ? { rule: issue.rule } : {}),
  ...(issue.gt !== undefined ? { gt: baht(issue.gt) } : {}),
  ...(issue.lte !== undefined ? { lte: issue.lte === null ? null : baht(issue.lte) } : {}),
})

describe.each(files)('golden %s (workflow)', (file) => {
  const suite = loadYaml<Suite>(file)
  const orgFile = suite.fixtures.find((f) => f.includes('/org-'))!
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const i = { ...suite.defaults, ...c.input } as Suite['defaults'] & {
        amount?: string
        alsoConflicting?: string[]
        vacate?: string[]
        replaceHolders?: Record<string, string>
        replaceStep?: StepReplace
      }
      const org = orgOf(orgFile, i.vacate ?? [], i.replaceHolders ?? {})
      const versions = versionsOf(suite, i.doa, i.replaceStep)
      const workflow = workflowFixture(suite.fixtures)
      if (c.fn === 'lintWorkflowVersion') {
        const input = c.input as { addRules?: WorkflowRuleFixture[]; replaceWhen?: { rule: string; when: WorkflowRuleSnapshot['when'] }; removeFallback?: string[] }
        const base = workflow.versions.find((v) => v.code === i.workflow)!
        const rules = [...base.rules, ...(input.addRules ?? []).map((r, n) => workflowRuleOf(r, base.rules.length + n))].map((r) => ({
          ...r,
          ...(input.replaceWhen?.rule === r.code ? { when: input.replaceWhen.when } : {}),
          ...((input.removeFallback ?? []).includes(r.code) ? { fallback: null } : {}),
        }))
        const result = lintWorkflowVersion({ ...base, rules }, org, workflow.requestTypes, base.effectiveFrom)
        expect({ errors: result.errors.map(wfIssueOut), warnings: result.warnings.map(wfIssueOut) }).toEqual(c.expect)
        return
      }
      if (c.fn === 'resolveRequestRoute') {
        const r = c.input as { requestType: string; amount?: string; net?: string; vat?: string; lineCategories?: string[]; budgetAccountCodes?: string[]; fields?: Record<string, unknown> }
        const net = r.net !== undefined ? amountToSatang(r.net) : amountToSatang(r.amount!)
        const vat = r.vat !== undefined ? amountToSatang(r.vat) : 0n
        const result = resolveRequestRoute(
          { documentType: 'PURCHASE_REQUEST', amount: { netSatang: net, vatSatang: vat }, requesterMemberId: i.requester, chargedDepartmentId: i.department, conflictMemberIds: [i.requester, ...(i.alsoConflicting ?? [])], at: new Date(i.at) },
          { requestType: r.requestType, amountGross: net + vat, amountNet: net, lineCategories: r.lineCategories ?? [], budgetAccountCodes: r.budgetAccountCodes ?? [], fields: r.fields ?? {} },
          { versions, org, delegations: [], workflows: workflow.versions },
        )
        if (!result.ok) {
          expect(pick({ error: result.error.code, rule: result.error.details?.rule }, c.expect)).toEqual(c.expect)
          return
        }
        const { review, approval } = result.data
        const counts = review?.groups.filter((g) => g.quorum === 'COUNT') ?? []
        const actual = {
          review: review && {
            quorum: 'ALL',
            slots: review.slots.map((s) => ({ rules: s.ruleCodes, reviewers: s.assignees.map((a) => a.assigneeMemberId), ...(s.fallback ? { fallback: s.fallback } : {}) })),
            ...(counts.length ? { groups: counts.map((g) => ({ rules: g.ruleCodes, quorum: g.quorum, quorumCount: g.quorumCount, slots: g.slotNos })) } : {}),
          },
          approval: {
            rule: approval.escalatedFromRuleCode ?? approval.ruleCode,
            ...(approval.escalatedFromRuleCode ? { escalatedTo: approval.ruleCode } : {}),
            approvers: approval.steps.map((s) => s.assigneeMemberId),
          },
        }
        expect(pick(actual, c.expect)).toEqual(c.expect)
        return
      }
      if (c.fn === 'stepOutcome') {
        const input = c.input as { kind?: 'APPROVAL' | 'REVIEW'; quorum?: Quorum; quorumCount?: number; groups?: SlotGroup[]; slots: (SlotDecision | null)[] }
        const result = stepOutcome(input)
        const actual = result.ok ? { outcome: result.data.outcome, cancel: result.data.cancel } : { error: result.error.code, reason: result.error.details?.reason }
        expect(pick(actual, c.expect)).toEqual(c.expect)
        return
      }
      if (c.fn === 'lintDoaVersion') {
        const version = versions[0]!
        const result = lintDoaVersion(version, org, version.effectiveFrom)
        expect({ errors: result.errors.map(issueOut), warnings: result.warnings.map(issueOut) }).toEqual(c.expect)
        return
      }
      const result = resolveRoute(
        {
          documentType: i.documentType,
          ...(i.amount !== undefined ? { amount: { netSatang: amountToSatang(i.amount), vatSatang: 0n } } : {}),
          requesterMemberId: i.requester,
          chargedDepartmentId: i.department,
          conflictMemberIds: [i.requester, ...(i.alsoConflicting ?? [])],
          at: new Date(i.at),
        },
        { versions, org, delegations: [] },
      )
      const actual = result.ok
        ? {
            rule: result.data.escalatedFromRuleCode ?? result.data.ruleCode,
            ...(result.data.escalatedFromRuleCode ? { escalatedTo: result.data.ruleCode } : {}),
            steps: result.data.steps.map(stepOut),
          }
        : { error: result.error.code }
      expect(pick(actual, c.expect)).toEqual(c.expect)
      if (result.ok && !('escalatedTo' in c.expect)) expect(result.data.escalatedFromRuleCode).toBeNull()
    })
  }
})

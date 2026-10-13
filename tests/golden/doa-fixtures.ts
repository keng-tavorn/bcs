import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import type { ApproverSpec, DelegationSnapshot, DoaRuleSnapshot, DoaVersionSnapshot, OrgSnapshot } from '@/core/doa'

// Golden adapter for the DOA suites (spec §7.4): turns tests/golden/fixtures/*.yaml into engine snapshots. It only
// changes shapes (codes become ids, baht strings become satang); it never changes an expected value.

export const GOLDEN_DIR = import.meta.dirname

export function loadYaml<T>(relative: string): T {
  return parse(readFileSync(path.join(GOLDEN_DIR, relative), 'utf8')) as T
}

interface OrgFixture {
  departments: Array<{ code: string; nameTh: string; parent: string | null }>
  positions: Array<{ position: string; department: string; member: string }>
  members: Record<string, string>
}

export interface RuleFixture {
  code: string
  documentType: DoaRuleSnapshot['documentType']
  priority: number
  when: { amount?: { gt?: string; gte?: string; lte?: string } }
  approver: { kind: ApproverSpec['kind']; position?: string; member?: string }
  slaBusinessHours: number
}

interface VersionFixture {
  code: string
  version: number
  effectiveFrom: string
  amountBasis: 'GROSS' | 'NET'
  selfApprovalPolicy: 'ESCALATE_NEXT_BAND' | 'BLOCK'
  collapseDuplicateApprovers: boolean
  rules: RuleFixture[]
}

const EPOCH = new Date('1970-01-01T00:00:00Z')

/** The fixtures a golden file names on its `fixtures:` line (ADR-069); the demo pair when it names none. */
export const DEMO_FIXTURES = { org: 'fixtures/org-demo.yaml', versions: 'fixtures/doa-versions.yaml' } as const
export type FixturePair = { readonly org: string; readonly versions: string }

export function fixturesOf(files: readonly string[] | undefined): FixturePair {
  if (!files) return DEMO_FIXTURES
  return { org: files.find((f) => f.includes('/org-'))!, versions: files.find((f) => f.includes('/doa-versions'))! }
}

export function orgSnapshot(vacate: readonly string[] = [], file: string = DEMO_FIXTURES.org): OrgSnapshot {
  const fx = loadYaml<OrgFixture>(file)
  return {
    departments: fx.departments.map((d) => ({ id: d.code, code: d.code, nameTh: d.nameTh, parentId: d.parent })),
    holders: fx.positions
      .filter((p) => !vacate.includes(`${p.position}@${p.department}`))
      .map((p) => ({ positionCode: p.position, departmentId: p.department, memberId: p.member, validFrom: EPOCH, validTo: null })),
    members: Object.keys(fx.members).map((code) => ({ id: code, displayNameTh: code, active: true })),
  }
}

export function ruleSnapshot(r: RuleFixture): DoaRuleSnapshot {
  const amount = r.when.amount
  const approver: ApproverSpec =
    r.approver.kind === 'MEMBER' ? { kind: 'MEMBER', memberId: r.approver.member! } : { kind: r.approver.kind, position: r.approver.position! }
  return {
    code: r.code,
    documentType: r.documentType,
    priority: r.priority,
    when: amount
      ? {
          amount: {
            ...(amount.gt !== undefined ? { gt: amountToSatang(amount.gt) } : {}),
            ...(amount.gte !== undefined ? { gte: amountToSatang(amount.gte) } : {}),
            ...(amount.lte !== undefined ? { lte: amountToSatang(amount.lte) } : {}),
          },
        }
      : {},
    steps: [{ approver, slaBusinessMinutes: r.slaBusinessHours * 60, mode: 'SEQUENTIAL' }],
  }
}

export function versionSnapshots(file: string = DEMO_FIXTURES.versions): DoaVersionSnapshot[] {
  const fx = loadYaml<{ versions: VersionFixture[] }>(file)
  return fx.versions.map((v) => ({
    id: `${v.code}@${v.version}`,
    code: v.code,
    versionNo: v.version,
    status: 'PUBLISHED',
    effectiveFrom: new Date(v.effectiveFrom),
    effectiveTo: null,
    amountBasis: v.amountBasis,
    selfApprovalPolicy: v.selfApprovalPolicy,
    collapseDuplicateApprovers: v.collapseDuplicateApprovers,
    rules: v.rules.map(ruleSnapshot),
  }))
}

interface DelegationFixture {
  delegator: string
  delegate: string
  startsAt: string
  endsAt: string
  maxAmount?: string
}

export function delegationSnapshot(id: string, d: DelegationFixture): DelegationSnapshot {
  return {
    id,
    delegatorMemberId: d.delegator,
    delegateMemberId: d.delegate,
    startsAt: new Date(d.startsAt),
    endsAt: new Date(d.endsAt),
    documentTypes: null,
    maxAmountSatang: d.maxAmount !== undefined ? amountToSatang(d.maxAmount) : null,
    status: 'ACTIVE',
  }
}

export const baht = satangToAmount

/** Only the keys the golden case states are compared. */
export function pick(actual: Record<string, unknown>, expected: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(expected).map((k) => [k, actual[k]]))
}

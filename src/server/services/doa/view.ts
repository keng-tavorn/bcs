import { z } from 'zod'
import { DOA_DOCUMENT_TYPES, boundaryTable, lintDoaVersion, resolveRoute, versionAt, type DoaDocumentType, type DoaRuleSnapshot } from '@/core/doa'
import { err, ok, type Result } from '@/core/result'
import { logger } from '@/lib/logger'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSnapshot, loadRoutePolicy, openTasksUnderVersion } from '@/server/doa/policy'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import { doaVersionDataFromRows, doaYaml, type DoaVersionData } from '@/server/doa/yaml'
import { describeError } from '@/server/errors/describe'
import {
  doaVersionDrafted,
  getDoaVersionRow,
  hasDoaBeyondDrafts,
  latestDoaVersionRoute,
  listDoaVersions,
  previousDoaVersionId,
  verifiedSignatoryId,
  type DoaVersionFullRow,
  type DoaVersionListRow,
} from '@/server/queries/doa'
import { listCurrentHolders, listDepartments, listMembers, listPositions, type MemberOptionRow, type RouteRow } from '@/server/queries/org'
import { treeOrder } from '../org-structure/tree'
import { diffVersions, policyValues, type PolicyField, type PolicyValue, type VersionDiff } from './diff'
import { INITIAL_PACKAGE_RULE } from './initial-package'
import { issueView, warningKey } from './lint-view'

// The DOA pages of ORG_ADMIN (spec §9.1 /admin/doa, FR-DOA-001 AC2–AC3, FR-DOA-002 AC1, BR-DOA-19): every version with
// its status and effective period, one version with its rules, policy, history (reason, who imported, submitted and
// approved, diff with the previous version), the lint a draft must pass, and the version as YAML. Reading needs
// admin.doa.draft (BR-AUTH-05); nothing here writes. Money leaves as satang text, times as ISO strings.

export interface PersonView {
  readonly id: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export type DoaVersionStatus = DoaVersionListRow['status']

export interface DoaVersionSummaryView {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: DoaVersionStatus
  /** PUBLISHED and in effect at this moment */
  readonly inEffect: boolean
  /** PUBLISHED, approved for a later start */
  readonly upcoming: boolean
  readonly effectiveFrom: string
  readonly effectiveTo: string | null
  readonly changeReason: string | null
  readonly rules: number
  readonly submittedBy: PersonView | null
  readonly submittedAt: string | null
  readonly approvedBy: PersonView | null
  readonly approvedAt: string | null
}

export interface DoaOverviewView {
  readonly versions: readonly DoaVersionSummaryView[]
  /** No version is or was in effect or waits for approval: the first one goes as the initial package (BR-DOA-19) */
  readonly initial: boolean
}

export type ApproverView =
  | { readonly kind: 'POSITION_OF_DEPARTMENT' | 'POSITION_OF_ORG'; readonly position: string; readonly positionNameTh: string | null; readonly positionNameEn: string | null }
  | { readonly kind: 'MEMBER'; readonly member: PersonView }

export interface RuleView {
  readonly code: string
  readonly documentType: DoaDocumentType
  readonly priority: number
  /** Satang text; null = a rule without an amount condition */
  readonly band: { readonly gt?: string; readonly gte?: string; readonly lte?: string } | null
  readonly steps: ReadonlyArray<{ readonly approver: ApproverView; readonly slaMinutes: number }>
}

export type PolicyView = Record<PolicyField, PolicyValue>

export interface IssueView {
  readonly code: string
  readonly documentType?: string
  readonly rule?: string
  readonly gt?: string | null
  readonly lte?: string | null
}

export interface RouteTaskView {
  readonly assignee: PersonView
  readonly onBehalfOf: PersonView | null
  readonly status: RouteRow['tasks'][number]['status']
  readonly assignedAt: string
  readonly decidedAt: string | null
  readonly decidedBy: PersonView | null
}

export interface RouteView {
  readonly ruleCode: string
  readonly doaCode: string
  readonly versionNo: number
  readonly initialPackage: boolean
  readonly status: RouteRow['status']
  readonly tasks: readonly RouteTaskView[]
}

export type SubmitView =
  | {
      readonly mode: 'NORMAL'
      readonly allowed: boolean
      readonly effectiveInPast: boolean
      /** A version of the same code approved for the same or a later start (ADR-042 item 7) */
      readonly laterVersionScheduled: number | null
      readonly errors: readonly IssueView[]
      /** Each must be ticked on its own before sending (FR-DOA-002 AC1) */
      readonly warnings: readonly string[]
      readonly approver: { readonly doaCode: string; readonly versionNo: number; readonly ruleCode: string; readonly approvers: readonly PersonView[] } | { readonly error: string }
      /** Open tasks routed under the version in effect, which keep that route (BR-DOA-13) */
      readonly openTasksUnderCurrent: number
      readonly current: { readonly code: string; readonly versionNo: number } | null
    }
  | {
      readonly mode: 'INITIAL'
      readonly allowed: boolean
      readonly effectiveInPast: boolean
      readonly signatory: PersonView | null
      readonly submitterIsSignatory: boolean
      /** The positions the version names, the only ones the package may list */
      readonly positions: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly scope: 'DEPARTMENT' | 'ORG' }>
      /** Current holders of those positions: every one must be in the package (UNLISTED_HOLDER) */
      readonly holders: ReadonlyArray<{ readonly positionCode: string; readonly departmentId: string; readonly memberId: string }>
      readonly departments: ReadonlyArray<{ readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly depth: number; readonly root: boolean }>
      readonly members: ReadonlyArray<PersonView & { readonly employeeCode: string | null }>
    }

export interface DoaVersionDetailView {
  readonly version: DoaVersionSummaryView
  readonly importedBy: PersonView | null
  readonly importedAt: string | null
  readonly policy: PolicyView
  readonly rules: readonly RuleView[]
  /** Amounts at every band's upper end and one satang above, with the rule that applies (BR-DOA-08 (ช)) */
  readonly boundaries: ReadonlyArray<{ readonly documentType: DoaDocumentType; readonly rows: ReadonlyArray<{ readonly amount: string; readonly ruleCode: string | null }> }>
  readonly previous: { readonly id: string; readonly versionNo: number; readonly policy: PolicyView; readonly rules: readonly RuleView[] } | null
  readonly diff: VersionDiff | null
  readonly route: RouteView | null
  /** Only for a draft */
  readonly submit: SubmitView | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

async function allowRead(ctx: Ctx) {
  return forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.doa.draft'))
}

/** Names of members by id, for every person a view shows (an unknown id shows as itself rather than disappearing). */
export function personOf(members: readonly MemberOptionRow[]) {
  const byId = new Map(members.map((m) => [m.id, m]))
  return (id: string | null): PersonView | null => {
    if (!id) return null
    const m = byId.get(id)
    return { id, nameTh: m?.displayNameTh ?? id, nameEn: m?.displayNameEn ?? null }
  }
}

function summaryOf(v: DoaVersionListRow, person: ReturnType<typeof personOf>, now: Date): DoaVersionSummaryView {
  const started = v.effectiveFrom.getTime() <= now.getTime()
  const ended = v.effectiveTo !== null && v.effectiveTo.getTime() <= now.getTime()
  return {
    id: v.id,
    code: v.code,
    versionNo: v.versionNo,
    status: v.status,
    inEffect: v.status === 'PUBLISHED' && started && !ended,
    upcoming: v.status === 'PUBLISHED' && !started,
    effectiveFrom: v.effectiveFrom.toISOString(),
    effectiveTo: iso(v.effectiveTo),
    changeReason: v.changeReason,
    rules: v.rules,
    submittedBy: person(v.submittedById),
    submittedAt: iso(v.submittedAt),
    approvedBy: person(v.approvedById),
    approvedAt: iso(v.approvedAt),
  }
}

/** /admin/doa: every version with status and effective period (FR-DOA-001 AC3), and whether the next is the first. */
export async function getDoaOverviewForAdmin(ctx: Ctx): Promise<Result<DoaOverviewView>> {
  const allowed = await allowRead(ctx)
  if (!allowed.ok) return allowed
  const [versions, members, beyondDrafts] = await Promise.all([listDoaVersions(ctx), listMembers(ctx), hasDoaBeyondDrafts(ctx)])
  const person = personOf(members)
  return ok({ versions: versions.map((v) => summaryOf(v, person, ctx.now)), initial: !beyondDrafts })
}

function dataOf(row: DoaVersionFullRow): DoaVersionData {
  return doaVersionDataFromRows(row, row.ruleRows)
}

function ruleViews(rules: readonly DoaRuleSnapshot[], positions: ReadonlyMap<string, { nameTh: string; nameEn: string | null }>, person: ReturnType<typeof personOf>): RuleView[] {
  const text = (v: bigint | undefined) => (v === undefined ? undefined : v.toString())
  return rules.map((r) => ({
    code: r.code,
    documentType: r.documentType,
    priority: r.priority,
    band: r.when.amount
      ? Object.fromEntries(Object.entries({ gt: text(r.when.amount.gt), gte: text(r.when.amount.gte), lte: text(r.when.amount.lte) }).filter(([, v]) => v !== undefined))
      : null,
    steps: r.steps.map((s) => ({
      slaMinutes: s.slaBusinessMinutes,
      approver:
        s.approver.kind === 'MEMBER'
          ? { kind: 'MEMBER' as const, member: person(s.approver.memberId)! }
          : { kind: s.approver.kind, position: s.approver.position, positionNameTh: positions.get(s.approver.position)?.nameTh ?? null, positionNameEn: positions.get(s.approver.position)?.nameEn ?? null },
    })),
  }))
}

/** An approval route as the admin screens show it: the rule, its version and each task with its outcome. */
export function routeView(route: RouteRow, person: ReturnType<typeof personOf>): RouteView {
  return {
    ruleCode: route.ruleCode,
    doaCode: route.doaCode,
    versionNo: route.versionNo,
    initialPackage: route.ruleCode === INITIAL_PACKAGE_RULE,
    status: route.status,
    tasks: route.tasks.map((t) => ({
      assignee: person(t.assigneeMemberId)!,
      onBehalfOf: person(t.principalMemberId),
      status: t.status,
      assignedAt: t.assignedAt.toISOString(),
      decidedAt: iso(t.decidedAt),
      decidedBy: person(t.decidedByMemberId),
    })),
  }
}

/** /admin/doa/[versionId]: one version, its history and, for a draft, what sending it needs (FR-DOA-001 AC3, FR-DOA-002 AC1). */
export async function getDoaVersionForAdmin(ctx: Ctx, versionId: string): Promise<Result<DoaVersionDetailView>> {
  const allowed = await allowRead(ctx)
  if (!allowed.ok) return allowed
  if (!z.uuid().safeParse(versionId).success) return err('NOT_FOUND', 'DOA version not found')
  const row = await getDoaVersionRow(ctx, versionId)
  if (!row) return err('NOT_FOUND', 'DOA version not found')

  const [members, positionRows, drafted, previousId, route] = await Promise.all([
    listMembers(ctx),
    listPositions(ctx),
    doaVersionDrafted(ctx, versionId),
    previousDoaVersionId(ctx, row.code, row.versionNo),
    latestDoaVersionRoute(ctx, versionId),
  ])
  const person = personOf(members)
  const positions = new Map(positionRows.map((p) => [p.code, { nameTh: p.nameTh, nameEn: p.nameEn }]))
  const data = dataOf(row)
  const snapshot = versionSnapshotFromRows(row, row.ruleRows)
  const previousRow = previousId ? await getDoaVersionRow(ctx, previousId) : null
  const previousData = previousRow ? dataOf(previousRow) : null
  const amountTypes = DOA_DOCUMENT_TYPES.filter((t) => snapshot.rules.some((r) => r.documentType === t && r.when.amount))

  return ok({
    version: summaryOf(row, person, ctx.now),
    importedBy: drafted ? person(drafted.memberId) : null,
    importedAt: drafted ? drafted.at.toISOString() : null,
    policy: policyValues(data),
    rules: ruleViews(data.rules, positions, person),
    boundaries: amountTypes.map((documentType) => ({ documentType, rows: boundaryTable(snapshot, documentType).map((b) => ({ amount: b.amountSatang.toString(), ruleCode: b.ruleCode })) })),
    previous: previousRow && previousData ? { id: previousRow.id, versionNo: previousRow.versionNo, policy: policyValues(previousData), rules: ruleViews(previousData.rules, positions, person) } : null,
    diff: previousData ? diffVersions(previousData, data) : null,
    route: route ? routeView(route, person) : null,
    submit: row.status === 'DRAFT' ? await submitView(ctx, row, members, positionRows) : null,
  })
}

async function submitView(ctx: Ctx, row: DoaVersionFullRow, members: readonly MemberOptionRow[], positionRows: Awaited<ReturnType<typeof listPositions>>): Promise<SubmitView> {
  const person = personOf(members)
  const snapshot = versionSnapshotFromRows(row, row.ruleRows)
  const effectiveInPast = row.effectiveFrom.getTime() < ctx.now.getTime()
  const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  const initial = !(await hasDoaBeyondDrafts(ctx))

  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<SubmitView> => {
    const allowed = (await authorize(tx, ctx, 'admin.doa.submitForPublish')).ok
    if (initial) {
      const named = new Set(snapshot.rules.flatMap((r) => r.steps.flatMap((s) => (s.approver.kind === 'MEMBER' ? [] : [s.approver.position]))))
      const [signatoryId, departments, holders] = await Promise.all([verifiedSignatoryId(ctx), listDepartments(ctx), listCurrentHolders(ctx, ctx.now)])
      return {
        mode: 'INITIAL',
        allowed,
        effectiveInPast,
        signatory: person(signatoryId),
        submitterIsSignatory: signatoryId !== null && signatoryId === actor,
        positions: positionRows.filter((p) => named.has(p.code)).map((p) => ({ code: p.code, nameTh: p.nameTh, nameEn: p.nameEn, scope: p.scope })),
        holders: holders.filter((h) => named.has(h.positionCode)).map((h) => ({ positionCode: h.positionCode, departmentId: h.departmentId, memberId: h.memberId })),
        departments: treeOrder(departments).map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, depth: d.depth, root: d.parentId === null })),
        members: members.filter((m) => m.active).map((m) => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn, employeeCode: m.employeeCode })),
      }
    }

    // The full lint against the organization as it will be on the effective date (BR-DOA-08), as the submit runs it
    const org = await loadOrgSnapshot(tx)
    const lint = lintDoaVersion(snapshot, org, row.effectiveFrom)
    const later = await tx.doaVersion.findFirst({
      where: { code: row.code, status: 'PUBLISHED', id: { not: row.id }, effectiveFrom: { gte: row.effectiveFrom } },
      select: { versionNo: true },
      orderBy: { versionNo: 'asc' },
    })
    // Who will decide: the approver of the DOA_CHANGE rule of the version in effect now (FR-DOA-002 AC2)
    const policy = await loadRoutePolicy(tx)
    const current = versionAt(policy.versions, ctx.now)
    let approver: Extract<SubmitView, { mode: 'NORMAL' }>['approver'] = { error: 'FORBIDDEN' }
    if (actor) {
      const submitter = await tx.member.findUnique({ where: { id: actor }, select: { primaryDepartmentId: true } })
      const root = org.departments.find((d) => d.parentId === null)
      const departmentId = submitter?.primaryDepartmentId ?? root?.id
      const route = departmentId
        ? resolveRoute({ documentType: 'DOA_CHANGE', requesterMemberId: actor, chargedDepartmentId: departmentId, conflictMemberIds: [actor], at: ctx.now }, policy)
        : err<never>('VALIDATION_FAILED', 'the organization has no departments')
      approver = route.ok
        ? { doaCode: route.data.doaCode, versionNo: route.data.versionNo, ruleCode: route.data.ruleCode, approvers: route.data.steps.map((s) => person(s.assigneeMemberId)!) }
        : { error: route.error.code }
    }
    return {
      mode: 'NORMAL',
      allowed,
      effectiveInPast,
      laterVersionScheduled: later?.versionNo ?? null,
      errors: lint.errors.map(issueView),
      warnings: lint.warnings.map(warningKey),
      approver,
      openTasksUnderCurrent: current ? await openTasksUnderVersion(tx, current.id) : 0,
      current: current ? { code: current.code, versionNo: current.versionNo } : null,
    }
  })
}

/**
 * One version as a YAML file in the shape of the §7.4 fixture (FR-DOA-001 AC2): import it again and the data is the same.
 * That shape holds one approver per rule (tier 1): a version with a rule of more steps is refused as VALIDATION_FAILED
 * (reason MULTI_STEP_RULE, with the rule), never written half. An unexpected failure is INTERNAL with the requestId.
 */
export async function exportDoaVersionYaml(ctx: Ctx, versionId: string): Promise<Result<{ fileName: string; yaml: string }>> {
  try {
    const allowed = await allowRead(ctx)
    if (!allowed.ok) return allowed
    if (!z.uuid().safeParse(versionId).success) return err('NOT_FOUND', 'DOA version not found')
    const row = await getDoaVersionRow(ctx, versionId)
    if (!row) return err('NOT_FOUND', 'DOA version not found')
    const data = dataOf(row)
    const multiStep = data.rules.find((r) => r.steps.length !== 1)
    if (multiStep) return err('VALIDATION_FAILED', 'the YAML shape holds one approver per rule', { reason: 'MULTI_STEP_RULE', rule: multiStep.code })
    const members = await listMembers(ctx)
    // A MEMBER approver is written with the member's code, as the import reads it
    const codes = new Map(members.filter((m) => m.employeeCode).map((m) => [m.id, m.employeeCode!]))
    return ok({ fileName: `${row.code}-v${row.versionNo}.yaml`, yaml: doaYaml([data], codes) })
  } catch (error) {
    // The caller gets a reference only; the log gets codes and stack frames, never the error text (FR-PLT-008 AC3)
    logger.child({ requestId: ctx.requestId, organizationId: ctx.organizationId, view: 'doa.export' }).error({ error: describeError(error) }, 'DOA export failed unexpectedly')
    return err('INTERNAL', 'unexpected error', { requestId: ctx.requestId })
  }
}

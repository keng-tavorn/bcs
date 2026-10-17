import { TZDate } from '@date-fns/tz'
import { z } from 'zod'
import { resolveRoute } from '@/core/doa'
import { err, ok, type Result } from '@/core/result'
import { THAI_TIME_ZONE } from '@/core/thai/date'
import { lintWorkflowVersion, workflowVersionAt, type ReviewerSpec, type WorkflowCondition, type WorkflowLintIssue, type WorkflowVersionSnapshot } from '@/core/workflow'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadOrgSnapshot, loadRoutePolicy } from '@/server/doa/policy'
import { ROUTE_SELECT, routeRow } from '@/server/queries/org'
import { loadRequestTypeFields } from '@/server/workflow/policy'
import { workflowVersionFromRows } from '@/server/workflow/snapshot'
import { effectiveDates } from '../doa/dates'
import { SLA_MAX_HOURS } from '../doa/editor'
import { routeView, type PersonView, type RouteView } from '../doa/view'
import { treeOrder } from '../org-structure/tree'
import { withdrawalView, type WithdrawalView } from '../policy-withdrawal/view'
import { holdsWorkflowTask, matchedRuleCodes, workflowWarningKey } from './index'

// The screens of the workflow versions (spec FR-WF-103 AC1 AC2, S6-06): /admin/workflows lists every version with its
// status and period; /admin/workflows/[id] shows one version in the editor's shape — its rules and test cases, the
// version it is read beside (the one in effect, or for history the one before it) with what changed rule by rule, the
// lint of BR-WF-11 as the submit runs it, what the condition builder and the reviewer pickers offer, and for a draft
// whether it can be sent now (the dry-run ran after the last change). Reads only: admin.workflow.draft (ORG_ADMIN)
// is checked here, never by hiding a link; PLATFORM_ADMIN never reaches this (NG-12).

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN'] as const
export type WorkflowVersionStatus = (typeof STATUSES)[number]

export interface WorkflowVersionSummaryView {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: WorkflowVersionStatus
  /** PUBLISHED and in effect now */
  readonly inEffect: boolean
  /** PUBLISHED for a later date */
  readonly upcoming: boolean
  readonly effectiveFrom: string
  readonly effectiveTo: string | null
  readonly changeReason: string | null
  readonly rules: number
  /** When the dry-run of the latest draft ran; null after any change (§6.4 WorkflowVersion) */
  readonly dryRunAt: string | null
  readonly submittedBy: PersonView | null
  readonly submittedAt: string | null
  readonly approvedBy: PersonView | null
  readonly approvedAt: string | null
}

export interface WorkflowListView {
  readonly versions: readonly WorkflowVersionSummaryView[]
  /** What a new draft copies, per code: the latest published (in effect or for later), else the latest ever in effect */
  readonly sources: readonly WorkflowVersionSummaryView[]
  /** Drafts not sent yet, per code: open one rather than making another */
  readonly openDrafts: readonly WorkflowVersionSummaryView[]
}

export interface WorkflowRuleView {
  readonly code: string
  readonly requestTypeCodes: readonly string[]
  readonly when: WorkflowCondition
  readonly reviewers: readonly ReviewerSpec[]
  readonly fallback: ReviewerSpec | null
  readonly mode: 'ALL' | 'ANY' | 'COUNT'
  readonly quorumCount: number | null
  readonly slaMinutes: number
  readonly descriptionTh: string | null
}

export interface WorkflowTestCaseView {
  readonly name: string
  readonly input: {
    readonly requestType: string
    readonly amountGross: string
    readonly amountNet?: string
    readonly lineCategories: readonly string[]
    readonly budgetAccountCodes: readonly string[]
    readonly fields: Readonly<Record<string, unknown>>
  }
  readonly expected: { readonly ruleCodes: readonly string[] }
}

export type WorkflowRuleField = 'requestTypes' | 'when' | 'reviewers' | 'fallback' | 'mode' | 'sla' | 'description'

export interface WorkflowDiffView {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: ReadonlyArray<{ readonly code: string; readonly fields: readonly WorkflowRuleField[] }>
}

export interface WorkflowIssueView {
  readonly code: string
  readonly rule: string
  readonly requestType?: string
  readonly field?: string
}

export interface WorkflowFormFieldView {
  readonly id: string
  readonly type: string
  readonly labelTh: string | null
  readonly labelEn: string | null
  readonly options: ReadonlyArray<{ readonly value: string; readonly labelTh: string | null; readonly labelEn: string | null }>
}

export interface WorkflowSubmitView {
  /** admin.workflow.submitForPublish */
  readonly allowed: boolean
  /** The dry-run ran on the latest draft (any save clears it) */
  readonly dryRunDone: boolean
  readonly effectiveInPast: boolean
  readonly laterVersionScheduled: number | null
  readonly testCasesFailing: readonly string[]
  /** Who will decide: the approver of the DOA_CHANGE rule in effect, never the submitter */
  readonly approver: { readonly doaCode: string; readonly versionNo: number; readonly ruleCode: string; readonly approvers: readonly PersonView[] } | { readonly error: string }
}

export interface WorkflowEditorView {
  readonly version: WorkflowVersionSummaryView & { readonly lock: number }
  /** A draft is edited; every other version is read only (a change is a new draft) */
  readonly editable: boolean
  readonly rules: readonly WorkflowRuleView[]
  readonly testCases: readonly WorkflowTestCaseView[]
  /** The version this one is read beside: the one in effect (IN_EFFECT) or, for history, the one before it (PREVIOUS) */
  readonly baseline: { readonly id: string; readonly code: string; readonly versionNo: number; readonly relation: 'IN_EFFECT' | 'PREVIOUS'; readonly rules: readonly WorkflowRuleView[] } | null
  readonly diff: WorkflowDiffView | null
  readonly lint: { readonly errors: readonly WorkflowIssueView[]; readonly warnings: ReadonlyArray<WorkflowIssueView & { readonly key: string }> }
  readonly requestTypes: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly fields: readonly WorkflowFormFieldView[] }>
  readonly positions: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly scope: 'DEPARTMENT' | 'ORG' }>
  readonly departments: ReadonlyArray<{ readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly depth: number }>
  readonly members: ReadonlyArray<{ readonly id: string; readonly nameTh: string; readonly nameEn: string | null; readonly active: boolean; readonly primaryDepartmentId: string | null }>
  /** Codes the condition builder suggests for $lineCategories and $budgetAccountCodes */
  readonly categoryCodes: readonly string[]
  readonly accountCodes: readonly string[]
  /** YYYY-MM-DD, Thai calendar */
  readonly effectiveDate: string
  readonly minEffectiveDate: string
  readonly slaMaxHours: number
  /** admin.workflow.simulate */
  readonly canSimulate: boolean
  /** The member the dry-run starts with as requester, and their department */
  readonly dryRunDefaults: { readonly requesterMemberId: string | null; readonly chargedDepartmentId: string | null }
  /** Only for a draft */
  readonly submit: WorkflowSubmitView | null
  /** The approval of the latest sending (the withdrawal's, once one is asked), once sent */
  readonly route: RouteView | null
  /** The withdrawal of a version approved but not yet in effect (FR-WF-103 · FR-DOA-104) */
  readonly withdrawal: WithdrawalView
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const twoDigits = (n: number) => String(n).padStart(2, '0')
/** A time as its Thai calendar date, YYYY-MM-DD */
function thaiDateOf(at: Date): string {
  const t = new TZDate(at.getTime(), THAI_TIME_ZONE)
  return `${t.getFullYear()}-${twoDigits(t.getMonth() + 1)}-${twoDigits(t.getDate())}`
}

type Person = (id: string | null) => PersonView | null

async function people(tx: TenantTx): Promise<{ person: Person; members: WorkflowEditorView['members'] }> {
  const rows = await tx.member.findMany({ select: { id: true, displayNameTh: true, displayNameEn: true, status: true, primaryDepartmentId: true }, orderBy: { displayNameTh: 'asc' } })
  const byId = new Map(rows.map((m) => [m.id, m]))
  return {
    person: (id) => {
      if (!id) return null
      const m = byId.get(id)
      return { id, nameTh: m?.displayNameTh ?? id, nameEn: m?.displayNameEn ?? null }
    },
    members: rows.map((m) => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn, active: m.status === 'ACTIVE', primaryDepartmentId: m.primaryDepartmentId })),
  }
}

interface VersionRow {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: string
  readonly effectiveFrom: Date
  readonly effectiveTo: Date | null
  readonly changeReason: string | null
  readonly dryRunAt: Date | null
  readonly submittedById: string | null
  readonly submittedAt: Date | null
  readonly approvedById: string | null
  readonly approvedAt: Date | null
}

function summaryOf(v: VersionRow, rules: number, person: Person, now: Date): WorkflowVersionSummaryView {
  const status = (STATUSES as readonly string[]).includes(v.status) ? (v.status as WorkflowVersionStatus) : 'DRAFT'
  const started = v.effectiveFrom.getTime() <= now.getTime()
  const ended = v.effectiveTo !== null && v.effectiveTo.getTime() <= now.getTime()
  return {
    id: v.id,
    code: v.code,
    versionNo: v.versionNo,
    status,
    inEffect: status === 'PUBLISHED' && started && !ended,
    upcoming: status === 'PUBLISHED' && !started,
    effectiveFrom: v.effectiveFrom.toISOString(),
    effectiveTo: iso(v.effectiveTo),
    changeReason: v.changeReason,
    rules,
    dryRunAt: iso(v.dryRunAt),
    submittedBy: person(v.submittedById),
    submittedAt: iso(v.submittedAt),
    approvedBy: person(v.approvedById),
    approvedAt: iso(v.approvedAt),
  }
}

/** The latest published version of each code (in effect, or approved for later), else the latest ever in effect */
function sourcesOf(versions: readonly WorkflowVersionSummaryView[]): WorkflowVersionSummaryView[] {
  const codes = [...new Set(versions.map((v) => v.code))].sort()
  return codes.flatMap((code) => {
    const ofCode = versions.filter((v) => v.code === code)
    const published = ofCode.filter((v) => v.status === 'PUBLISHED').sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.versionNo - a.versionNo)
    const superseded = ofCode.filter((v) => v.status === 'SUPERSEDED').sort((a, b) => b.versionNo - a.versionNo)
    const latest = published[0] ?? superseded[0]
    return latest ? [latest] : []
  })
}

/** /admin/workflows: every version with its status and period, what a new draft copies, and the drafts not sent yet */
export async function listWorkflowVersions(ctx: Ctx): Promise<Result<WorkflowListView>> {
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<WorkflowListView>> => {
    const allowed = await authorize(tx, ctx, 'admin.workflow.draft')
    if (!allowed.ok) return allowed
    const [rows, { person }] = await Promise.all([tx.workflowVersion.findMany({ include: { _count: { select: { rules: true } } }, orderBy: [{ code: 'asc' }, { versionNo: 'desc' }] }), people(tx)])
    const versions = rows.map((v) => summaryOf(v, v._count.rules, person, ctx.now))
    return ok({ versions, sources: sourcesOf(versions), openDrafts: versions.filter((v) => v.status === 'DRAFT') })
  })
}

// ---------- one version ----------

function ruleViews(snapshot: WorkflowVersionSnapshot, rows: ReadonlyArray<{ code: string; descriptionTh: string | null }>): WorkflowRuleView[] {
  return snapshot.rules.map((r) => ({
    code: r.code,
    requestTypeCodes: r.requestTypeCodes,
    when: r.when,
    reviewers: r.reviewers,
    fallback: r.fallback,
    mode: r.mode === 'COUNT' ? 'COUNT' : r.mode === 'ANY' ? 'ANY' : 'ALL',
    quorumCount: r.quorumCount,
    slaMinutes: r.slaBusinessMinutes,
    descriptionTh: rows.find((x) => x.code === r.code)?.descriptionTh ?? null,
  }))
}

/** JSON with its keys in order, so a value read back from jsonb compares equal to itself */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Rule by rule: added, removed, and changed with what changed (the order of the rules is not a change) */
export function diffWorkflowRules(before: readonly WorkflowRuleView[], after: readonly WorkflowRuleView[]): WorkflowDiffView {
  const parts = (r: WorkflowRuleView): Record<WorkflowRuleField, string> => ({
    requestTypes: canonical([...r.requestTypeCodes].sort()),
    when: canonical(r.when),
    reviewers: canonical(r.reviewers),
    fallback: canonical(r.fallback),
    mode: canonical([r.mode, r.quorumCount]),
    sla: String(r.slaMinutes),
    description: r.descriptionTh ?? '',
  })
  const changed = after.flatMap((r) => {
    const old = before.find((b) => b.code === r.code)
    if (!old) return []
    const a = parts(old)
    const b = parts(r)
    const fields = (Object.keys(b) as WorkflowRuleField[]).filter((f) => a[f] !== b[f])
    return fields.length ? [{ code: r.code, fields }] : []
  })
  return { added: after.filter((r) => !before.some((b) => b.code === r.code)).map((r) => r.code), removed: before.filter((b) => !after.some((r) => r.code === b.code)).map((b) => b.code), changed }
}

const issueView = (i: WorkflowLintIssue): WorkflowIssueView => ({ code: i.code, rule: i.rule, ...(i.requestType ? { requestType: i.requestType } : {}), ...(i.field ? { field: i.field } : {}) })

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const label = (v: unknown, locale: 'th' | 'en'): string | null => (v && typeof v === 'object' ? text((v as Record<string, unknown>)[locale]) : null)

/** The fields of a form schema the conditions may name, with their options; a nested list of fields is read flat */
function formFields(schema: unknown): WorkflowFormFieldView[] {
  const raw = (schema as { fields?: unknown } | null)?.fields
  const list: unknown[] = Array.isArray(raw) ? raw.flat(2) : []
  return list.flatMap((f): WorkflowFormFieldView[] => {
    if (!f || typeof f !== 'object') return []
    const field = f as Record<string, unknown>
    const id = text(field.id)
    if (!id) return []
    const optionLabels = (field.optionLabels ?? {}) as Record<string, unknown>
    const options = Array.isArray(field.options)
      ? field.options.flatMap((o) => {
          const value = typeof o === 'string' ? o : o && typeof o === 'object' ? text((o as Record<string, unknown>).value) : null
          if (!value) return []
          const named = optionLabels[value] ?? (o && typeof o === 'object' ? (o as Record<string, unknown>).label : null)
          return [{ value, labelTh: label(named, 'th'), labelEn: label(named, 'en') }]
        })
      : []
    return [{ id, type: text(field.type) ?? 'text', labelTh: label(field.label, 'th'), labelEn: label(field.label, 'en'), options }]
  })
}

/** For a draft or a version waiting or turned down: the version of its code in effect now; otherwise the one before it */
async function baselineOf(tx: TenantTx, row: VersionRow, now: Date) {
  const routing = await tx.workflowVersion.findMany({ where: { code: row.code, status: { in: ['PUBLISHED', 'SUPERSEDED'] }, id: { not: row.id } }, include: { rules: true } })
  const snapshots = routing.map((v) => ({ row: v, snapshot: workflowVersionFromRows(v, v.rules) }))
  const history = row.status === 'PUBLISHED' || row.status === 'SUPERSEDED' || row.status === 'WITHDRAWN'
  if (!history) {
    const current = workflowVersionAt(
      snapshots.map((s) => s.snapshot),
      now,
    )
    const found = current ? snapshots.find((s) => s.snapshot.id === current.id) : undefined
    if (found) return { ...found, relation: 'IN_EFFECT' as const }
  }
  const before = snapshots.filter((s) => s.row.versionNo < row.versionNo).sort((a, b) => b.row.versionNo - a.row.versionNo)[0]
  return before ? { ...before, relation: 'PREVIOUS' as const } : null
}

/** /admin/workflows/[id]: one version in the editor's shape, its comparison, its lint and, for a draft, its sending */
export async function getWorkflowEditor(ctx: Ctx, versionId: string): Promise<Result<WorkflowEditorView>> {
  if (!z.uuid().safeParse(versionId).success) {
    // Still refuse whoever may not read workflows before saying anything about the address
    const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.workflow.draft'))
    return allowed.ok ? err('NOT_FOUND', 'workflow version not found') : allowed
  }
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<WorkflowEditorView>> => {
    // ORG_ADMIN, or the version's approver, who reads it before deciding (FR-WF-103 AC3)
    const allowed = await authorize(tx, ctx, 'admin.workflow.draft')
    const approver = await holdsWorkflowTask(tx, ctx, versionId)
    if (!allowed.ok && !approver) return allowed
    const row = await tx.workflowVersion.findFirst({ where: { id: versionId }, include: { rules: true, testCases: { orderBy: { createdAt: 'asc' } } } })
    if (!row) return err('NOT_FOUND', 'workflow version not found')

    const [{ person, members }, positionRows, departmentRows, typeRows, org, typeFields, catalog, accounts, baseline, route, canSimulate, canWithdraw] = await Promise.all([
      people(tx),
      tx.position.findMany({ select: { code: true, nameTh: true, nameEn: true, scope: true }, orderBy: { code: 'asc' } }),
      tx.department.findMany({ select: { id: true, code: true, nameTh: true, nameEn: true, parentId: true, active: true } }),
      tx.requestType.findMany({ select: { code: true, nameTh: true, nameEn: true, currentFormVersion: { select: { schema: true } } }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
      loadOrgSnapshot(tx),
      loadRequestTypeFields(tx),
      tx.catalogItem.findMany({ distinct: ['categoryCode'], select: { categoryCode: true }, orderBy: { categoryCode: 'asc' } }),
      tx.budgetLine.findMany({ where: { accountCode: { not: null } }, distinct: ['accountCode'], select: { accountCode: true }, orderBy: { accountCode: 'asc' } }),
      baselineOf(tx, row, ctx.now),
      tx.approvalRoute.findFirst({ where: { subjectType: 'WORKFLOW_VERSION', subjectId: row.id }, select: ROUTE_SELECT, orderBy: { routeNo: 'desc' } }),
      // the try-out as dryRunWorkflowVersion allows it: an approver while their task waits for them
      authorize(tx, ctx, 'admin.workflow.simulate').then(async (r) => r.ok || (approver && (await holdsWorkflowTask(tx, ctx, versionId, { undecided: true })))),
      authorize(tx, ctx, 'admin.workflow.submitForPublish').then((r) => r.ok),
    ])

    const snapshot = workflowVersionFromRows(row, row.rules)
    const rules = ruleViews(snapshot, row.rules)
    const baselineRules = baseline ? ruleViews(baseline.snapshot, baseline.row.rules) : null
    // BR-WF-11 against the organization as it will be on the effective date, as the submit runs it
    const lint = lintWorkflowVersion(snapshot, org, typeFields, row.effectiveFrom)
    const testCases = row.testCases.map((t) => testCaseView(t.name, t.input, t.expected))
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    const actorMember = members.find((m) => m.id === actor)
    const latestPublished = await tx.workflowVersion.findFirst({ where: { code: row.code, status: 'PUBLISHED', id: { not: row.id } }, orderBy: { effectiveFrom: 'desc' }, select: { effectiveFrom: true } })
    const dates = effectiveDates(ctx.now, latestPublished?.effectiveFrom ?? null)
    const ownDate = thaiDateOf(row.effectiveFrom)

    return ok({
      version: { ...summaryOf(row, row.rules.length, person, ctx.now), lock: row.version },
      editable: row.status === 'DRAFT',
      rules,
      testCases,
      baseline: baseline && baselineRules ? { id: baseline.row.id, code: baseline.row.code, versionNo: baseline.row.versionNo, relation: baseline.relation, rules: baselineRules } : null,
      diff: baselineRules ? diffWorkflowRules(baselineRules, rules) : null,
      lint: { errors: lint.errors.map(issueView), warnings: lint.warnings.map((w) => ({ ...issueView(w), key: workflowWarningKey(w) })) },
      requestTypes: typeRows.map((t) => ({ code: t.code, nameTh: t.nameTh, nameEn: t.nameEn, fields: formFields(t.currentFormVersion?.schema) })),
      positions: positionRows,
      departments: treeOrder(departmentRows).map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, depth: d.depth })),
      members,
      categoryCodes: [...new Set([...catalog.map((c) => c.categoryCode), ...codesIn(rules, '$lineCategories')])].sort(),
      accountCodes: [...new Set([...accounts.flatMap((a) => (a.accountCode ? [a.accountCode] : [])), ...codesIn(rules, '$budgetAccountCodes')])].sort(),
      // A draft keeps its own date when it is still ahead; a copy starts on the default date (the first of next month)
      effectiveDate: ownDate >= dates.minDate ? ownDate : dates.defaultDate,
      minEffectiveDate: dates.minDate,
      slaMaxHours: SLA_MAX_HOURS,
      canSimulate,
      dryRunDefaults: { requesterMemberId: actorMember?.id ?? null, chargedDepartmentId: actorMember?.primaryDepartmentId ?? null },
      submit: row.status === 'DRAFT' ? await submitView(tx, ctx, row, snapshot, row.testCases, person) : null,
      route: route ? routeView(routeRow(route), (id) => person(id)) : null,
      withdrawal: withdrawalView(row, person, ctx.now, canWithdraw),
    })
  })
}

/** Every code a rule's conditions list for a set variable, so the builder keeps offering what is already there */
function codesIn(rules: readonly WorkflowRuleView[], variable: string): string[] {
  const walk = (c: WorkflowCondition): string[] => {
    if ('all' in c) return (c.all as readonly WorkflowCondition[]).flatMap(walk)
    if ('any' in c) return (c.any as readonly WorkflowCondition[]).flatMap(walk)
    if (!('field' in c)) return []
    const leaf = c as { field: string; value?: unknown }
    return leaf.field === variable && Array.isArray(leaf.value) ? leaf.value.map(String) : []
  }
  return rules.flatMap((r) => walk(r.when))
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function testCaseView(name: string, input: unknown, expected: unknown): WorkflowTestCaseView {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const e = (expected && typeof expected === 'object' ? expected : {}) as Record<string, unknown>
  return {
    name,
    input: {
      requestType: text(i.requestType) ?? '',
      amountGross: text(i.amountGross) ?? '0',
      ...(text(i.amountNet) ? { amountNet: text(i.amountNet)! } : {}),
      lineCategories: strings(i.lineCategories),
      budgetAccountCodes: strings(i.budgetAccountCodes),
      fields: i.fields && typeof i.fields === 'object' ? (i.fields as Record<string, unknown>) : {},
    },
    expected: { ruleCodes: strings(e.ruleCodes) },
  }
}

async function submitView(
  tx: TenantTx,
  ctx: Ctx,
  row: VersionRow,
  snapshot: WorkflowVersionSnapshot,
  testCases: ReadonlyArray<{ name: string; input: unknown; expected: unknown }>,
  person: Person,
): Promise<WorkflowSubmitView> {
  const allowed = (await authorize(tx, ctx, 'admin.workflow.submitForPublish')).ok
  const later = await tx.workflowVersion.findFirst({ where: { code: row.code, status: 'PUBLISHED', id: { not: row.id }, effectiveFrom: { gte: row.effectiveFrom } }, select: { versionNo: true }, orderBy: { versionNo: 'asc' } })
  // As the submit checks them (BR-DOA-08 (ง)): each test case gives exactly the rules it states
  const failing = testCases.flatMap((t) => {
    const view = testCaseView(t.name, t.input, t.expected)
    try {
      const got = matchedRuleCodes(snapshot, { ...view.input, lineCategories: [...view.input.lineCategories], budgetAccountCodes: [...view.input.budgetAccountCodes], fields: { ...view.input.fields } })
      return JSON.stringify([...got].sort()) === JSON.stringify([...view.expected.ruleCodes].sort()) ? [] : [t.name]
    } catch {
      return [t.name]
    }
  })
  // Who will decide: the approver of the DOA_CHANGE rule in effect now (BR-WF-12), never the sender
  const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  let approver: WorkflowSubmitView['approver'] = { error: 'FORBIDDEN' }
  if (actor) {
    const policy = await loadRoutePolicy(tx)
    const submitter = await tx.member.findUnique({ where: { id: actor }, select: { primaryDepartmentId: true } })
    const root = policy.org.departments.find((d) => d.parentId === null)
    const departmentId = submitter?.primaryDepartmentId ?? root?.id
    const route = departmentId ? resolveRoute({ documentType: 'DOA_CHANGE', requesterMemberId: actor, chargedDepartmentId: departmentId, conflictMemberIds: [actor], at: ctx.now }, policy) : null
    approver = route?.ok
      ? { doaCode: route.data.doaCode, versionNo: route.data.versionNo, ruleCode: route.data.ruleCode, approvers: route.data.steps.map((s) => person(s.assigneeMemberId)!) }
      : { error: route ? route.error.code : 'NO_DEPARTMENT' }
  }
  return {
    allowed,
    dryRunDone: row.dryRunAt !== null,
    effectiveInPast: row.effectiveFrom.getTime() < ctx.now.getTime(),
    laterVersionScheduled: later?.versionNo ?? null,
    testCasesFailing: failing,
    approver,
  }
}

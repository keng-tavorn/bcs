import { z } from 'zod'
import { DOA_DOCUMENT_TYPES, type DoaRuleSnapshot } from '@/core/doa'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantDb } from '@/server/db/tenant'
import {
  approverRoles,
  businessCalendarOf,
  businessMinutesWaited,
  departmentsOf,
  documentEvents,
  historyOf,
  isUuid,
  membersById,
  routeOf,
  slaPausesOf,
  type ApproverRoleDto,
  type DepartmentRefDto,
  type MemberRefDto,
  type NameDto,
  type RouteDto,
  type TrackEntryDto,
} from './requests'

// Read-only views of approval tasks for the inbox, the decision page and the home page (spec §9.1 /tasks, §9.9
// principles 1, 4, 5, FR-DOA-004, BR-DOA-15). A member's open tasks are the ones they hold and the ones a delegate holds
// for them (BR-DLG-04: both may decide), oldest due first, with the business time each has waited. Queries never check
// permissions: the decision page asks getTaskAccess() first and checks approval.decide (or that the task was the
// member's) with src/server/authz before it reads the task.

export type TaskSubjectType = 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE' | 'DOA_VERSION' | 'ORG_AUTHORITY_CHANGE'
export type TaskStatusDto = 'OPEN' | 'INFO_REQUESTED' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED' | 'REASSIGNED'
export type OrgChangeKind = 'POSITION_ASSIGN' | 'POSITION_END' | 'DEPARTMENT_REPARENT' | 'DELEGATION_ON_BEHALF' | 'IDENTITY_RESET'

/** BR-DOA-15: DOA versions and authority changes are approved or rejected with a step-up, on the web or LIFF only */
export const POLICY_SUBJECTS: readonly TaskSubjectType[] = ['DOA_VERSION', 'ORG_AUTHORITY_CHANGE']
const OPEN = ['OPEN', 'INFO_REQUESTED'] as const

export type InboxSubjectDto =
  | {
      readonly kind: 'REQUEST'
      readonly requestId: string
      readonly number: string | null
      readonly title: string
      readonly requester: MemberRefDto | null
      readonly department: DepartmentRefDto | null
      readonly grossSatang: bigint
      readonly netSatang: bigint
    }
  | { readonly kind: 'DOA_VERSION'; readonly code: string; readonly versionNo: number; readonly effectiveFrom: Date }
  | { readonly kind: 'ORG_AUTHORITY_CHANGE'; readonly changeKind: OrgChangeKind; readonly effectiveFrom: Date }
  | { readonly kind: 'OTHER' }

export interface InboxTaskDto {
  readonly id: string
  readonly status: 'OPEN' | 'INFO_REQUESTED'
  readonly subjectType: TaskSubjectType
  readonly subjectId: string
  readonly subject: InboxSubjectDto
  readonly assignedAt: Date
  readonly dueAt: Date | null
  /** Business minutes the task has waited for its approver, without the time it waited for an answer (BR-SLA-01, BR-SLA-03); null without a business calendar */
  readonly waitingMinutes: number | null
  readonly overdue: boolean
  /** FOR: I hold it for the delegator · BY: my delegate holds it for me (BR-DLG-04) */
  readonly holding: { readonly kind: 'FOR'; readonly member: MemberRefDto } | { readonly kind: 'BY'; readonly member: MemberRefDto } | null
  readonly stepUp: boolean
}

export interface InboxDto {
  readonly items: readonly InboxTaskDto[]
  /** All open tasks of the member, also when `items` is cut at the limit */
  readonly total: number
}

const INBOX_LIMIT = 200

async function subjectsOf(db: TenantDb, tasks: ReadonlyArray<{ step: { route: { subjectType: string; subjectId: string } } }>): Promise<(type: string, id: string) => InboxSubjectDto> {
  const ids = (type: string) => [...new Set(tasks.filter((t) => t.step.route.subjectType === type).map((t) => t.step.route.subjectId))]
  const [requests, versions, changes, departments] = await Promise.all([
    ids('REQUEST').length
      ? db.request.findMany({
          where: { id: { in: ids('REQUEST') } },
          select: { id: true, number: true, title: true, grossSatang: true, netSatang: true, chargedDepartmentId: true, requester: { select: { id: true, displayNameTh: true, displayNameEn: true } } },
        })
      : Promise.resolve([]),
    ids('DOA_VERSION').length ? db.doaVersion.findMany({ where: { id: { in: ids('DOA_VERSION') } }, select: { id: true, code: true, versionNo: true, effectiveFrom: true } }) : Promise.resolve([]),
    ids('ORG_AUTHORITY_CHANGE').length ? db.orgAuthorityChange.findMany({ where: { id: { in: ids('ORG_AUTHORITY_CHANGE') } }, select: { id: true, kind: true, effectiveFrom: true } }) : Promise.resolve([]),
    departmentsOf(db),
  ])
  const request = new Map(requests.map((r) => [r.id, r]))
  const version = new Map(versions.map((v) => [v.id, v]))
  const change = new Map(changes.map((c) => [c.id, c]))
  return (type, id) => {
    if (type === 'REQUEST' && request.has(id)) {
      const r = request.get(id)!
      return {
        kind: 'REQUEST',
        requestId: r.id,
        number: r.number,
        title: r.title,
        requester: { id: r.requester.id, name: { th: r.requester.displayNameTh, en: r.requester.displayNameEn } },
        department: departments.byId.get(r.chargedDepartmentId) ?? null,
        grossSatang: r.grossSatang,
        netSatang: r.netSatang,
      }
    }
    if (type === 'DOA_VERSION' && version.has(id)) {
      const v = version.get(id)!
      return { kind: 'DOA_VERSION', code: v.code, versionNo: v.versionNo, effectiveFrom: v.effectiveFrom }
    }
    if (type === 'ORG_AUTHORITY_CHANGE' && change.has(id)) {
      const c = change.get(id)!
      return { kind: 'ORG_AUTHORITY_CHANGE', changeKind: c.kind, effectiveFrom: c.effectiveFrom }
    }
    return { kind: 'OTHER' }
  }
}

/** The member's open approval tasks, oldest due first (spec §9.1 /tasks, §9.4 /liff/tasks) */
export async function listMyTasks(ctx: Ctx, options: { readonly limit?: number } = {}): Promise<InboxDto> {
  if (ctx.actor.type !== 'USER') return { items: [], total: 0 }
  const me = ctx.actor.memberId
  const db = forTenant(ctx.organizationId)
  const where = { status: { in: [...OPEN] }, OR: [{ assigneeMemberId: me }, { principalMemberId: me }] }
  const [total, tasks, calendar] = await Promise.all([
    db.approvalTask.count({ where }),
    db.approvalTask.findMany({
      where,
      select: {
        id: true,
        status: true,
        assigneeMemberId: true,
        principalMemberId: true,
        assignedAt: true,
        dueAt: true,
        step: { select: { route: { select: { subjectType: true, subjectId: true } } } },
      },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { assignedAt: 'asc' }, { id: 'asc' }],
      take: Math.min(options.limit ?? INBOX_LIMIT, INBOX_LIMIT),
    }),
    businessCalendarOf(db, ctx.organizationId),
  ])
  const [subject, members, pauses] = await Promise.all([
    subjectsOf(db, tasks),
    membersById(db, tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId])),
    slaPausesOf(db, tasks.map((t) => t.id)),
  ])
  return {
    total,
    items: tasks.map((t) => {
      const holding =
        t.principalMemberId && t.assigneeMemberId === me && members.has(t.principalMemberId)
          ? { kind: 'FOR' as const, member: members.get(t.principalMemberId)! }
          : t.principalMemberId === me && members.has(t.assigneeMemberId)
            ? { kind: 'BY' as const, member: members.get(t.assigneeMemberId)! }
            : null
      return {
        id: t.id,
        status: t.status as 'OPEN' | 'INFO_REQUESTED',
        subjectType: t.step.route.subjectType,
        subjectId: t.step.route.subjectId,
        subject: subject(t.step.route.subjectType, t.step.route.subjectId),
        assignedAt: t.assignedAt,
        dueAt: t.dueAt,
        waitingMinutes: businessMinutesWaited(calendar, t.assignedAt, ctx.now, pauses.get(t.id) ?? []),
        overdue: t.status === 'OPEN' && t.dueAt !== null && t.dueAt.getTime() < ctx.now.getTime(),
        holding,
        stepUp: POLICY_SUBJECTS.includes(t.step.route.subjectType),
      }
    }),
  }
}

// ---------- one task ----------

export interface TaskAccessDto {
  readonly taskId: string
  readonly status: TaskStatusDto
  readonly subjectType: TaskSubjectType
  readonly subjectId: string
  readonly assigneeMemberId: string
  /** The delegator when a delegate holds the task: they may decide it too (BR-DLG-04) */
  readonly principalMemberId: string | null
  readonly decidedByMemberId: string | null
}

export async function getTaskAccess(ctx: Ctx, taskId: string): Promise<TaskAccessDto | null> {
  if (!isUuid(taskId)) return null
  const db = forTenant(ctx.organizationId)
  const task = await db.approvalTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, assigneeMemberId: true, principalMemberId: true, decidedByMemberId: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } },
  })
  if (!task) return null
  return {
    taskId: task.id,
    status: task.status,
    subjectType: task.step.route.subjectType,
    subjectId: task.step.route.subjectId,
    assigneeMemberId: task.assigneeMemberId,
    principalMemberId: task.principalMemberId,
    decidedByMemberId: task.decidedByMemberId,
  }
}

export interface PositionNameDto {
  readonly code: string
  readonly name: NameDto | null
}

/** What an authority change does, with names instead of ids (FR-DOA-010) */
export type OrgChangeDetailsDto =
  | { readonly kind: 'POSITION_ASSIGN'; readonly position: PositionNameDto; readonly department: DepartmentRefDto | null; readonly member: MemberRefDto | null }
  | { readonly kind: 'POSITION_END'; readonly position: PositionNameDto; readonly department: DepartmentRefDto | null; readonly replacement: MemberRefDto | null }
  | { readonly kind: 'DEPARTMENT_REPARENT'; readonly department: DepartmentRefDto | null; readonly currentParent: DepartmentRefDto | null; readonly newParent: DepartmentRefDto | null }
  | {
      readonly kind: 'DELEGATION_ON_BEHALF'
      readonly delegator: MemberRefDto | null
      readonly delegate: MemberRefDto | null
      readonly startsAt: Date | null
      readonly endsAt: Date | null
      readonly documentTypes: readonly string[]
      readonly maxAmount: string | null
    }
  | { readonly kind: 'IDENTITY_RESET'; readonly member: MemberRefDto | null }

/**
 * A DOA version as the decision page shows and compares it: its policy and its rules, in the shape the history of the
 * admin pages compares (FR-DOA-001 AC3), so both say the same about what changed.
 */
export interface DoaVersionContentDto {
  readonly code: string
  readonly versionNo: number
  readonly effectiveFrom: Date
  readonly amountBasis: 'GROSS' | 'NET'
  readonly selfApprovalPolicy: 'ESCALATE_NEXT_BAND' | 'BLOCK'
  readonly collapseDuplicateApprovers: boolean
  readonly stepUpThresholdSatang: bigint | null
  readonly sodPolicy: { readonly approverMayReceive: boolean; readonly requesterMayReceive: boolean }
  readonly rules: readonly DoaRuleSnapshot[]
}

/** What a policy task asks the approver to approve (BR-DOA-15) */
export type PolicySubjectDto =
  | {
      readonly kind: 'DOA_VERSION'
      readonly versionId: string
      readonly code: string
      readonly versionNo: number
      readonly status: string
      readonly effectiveFrom: Date
      readonly changeReason: string | null
      readonly submittedBy: MemberRefDto | null
      readonly submittedAt: Date | null
      readonly ruleCount: number
      /** The version in effect now, and its open tasks that keep its route to the end (BR-DOA-13) */
      readonly current: { readonly versionId: string; readonly code: string; readonly versionNo: number } | null
      readonly openTasksUnderCurrent: number
      /** The holders approved together with an organization's first version (BR-DOA-19) */
      readonly holders: ReadonlyArray<{ readonly position: PositionNameDto; readonly department: DepartmentRefDto | null; readonly member: MemberRefDto | null }>
      /** The rules and policy the approver is asked to publish; null when a stored rule cannot be read */
      readonly content: DoaVersionContentDto | null
      /** The same of the version in effect now, to compare with (FR-DOA-009 AC1); null without one */
      readonly currentContent: DoaVersionContentDto | null
      /** Names of the positions and members the rules of both versions name as approvers */
      readonly positionNames: ReadonlyMap<string, NameDto>
      readonly memberNames: ReadonlyMap<string, MemberRefDto>
    }
  | {
      readonly kind: 'ORG_AUTHORITY_CHANGE'
      readonly changeId: string
      readonly changeKind: OrgChangeKind
      readonly status: string
      readonly effectiveFrom: Date
      readonly reason: string
      readonly submittedBy: MemberRefDto | null
      readonly submittedAt: Date | null
      readonly details: OrgChangeDetailsDto | null
      readonly impact: { readonly gains: readonly MemberRefDto[]; readonly loses: readonly MemberRefDto[]; readonly openTasks: number } | null
    }

export interface TaskViewDto {
  readonly id: string
  readonly status: TaskStatusDto
  readonly subjectType: TaskSubjectType
  readonly subjectId: string
  readonly assignee: MemberRefDto | null
  readonly principal: MemberRefDto | null
  /** The position the task came from, e.g. VP of สายปฏิบัติการ */
  readonly role: ApproverRoleDto
  readonly assignedAt: Date
  readonly dueAt: Date | null
  readonly waitingMinutes: number | null
  readonly overdue: boolean
  readonly decision: 'APPROVE' | 'RETURN' | 'REJECT' | null
  readonly decidedAt: Date | null
  readonly decidedBy: MemberRefDto | null
  readonly decidedChannel: string | null
  readonly reason: string | null
  /** REASSIGNED: who holds the task now */
  readonly reassignedTo: MemberRefDto | null
  /** CANCELLED: why the task ended without a decision */
  readonly cancelledWhy: 'REQUEST_CANCELLED' | 'ROUTE_REPLACED' | 'DOCUMENT_DECIDED' | null
  /** INFO_REQUESTED: the question that waits for the requester */
  readonly openQuestion: { readonly id: string; readonly question: string; readonly askedAt: Date } | null
  readonly stepUp: boolean
  readonly route: RouteDto | null
  readonly policy: PolicySubjectDto | null
  /** The timeline of a policy document (a request's comes with getRequestView) */
  readonly track: readonly TrackEntryDto[]
}

const CHANGE_KINDS: readonly OrgChangeKind[] = ['POSITION_ASSIGN', 'POSITION_END', 'DEPARTMENT_REPARENT', 'DELEGATION_ON_BEHALF', 'IDENTITY_RESET']
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

async function orgChangeOf(db: TenantDb, changeId: string, departments: { byId: Map<string, DepartmentRefDto> }): Promise<PolicySubjectDto | null> {
  const change = await db.orgAuthorityChange.findUnique({ where: { id: changeId } })
  if (!change) return null
  const p = (change.payload && typeof change.payload === 'object' ? change.payload : {}) as Record<string, unknown>
  const impact = (change.impactSummary && typeof change.impactSummary === 'object' ? change.impactSummary : null) as { gains?: unknown; loses?: unknown; openTasks?: unknown } | null
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isUuid(x)) : [])
  const members = await membersById(db, [change.submittedById, text(p.memberId), text(p.replacementMemberId), text(p.delegatorMemberId), text(p.delegateMemberId), ...ids(impact?.gains), ...ids(impact?.loses)])
  const positionCode = text(p.positionCode)
  const position = positionCode ? await db.position.findFirst({ where: { code: positionCode }, select: { code: true, nameTh: true, nameEn: true } }) : null
  const positionName: PositionNameDto = { code: positionCode ?? '', name: position ? { th: position.nameTh, en: position.nameEn } : null }
  const member = (v: unknown) => (text(v) ? (members.get(text(v)!) ?? null) : null)
  const department = (v: unknown) => (text(v) ? (departments.byId.get(text(v)!) ?? null) : null)
  const date = (v: unknown) => (text(v) && !Number.isNaN(Date.parse(text(v)!)) ? new Date(text(v)!) : null)
  const kind = change.kind as OrgChangeKind
  let details: OrgChangeDetailsDto | null = null
  switch (kind) {
    case 'POSITION_ASSIGN':
      details = { kind, position: positionName, department: department(p.departmentId), member: member(p.memberId) }
      break
    case 'POSITION_END':
      details = { kind, position: positionName, department: department(p.departmentId), replacement: member(p.replacementMemberId) }
      break
    case 'DEPARTMENT_REPARENT': {
      const moving = department(p.departmentId)
      const parentId = moving ? (await db.department.findUnique({ where: { id: moving.id }, select: { parentId: true } }))?.parentId : null
      details = { kind, department: moving, currentParent: parentId ? (departments.byId.get(parentId) ?? null) : null, newParent: department(p.newParentId) }
      break
    }
    case 'DELEGATION_ON_BEHALF':
      details = {
        kind,
        delegator: member(p.delegatorMemberId),
        delegate: member(p.delegateMemberId),
        startsAt: date(p.startsAt),
        endsAt: date(p.endsAt),
        documentTypes: Array.isArray(p.documentTypes) ? p.documentTypes.filter((d): d is string => typeof d === 'string') : [],
        maxAmount: text(p.maxAmount),
      }
      break
    case 'IDENTITY_RESET':
      details = { kind, member: member(p.memberId) }
      break
  }
  return {
    kind: 'ORG_AUTHORITY_CHANGE',
    changeId: change.id,
    changeKind: CHANGE_KINDS.includes(kind) ? kind : 'POSITION_ASSIGN',
    status: change.status,
    effectiveFrom: change.effectiveFrom,
    reason: change.reason,
    submittedBy: members.get(change.submittedById) ?? null,
    submittedAt: change.submittedAt,
    details,
    impact: impact
      ? {
          gains: ids(impact.gains).map((id) => members.get(id)).filter((m): m is MemberRefDto => Boolean(m)),
          loses: ids(impact.loses).map((id) => members.get(id)).filter((m): m is MemberRefDto => Boolean(m)),
          openTasks: typeof impact.openTasks === 'number' ? impact.openTasks : 0,
        }
      : null,
  }
}

const SatangText = z.string().regex(/^\d{1,18}$/).transform((v) => BigInt(v))
/** DoaRule as stored (when and steps are JSON with satang as text), read as the engine reads it */
const StoredRule = z.object({
  code: z.string().min(1),
  documentType: z.enum(DOA_DOCUMENT_TYPES),
  priority: z.number().int(),
  when: z.object({ amount: z.object({ gt: SatangText.optional(), gte: SatangText.optional(), lte: SatangText.optional() }).optional() }),
  steps: z
    .array(
      z.object({
        approver: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('POSITION_OF_DEPARTMENT'), position: z.string().min(1) }),
          z.object({ kind: z.literal('POSITION_OF_ORG'), position: z.string().min(1) }),
          z.object({ kind: z.literal('MEMBER'), memberId: z.string().min(1) }),
        ]),
        slaBusinessMinutes: z.number().int().positive(),
        mode: z.enum(['SEQUENTIAL', 'PARALLEL']),
      }),
    )
    .min(1),
})
const StoredSodPolicy = z.object({ approverMayReceive: z.boolean(), requesterMayReceive: z.boolean() })

/** A version's policy and rules in the order they were written; null when the version or one of its rules cannot be read */
async function doaContentOf(db: TenantDb, versionId: string): Promise<DoaVersionContentDto | null> {
  const v = await db.doaVersion.findUnique({
    where: { id: versionId },
    select: {
      code: true,
      versionNo: true,
      effectiveFrom: true,
      amountBasis: true,
      selfApprovalPolicy: true,
      collapseDuplicateApprovers: true,
      stepUpThresholdSatang: true,
      sodPolicy: true,
      rules: { select: { code: true, documentType: true, priority: true, when: true, steps: true }, orderBy: { id: 'asc' } },
    },
  })
  const sod = StoredSodPolicy.safeParse(v?.sodPolicy)
  if (!v || !sod.success) return null
  const rules: DoaRuleSnapshot[] = []
  for (const row of v.rules) {
    const parsed = StoredRule.safeParse(row)
    if (!parsed.success) return null
    const amount = parsed.data.when.amount
    rules.push({
      code: parsed.data.code,
      documentType: parsed.data.documentType,
      priority: parsed.data.priority,
      when: amount
        ? {
            amount: {
              ...(amount.gt !== undefined ? { gt: amount.gt } : {}),
              ...(amount.gte !== undefined ? { gte: amount.gte } : {}),
              ...(amount.lte !== undefined ? { lte: amount.lte } : {}),
            },
          }
        : {},
      steps: parsed.data.steps.map((s) => ({ approver: s.approver, slaBusinessMinutes: s.slaBusinessMinutes, mode: s.mode })),
    })
  }
  return {
    code: v.code,
    versionNo: v.versionNo,
    effectiveFrom: v.effectiveFrom,
    amountBasis: v.amountBasis,
    selfApprovalPolicy: v.selfApprovalPolicy,
    collapseDuplicateApprovers: v.collapseDuplicateApprovers,
    stepUpThresholdSatang: v.stepUpThresholdSatang,
    sodPolicy: sod.data,
    rules,
  }
}

async function doaVersionOf(db: TenantDb, ctx: Ctx, versionId: string, routeId: string, departments: { byId: Map<string, DepartmentRefDto> }): Promise<PolicySubjectDto | null> {
  const version = await db.doaVersion.findUnique({ where: { id: versionId }, include: { _count: { select: { rules: true } } } })
  if (!version) return null
  const now = ctx.now
  const current = await db.doaVersion.findFirst({
    where: { status: 'PUBLISHED', effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { id: true, code: true, versionNo: true },
  })
  // What the approver publishes, and what is in effect now to compare it with (FR-DOA-002 AC2, FR-DOA-009 AC1)
  const [content, currentContent] = await Promise.all([doaContentOf(db, version.id), current && current.id !== version.id ? doaContentOf(db, current.id) : Promise.resolve(null)])
  const approvers = [...(content?.rules ?? []), ...(currentContent?.rules ?? [])].flatMap((r) => r.steps.map((s) => s.approver))
  const positionCodes = [...new Set(approvers.flatMap((a) => (a.kind === 'MEMBER' ? [] : [a.position])))]
  const [positionRows, memberNames] = await Promise.all([
    positionCodes.length ? db.position.findMany({ where: { code: { in: positionCodes } }, select: { code: true, nameTh: true, nameEn: true } }) : Promise.resolve([]),
    membersById(db, approvers.flatMap((a) => (a.kind === 'MEMBER' ? [a.memberId] : []))),
  ])
  // BR-DOA-13: documents routed under the version in effect keep that route to the end
  const openTasksUnderCurrent = current
    ? await db.approvalTask.count({ where: { status: { in: [...OPEN] }, step: { route: { doaVersionId: current.id, status: 'ACTIVE', subjectType: { not: 'DOA_VERSION' } } } } })
    : 0
  // The holders of an initial package are authority changes on the same route (BR-DOA-19)
  const holders = await db.orgAuthorityChange.findMany({ where: { routeId }, select: { payload: true }, orderBy: { id: 'asc' } })
  const payloads = holders.map((h) => (h.payload && typeof h.payload === 'object' ? h.payload : {}) as Record<string, unknown>)
  const members = await membersById(db, [version.submittedById, ...payloads.map((p) => text(p.memberId))])
  const codes = [...new Set(payloads.map((p) => text(p.positionCode)).filter((c): c is string => Boolean(c)))]
  const positions = codes.length ? await db.position.findMany({ where: { code: { in: codes } }, select: { code: true, nameTh: true, nameEn: true } }) : []
  return {
    kind: 'DOA_VERSION',
    versionId: version.id,
    code: version.code,
    versionNo: version.versionNo,
    status: version.status,
    effectiveFrom: version.effectiveFrom,
    changeReason: version.changeReason,
    submittedBy: version.submittedById ? (members.get(version.submittedById) ?? null) : null,
    submittedAt: version.submittedAt,
    ruleCount: version._count.rules,
    current: current && current.id !== version.id ? { versionId: current.id, code: current.code, versionNo: current.versionNo } : null,
    openTasksUnderCurrent: current && current.id !== version.id ? openTasksUnderCurrent : 0,
    holders: payloads.map((p) => {
      const code = text(p.positionCode) ?? ''
      const position = positions.find((x) => x.code === code)
      return {
        position: { code, name: position ? { th: position.nameTh, en: position.nameEn } : null },
        department: text(p.departmentId) ? (departments.byId.get(text(p.departmentId)!) ?? null) : null,
        member: text(p.memberId) ? (members.get(text(p.memberId)!) ?? null) : null,
      }
    }),
    content,
    currentContent,
    positionNames: new Map(positionRows.map((p) => [p.code, { th: p.nameTh, en: p.nameEn }])),
    memberNames,
  }
}

/** Who decided a task and when, in both languages (FR-DOA-004 AC2: a second decision is told who and when) */
export async function taskDecision(ctx: Ctx, taskId: string): Promise<{ readonly decidedBy: MemberRefDto | null; readonly decidedAt: Date | null } | null> {
  if (!isUuid(taskId)) return null
  const db = forTenant(ctx.organizationId)
  const task = await db.approvalTask.findUnique({ where: { id: taskId }, select: { decidedAt: true, decidedByMemberId: true } })
  if (!task) return null
  const members = await membersById(db, [task.decidedByMemberId])
  return { decidedBy: task.decidedByMemberId ? (members.get(task.decidedByMemberId) ?? null) : null, decidedAt: task.decidedAt }
}

const CANCELLED_WHY = ['REQUEST_CANCELLED', 'ROUTE_REPLACED', 'DOCUMENT_DECIDED'] as const

export async function getTaskView(ctx: Ctx, taskId: string): Promise<TaskViewDto | null> {
  if (!isUuid(taskId)) return null
  const db = forTenant(ctx.organizationId)
  const task = await db.approvalTask.findUnique({
    where: { id: taskId },
    include: {
      step: { select: { routeId: true, route: { select: { subjectType: true, subjectId: true } } } },
      reassignedTo: { select: { assigneeMemberId: true }, orderBy: { assignedAt: 'desc' }, take: 1 },
      // Every question of the task: the open one waits for the requester, and all of them paused its SLA (BR-SLA-03)
      infoRequests: { orderBy: { askedAt: 'desc' }, select: { id: true, question: true, askedAt: true, answeredAt: true } },
    },
  })
  if (!task) return null
  const subjectType = task.step.route.subjectType
  const subjectId = task.step.route.subjectId
  const departments = await departmentsOf(db)
  const roleOf = await approverRoles(db, departments.byCode)
  const members = await membersById(db, [task.assigneeMemberId, task.principalMemberId, task.decidedByMemberId, task.reassignedTo[0]?.assigneeMemberId])
  const [calendar, route] = await Promise.all([businessCalendarOf(db, ctx.organizationId), routeOf(db, task.step.routeId, members, roleOf)])
  const cancelled =
    task.status === 'CANCELLED' ? await db.event.findFirst({ where: { aggregateType: 'ApprovalTask', aggregateId: task.id, type: 'approval_task.cancelled' }, orderBy: { seq: 'desc' }, select: { data: true } }) : null
  const why = text((cancelled?.data as { why?: unknown } | null)?.why)

  const stepUp = POLICY_SUBJECTS.includes(subjectType)
  let policy: PolicySubjectDto | null = null
  let track: TrackEntryDto[] = []
  if (stepUp) {
    policy = subjectType === 'DOA_VERSION' ? await doaVersionOf(db, ctx, subjectId, task.step.routeId, departments) : await orgChangeOf(db, subjectId, departments)
    const tasks = await db.approvalTask.findMany({ where: { step: { route: { subjectType, subjectId } } }, select: { id: true, resolvedFrom: true } })
    const events = await documentEvents(db, subjectType === 'DOA_VERSION' ? 'DoaVersion' : 'OrgAuthorityChange', subjectId, tasks.map((t) => t.id))
    track = await historyOf(db, events, new Map(tasks.map((t) => [t.id, t.resolvedFrom])), roleOf)
  }

  const open = task.status === 'OPEN' || task.status === 'INFO_REQUESTED'
  const unanswered = task.infoRequests.find((i) => i.answeredAt === null)
  return {
    id: task.id,
    status: task.status,
    subjectType,
    subjectId,
    assignee: members.get(task.assigneeMemberId) ?? null,
    principal: task.principalMemberId ? (members.get(task.principalMemberId) ?? null) : null,
    role: roleOf(task.resolvedFrom),
    assignedAt: task.assignedAt,
    dueAt: task.dueAt,
    waitingMinutes: open ? businessMinutesWaited(calendar, task.assignedAt, ctx.now, task.infoRequests) : null,
    overdue: task.status === 'OPEN' && task.dueAt !== null && task.dueAt.getTime() < ctx.now.getTime(),
    decision: task.decision,
    decidedAt: task.decidedAt,
    decidedBy: task.decidedByMemberId ? (members.get(task.decidedByMemberId) ?? null) : null,
    decidedChannel: task.channel,
    reason: task.reason,
    reassignedTo: task.reassignedTo[0] ? (members.get(task.reassignedTo[0].assigneeMemberId) ?? null) : null,
    cancelledWhy: why && (CANCELLED_WHY as readonly string[]).includes(why) ? (why as (typeof CANCELLED_WHY)[number]) : null,
    openQuestion: task.status === 'INFO_REQUESTED' && unanswered ? { id: unanswered.id, question: unanswered.question, askedAt: unanswered.askedAt } : null,
    stepUp,
    route,
    policy,
    track,
  }
}

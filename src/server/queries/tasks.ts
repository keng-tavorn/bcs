import { z } from 'zod'
import { DOA_DOCUMENT_TYPES, stepApprovers, type DoaRuleSnapshot, type DoaStepSpec } from '@/core/doa'
import type { ApprovalSubject } from '@/core/sod'
import { stepUpNeeded } from '@/core/pin'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantDb, type TenantTx } from '@/server/db/tenant'
import { comparisonBaselineId } from './doa'
import {
  approverRoles,
  businessCalendarOf,
  businessMinutesSince,
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
// for them (BR-DLG-04: both may decide): those waiting for a decision first, oldest due first, with the business time
// each has waited; then those waiting for the requester's answer, with how long the question has waited. Queries never check
// permissions: the decision page asks getTaskAccess() first and checks approval.decide (or that the task was the
// member's) with src/server/authz before it reads the task. closingDecisionOf is the one rule of "who decided it and
// when" (FR-DOA-004 AC2, §9.3): the decision page, the refusal of a late decision, the LINE button and the e-mail link
// all name the decider through it, the services with the transaction that holds the task's lock.

/** APPROVAL_SUBJECTS of src/core/sod (P1-07): one list for every subject */
export type TaskSubjectType = ApprovalSubject
export type TaskStatusDto = 'OPEN' | 'INFO_REQUESTED' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED' | 'REASSIGNED'
export type OrgChangeKind = 'POSITION_ASSIGN' | 'POSITION_END' | 'DEPARTMENT_REPARENT' | 'DELEGATION_ON_BEHALF' | 'IDENTITY_RESET'

/** BR-DOA-15: DOA versions and authority changes are approved or rejected with a step-up, on the web or LIFF only */
export const POLICY_SUBJECTS: readonly TaskSubjectType[] = ['DOA_VERSION', 'ORG_AUTHORITY_CHANGE']
/**
 * The subjects decided on the policy decision panel: approved or rejected, every time with the PIN — the policies and a
 * workflow version to publish (S6 · BR-WF-12, decided on the web only)
 */
export const PIN_DECISION_SUBJECTS: readonly TaskSubjectType[] = [...POLICY_SUBJECTS, 'WORKFLOW_VERSION']

/** A workflow version sent to be published, as its approver reads it on the task (FR-WF-103 AC3) */
export interface WorkflowTaskDto {
  readonly versionId: string
  readonly code: string
  readonly versionNo: number
  readonly status: string
  readonly effectiveFrom: Date
  readonly changeReason: string | null
  readonly submittedBy: MemberRefDto | null
  readonly rules: number
  /** The task decides a withdrawal of the version rather than its publishing (FR-WF-103 · FR-DOA-104); null otherwise */
  readonly withdrawal: WithdrawalTaskDto | null
}

/**
 * A task on the route of a withdrawal (FR-DOA-104 · BR-DOA-18): approving withdraws the version, rejecting keeps it. Who
 * asked, when and why while it waits or once it is withdrawn (a rejected withdrawal clears them: null then)
 */
export interface WithdrawalTaskDto {
  readonly requestedBy: MemberRefDto | null
  readonly requestedAt: Date | null
  readonly reason: string | null
  readonly withdrawnAt: Date | null
}
const OPEN = ['OPEN', 'INFO_REQUESTED'] as const

/** What a task's route says about the step-up its decision needs: the amount the DOA counted and the version's threshold */
const STEP_UP_ROUTE = { subjectType: true, subjectId: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } as const

/**
 * FR-AUTH-005 AC2, BR-DOA-15: deciding this task needs the PIN — every policy task, and every task whose amount the DOA
 * counted is at or above its version's stepUpThreshold (the rule of src/core/pin the deciding commands apply)
 */
const needsStepUp = (route: { subjectType: string; amountSatang: bigint | null; doaVersion: { stepUpThresholdSatang: bigint | null } }) =>
  stepUpNeeded({ subjectType: route.subjectType, amountSatang: route.amountSatang, stepUpThresholdSatang: route.doaVersion.stepUpThresholdSatang })

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
  /** A workflow version sent to be published (S6 · FR-WF-103 AC3) */
  | { readonly kind: 'WORKFLOW_VERSION'; readonly code: string; readonly versionNo: number; readonly effectiveFrom: Date }
  /** S6-15: a budget transfer, increase or decrease and the amount it moves */
  | { readonly kind: 'BUDGET_TRANSFER'; readonly number: string | null; readonly transferKind: 'TRANSFER' | 'INCREASE' | 'DECREASE'; readonly amountSatang: bigint }
  /** S6-16: an over-budget approval, the request it is for and the shortfall asked */
  | { readonly kind: 'BUDGET_OVERRUN'; readonly number: string; readonly requestNumber: string | null; readonly requestTitle: string; readonly amountSatang: bigint }
  | { readonly kind: 'ORG_AUTHORITY_CHANGE'; readonly changeKind: OrgChangeKind; readonly effectiveFrom: Date }
  /** A purchase order sent for approval (FR-P2P-004): its number, supplier, who sent it and its total with VAT */
  | {
      readonly kind: 'PURCHASE_ORDER'
      readonly poId: string
      readonly number: string | null
      readonly supplierName: string
      /** The member of its latest sending for approval (po.submitted), who may not be the one who made the draft */
      readonly submittedBy: MemberRefDto | null
      readonly grossSatang: bigint
    }
  /** A variance of a goods receipt waiting for the GR_VARIANCE approver (FR-P2P-007 AC2): before VAT, as recorded */
  | {
      readonly kind: 'VARIANCE'
      readonly varianceId: string
      readonly poNumber: string | null
      readonly description: string
      readonly varianceType: 'SHORT' | 'OVER' | 'DAMAGED'
      readonly amountSatang: bigint
    }
  /** S8: the price variance of an invoice (INVOICE) and a change of a sent PO (PO_CHANGE), with their supplier */
  /** supplierName only for a juristic person (BR-AP-09: an individual payee's name is not on approval cards) */
  | { readonly kind: 'INVOICE'; readonly invoiceId: string; readonly number: string | null; readonly poNumber: string | null; readonly supplierName: string | null }
  | { readonly kind: 'PO_CHANGE'; readonly poChangeId: string; readonly poNumber: string | null; readonly changeNo: number; readonly supplierName: string; readonly grossSatang: bigint }
  /** S9: a payment run (its number and what it transfers) and a change of a bank account (no account number) */
  | { readonly kind: 'PAYMENT_RUN'; readonly paymentRunId: string; readonly number: string | null; readonly transferSatang: bigint; readonly itemCount: number }
  | { readonly kind: 'BANK_ACCOUNT_CHANGE'; readonly changeId: string; readonly number: string | null; readonly changeKind: 'ADD' | 'REPLACE' | 'CLOSE'; readonly supplierCode: string | null }
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
  /** Deciding it needs the PIN (FR-AUTH-005 AC2): a policy task, or an amount at or above the version's stepUpThreshold */
  readonly stepUp: boolean
  /** A reviewer's task of a REVIEW step (S6): pass, return or ask — no rejection, no PIN */
  readonly review: boolean
  /** The amount the DOA counted for the route (its basis, BR-DOA-02); null for a route without one, such as a policy */
  readonly amountSatang: bigint | null
  /**
   * INFO_REQUESTED: the question that waits for the requester's answer — when it was asked, and the business minutes it
   * has waited since, counted as the request page counts its ANSWER step (§9.9 principle 4; null without a business
   * calendar); null while the task waits for a decision
   */
  readonly question: { readonly askedAt: Date; readonly waitingMinutes: number | null } | null
}

export interface InboxDto {
  readonly items: readonly InboxTaskDto[]
  /** All open tasks of the member the filter keeps, also when `items` is cut at the limit */
  readonly total: number
}

/**
 * Which of the member's open tasks: OVERDUE — waiting for their decision past the due time (the home's to-do row and
 * /tasks?due=overdue); INFO — waiting for the requester's answer (the home's tab "รอผู้ขอตอบ"); null — all of them
 */
export type InboxDue = 'OVERDUE' | 'INFO' | null

/** The member's open tasks in a filter: assigned to them, or held for them by their delegate (BR-DLG-04) */
function inboxWhere(me: string, due: InboxDue | 'DECIDING', now: Date) {
  const mine = [{ assigneeMemberId: me }, { principalMemberId: me }]
  if (due === 'OVERDUE') return { status: 'OPEN' as const, dueAt: { lt: now }, OR: mine }
  if (due === 'INFO') return { status: 'INFO_REQUESTED' as const, OR: mine }
  if (due === 'DECIDING') return { status: 'OPEN' as const, OR: mine }
  return { status: { in: [...OPEN] }, OR: mine }
}

/** How many open tasks the member has, in each filter of the inbox: one read for the home and the menu (§9.10) */
export async function countMyTasks(ctx: Ctx): Promise<{ readonly all: number; readonly overdue: number; readonly info: number }> {
  if (ctx.actor.type !== 'USER') return { all: 0, overdue: 0, info: 0 }
  const db = forTenant(ctx.organizationId)
  const me = ctx.actor.memberId
  const [all, overdue, info] = await Promise.all([
    db.approvalTask.count({ where: inboxWhere(me, null, ctx.now) }),
    db.approvalTask.count({ where: inboxWhere(me, 'OVERDUE', ctx.now) }),
    db.approvalTask.count({ where: inboxWhere(me, 'INFO', ctx.now) }),
  ])
  return { all, overdue, info }
}

const INBOX_LIMIT = 200

/** What the inbox reads of a task */
const INBOX_TASK = {
  id: true,
  status: true,
  assigneeMemberId: true,
  principalMemberId: true,
  assignedAt: true,
  dueAt: true,
  step: { select: { kind: true, route: { select: STEP_UP_ROUTE } } },
} as const

/** A reviewer's task (S6 · BR-WF-09) needs no step-up, whatever the amount; every other as its route says */
const stepUpOf = (step: { readonly kind: string; readonly route: Parameters<typeof needsStepUp>[0] }) => step.kind !== 'REVIEW' && needsStepUp(step.route)

async function subjectsOf(db: TenantDb, tasks: ReadonlyArray<{ step: { route: { subjectType: string; subjectId: string } } }>): Promise<(type: string, id: string) => InboxSubjectDto> {
  const ids = (type: string) => [...new Set(tasks.filter((t) => t.step.route.subjectType === type).map((t) => t.step.route.subjectId))]
  const [requests, versions, changes, departments, pos, variances, workflows, transfers, overruns, invoices, poChanges, runs, bankChanges] = await Promise.all([
    ids('REQUEST').length
      ? db.request.findMany({
          where: { id: { in: ids('REQUEST') } },
          select: { id: true, number: true, title: true, grossSatang: true, netSatang: true, chargedDepartmentId: true, requester: { select: { id: true, displayNameTh: true, displayNameEn: true } } },
        })
      : Promise.resolve([]),
    ids('DOA_VERSION').length ? db.doaVersion.findMany({ where: { id: { in: ids('DOA_VERSION') } }, select: { id: true, code: true, versionNo: true, effectiveFrom: true } }) : Promise.resolve([]),
    ids('ORG_AUTHORITY_CHANGE').length ? db.orgAuthorityChange.findMany({ where: { id: { in: ids('ORG_AUTHORITY_CHANGE') } }, select: { id: true, kind: true, effectiveFrom: true } }) : Promise.resolve([]),
    departmentsOf(db),
    ids('PURCHASE_ORDER').length
      ? db.purchaseOrder.findMany({
          where: { id: { in: ids('PURCHASE_ORDER') } },
          select: { id: true, number: true, grossSatang: true, supplier: { select: { nameTh: true } } },
        })
      : Promise.resolve([]),
    ids('VARIANCE').length
      ? db.variance.findMany({ where: { id: { in: ids('VARIANCE') } }, select: { id: true, type: true, amountSatang: true, po: { select: { number: true } }, poLine: { select: { description: true } } } })
      : Promise.resolve([]),
    ids('WORKFLOW_VERSION').length ? db.workflowVersion.findMany({ where: { id: { in: ids('WORKFLOW_VERSION') } }, select: { id: true, code: true, versionNo: true, effectiveFrom: true } }) : Promise.resolve([]),
    ids('BUDGET_TRANSFER').length ? db.budgetTransfer.findMany({ where: { id: { in: ids('BUDGET_TRANSFER') } }, select: { id: true, number: true, kind: true, amountSatang: true } }) : Promise.resolve([]),
    ids('BUDGET_OVERRUN').length
      ? db.budgetOverrun.findMany({ where: { id: { in: ids('BUDGET_OVERRUN') } }, select: { id: true, number: true, shortfallSatang: true, request: { select: { number: true, title: true } } } })
      : Promise.resolve([]),
    ids('INVOICE').length
      ? db.invoice.findMany({ where: { id: { in: ids('INVOICE') } }, select: { id: true, number: true, po: { select: { number: true } }, supplier: { select: { nameTh: true, payeeType: true } } } })
      : Promise.resolve([]),
    ids('PO_CHANGE').length
      ? db.poChange.findMany({ where: { id: { in: ids('PO_CHANGE') } }, select: { id: true, changeNo: true, newGrossSatang: true, po: { select: { number: true, supplier: { select: { nameTh: true } } } } } })
      : Promise.resolve([]),
    ids('PAYMENT_RUN').length ? db.paymentRun.findMany({ where: { id: { in: ids('PAYMENT_RUN') } }, select: { id: true, number: true, totalTransferSatang: true, itemCount: true } }) : Promise.resolve([]),
    ids('BANK_ACCOUNT_CHANGE').length
      ? db.bankAccountChange.findMany({ where: { id: { in: ids('BANK_ACCOUNT_CHANGE') } }, select: { id: true, number: true, kind: true, supplier: { select: { code: true } } } })
      : Promise.resolve([]),
  ])
  const overrun = new Map(overruns.map((o) => [o.id, o]))
  const transfer = new Map(transfers.map((t) => [t.id, t]))
  const workflow = new Map(workflows.map((w) => [w.id, w]))
  const request = new Map(requests.map((r) => [r.id, r]))
  const version = new Map(versions.map((v) => [v.id, v]))
  const change = new Map(changes.map((c) => [c.id, c]))
  const po = new Map(pos.map((p) => [p.id, p]))
  const variance = new Map(variances.map((v) => [v.id, v]))
  const invoice = new Map(invoices.map((i) => [i.id, i]))
  const poChange = new Map(poChanges.map((c) => [c.id, c]))
  const run = new Map(runs.map((r) => [r.id, r]))
  const bankChange = new Map(bankChanges.map((c) => [c.id, c]))
  // Who sent each PO for approval: the actor of its latest po.submitted Event
  const submitted = pos.length
    ? await db.event.findMany({ where: { type: 'po.submitted', aggregateType: 'PurchaseOrder', aggregateId: { in: pos.map((p) => p.id) }, actorType: 'USER' }, orderBy: { seq: 'asc' }, select: { aggregateId: true, actorMemberId: true } })
    : []
  const submitterOf = new Map(submitted.map((e) => [e.aggregateId, e.actorMemberId]))
  const submitters = await membersById(db, submitterOf.values())
  return (type, id) => {
    if (type === 'PURCHASE_ORDER' && po.has(id)) {
      const p = po.get(id)!
      return {
        kind: 'PURCHASE_ORDER',
        poId: p.id,
        number: p.number,
        supplierName: p.supplier.nameTh,
        submittedBy: submitters.get(submitterOf.get(p.id) ?? '') ?? null,
        grossSatang: p.grossSatang,
      }
    }
    if (type === 'VARIANCE' && variance.has(id)) {
      const v = variance.get(id)!
      return { kind: 'VARIANCE', varianceId: v.id, poNumber: v.po.number, description: v.poLine.description, varianceType: v.type, amountSatang: v.amountSatang }
    }
    if (type === 'INVOICE' && invoice.has(id)) {
      const i = invoice.get(id)!
      return { kind: 'INVOICE', invoiceId: i.id, number: i.number, poNumber: i.po.number, supplierName: i.supplier.payeeType === 'JURISTIC' ? i.supplier.nameTh : null }
    }
    if (type === 'PO_CHANGE' && poChange.has(id)) {
      const c = poChange.get(id)!
      return { kind: 'PO_CHANGE', poChangeId: c.id, poNumber: c.po.number, changeNo: c.changeNo, supplierName: c.po.supplier.nameTh, grossSatang: c.newGrossSatang }
    }
    if (type === 'PAYMENT_RUN' && run.has(id)) {
      const r = run.get(id)!
      return { kind: 'PAYMENT_RUN', paymentRunId: r.id, number: r.number, transferSatang: r.totalTransferSatang, itemCount: r.itemCount }
    }
    if (type === 'BANK_ACCOUNT_CHANGE' && bankChange.has(id)) {
      const c = bankChange.get(id)!
      return { kind: 'BANK_ACCOUNT_CHANGE', changeId: c.id, number: c.number, changeKind: c.kind, supplierCode: c.supplier?.code ?? null }
    }
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
    if (type === 'BUDGET_TRANSFER' && transfer.has(id)) {
      const b = transfer.get(id)!
      return { kind: 'BUDGET_TRANSFER', number: b.number, transferKind: b.kind, amountSatang: b.amountSatang }
    }
    if (type === 'BUDGET_OVERRUN' && overrun.has(id)) {
      const o = overrun.get(id)!
      return { kind: 'BUDGET_OVERRUN', number: o.number, requestNumber: o.request.number, requestTitle: o.request.title, amountSatang: o.shortfallSatang }
    }
    if (type === 'WORKFLOW_VERSION' && workflow.has(id)) {
      const w = workflow.get(id)!
      return { kind: 'WORKFLOW_VERSION', code: w.code, versionNo: w.versionNo, effectiveFrom: w.effectiveFrom }
    }
    return { kind: 'OTHER' }
  }
}

/**
 * The member's open approval tasks (spec §9.1 /tasks, §9.4 /liff/tasks), the ones they can act on first (§9.9 principle
 * 1): those waiting for their decision, oldest due first; then those waiting for the requester's answer
 * (INFO_REQUESTED), the question asked first at the top. While a question waits the SLA has stopped (BR-SLA-03): such a
 * task's due time says nothing of its place, so it never comes before — nor, cut at the limit, pushes off the home page —
 * a task the member can decide. The order is all that changes; the tasks and their SLA are read as they are.
 */
export async function listMyTasks(ctx: Ctx, options: { readonly limit?: number; readonly due?: InboxDue } = {}): Promise<InboxDto> {
  if (ctx.actor.type !== 'USER') return { items: [], total: 0 }
  const me = ctx.actor.memberId
  const db = forTenant(ctx.organizationId)
  const limit = Math.min(options.limit ?? INBOX_LIMIT, INBOX_LIMIT)
  const due = options.due ?? null
  const [total, deciding, questions, calendar] = await Promise.all([
    db.approvalTask.count({ where: inboxWhere(me, due, ctx.now) }),
    due === 'INFO'
      ? Promise.resolve([])
      : db.approvalTask.findMany({
          where: inboxWhere(me, due ?? 'DECIDING', ctx.now),
          select: INBOX_TASK,
          orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { assignedAt: 'asc' }, { id: 'asc' }],
          take: limit,
        }),
    // The tasks waiting for an answer, by their open question: each has one, from approval.requestInfo until
    // request.provideInfo (a task moved to another approver took it along), so the one asked first comes first
    due === 'OVERDUE'
      ? Promise.resolve([])
      : db.infoRequest.findMany({
          where: { answeredAt: null, task: inboxWhere(me, 'INFO', ctx.now) },
          select: { askedAt: true, task: { select: INBOX_TASK } },
          orderBy: [{ askedAt: 'asc' }, { id: 'asc' }],
          take: limit,
        }),
    businessCalendarOf(db, ctx.organizationId),
  ])
  const tasks = [...deciding, ...questions.map((q) => q.task)].slice(0, limit)
  // Since when each has waited for the requester: its question, as the request page's ANSWER step counts it (stageOf)
  const askedAt = new Map(questions.map((q) => [q.task.id, q.askedAt]))
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
      const asked = askedAt.get(t.id)
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
        stepUp: stepUpOf(t.step),
        review: t.step.kind === 'REVIEW',
        amountSatang: t.step.route.amountSatang,
        question: asked ? { askedAt: asked, waitingMinutes: businessMinutesSince(calendar, asked, ctx.now) } : null,
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
  /** Deciding it needs the PIN (FR-AUTH-005 AC2): a policy task, or an amount at or above the version's stepUpThreshold */
  readonly stepUp: boolean
}

export async function getTaskAccess(ctx: Ctx, taskId: string): Promise<TaskAccessDto | null> {
  if (!isUuid(taskId)) return null
  const db = forTenant(ctx.organizationId)
  const task = await db.approvalTask.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, assigneeMemberId: true, principalMemberId: true, decidedByMemberId: true, step: { select: { kind: true, route: { select: STEP_UP_ROUTE } } } },
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
    stepUp: stepUpOf(task.step),
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
  readonly sodPolicy: { readonly approverMayReceive: boolean; readonly requesterMayReceive: boolean; readonly doaAdminSeparated?: boolean }
  readonly rules: readonly DoaRuleSnapshot[]
}

/**
 * The version a DOA version is compared with (FR-DOA-009 AC1, AC3), and how it stands now: IN_EFFECT now; NEXT,
 * approved for later and in effect just before this version starts; REPLACED, in effect before this version and ended.
 */
export interface DoaBaselineDto {
  readonly versionId: string
  readonly code: string
  readonly versionNo: number
  readonly effectiveFrom: Date
  readonly relation: 'IN_EFFECT' | 'NEXT' | 'REPLACED'
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
      /** The task decides a withdrawal of the version rather than its publishing (FR-DOA-104); null otherwise */
      readonly withdrawal: WithdrawalTaskDto | null
      /** The holders approved together with an organization's first version (BR-DOA-19) */
      readonly holders: ReadonlyArray<{ readonly position: PositionNameDto; readonly department: DepartmentRefDto | null; readonly member: MemberRefDto | null }>
      /** The rules and policy the approver is asked to publish; null when a stored rule cannot be read */
      readonly content: DoaVersionContentDto | null
      /**
       * The version it is compared with — the diff, the authority gained or lost and the boundary table the approver
       * ticks (FR-DOA-009 AC1, AC3): the one the drafter's page, the send and the approval compare it with; null without
       * one (an organization's first version)
       */
      readonly baseline: DoaBaselineDto | null
      /** The rules and policy of the baseline; null without one, or when one of its stored rules cannot be read */
      readonly baselineContent: DoaVersionContentDto | null
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
  /**
   * CANCELLED: why the task ended without a decision — CO_ASSIGNEE_DECIDED when another approver of its step decided
   * first (the co-assignee of an escalated step, or the first assignee, BR-SLA-04)
   */
  readonly cancelledWhy: (typeof CANCELLED_WHY)[number] | null
  /**
   * CANCELLED or REASSIGNED with no decision of its own, once another task of its step decided the step — the other
   * approver of an escalated step decided first (BR-SLA-04), or the delegate it moved to decided it: what was decided,
   * by whom and when (FR-DOA-004 AC2, §9.3 "ดำเนินการแล้วโดย … เมื่อ …", closingDecisionOf); null otherwise
   */
  readonly stepDecision: { readonly decision: 'APPROVE' | 'RETURN' | 'REJECT' | null; readonly decidedBy: MemberRefDto | null; readonly decidedAt: Date } | null
  /** INFO_REQUESTED: the question that waits for the requester */
  readonly openQuestion: { readonly id: string; readonly question: string; readonly askedAt: Date } | null
  /** Deciding it needs the PIN (FR-AUTH-005 AC2): a policy task, or an amount at or above the version's stepUpThreshold */
  readonly stepUp: boolean
  /** A reviewer's task of a REVIEW step (S6): pass, return or ask — no rejection, no PIN */
  readonly review: boolean
  readonly route: RouteDto | null
  readonly policy: PolicySubjectDto | null
  /** WORKFLOW_VERSION tasks: the version to publish */
  readonly workflow: WorkflowTaskDto | null
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
const StoredApprover = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('POSITION_OF_DEPARTMENT'), position: z.string().min(1) }),
  z.object({ kind: z.literal('POSITION_OF_ORG'), position: z.string().min(1) }),
  z.object({ kind: z.literal('MEMBER'), memberId: z.string().min(1) }),
])
const SlaMinutes = z.number().int().positive()
const StoredCommittee = z.object({
  approvers: z.array(StoredApprover).min(1),
  slaBusinessMinutes: SlaMinutes,
  mode: z.literal('PARALLEL'),
  quorum: z.enum(['ALL', 'ANY', 'COUNT', 'MAJORITY']),
  quorumCount: z.number().int().positive().optional(),
})
/** DoaRule as stored (when and steps are JSON with satang as text), read as the engine reads it */
const StoredRule = z.object({
  code: z.string().min(1),
  documentType: z.enum(DOA_DOCUMENT_TYPES),
  priority: z.number().int(),
  when: z.object({ amount: z.object({ gt: SatangText.optional(), gte: SatangText.optional(), lte: SatangText.optional() }).optional() }),
  // One approver or a committee (S6 · FR-WF-102), as src/server/doa/snapshot.ts reads them (queries do not import it)
  steps: z.array(z.union([z.object({ approver: StoredApprover, slaBusinessMinutes: SlaMinutes, mode: z.enum(['SEQUENTIAL', 'PARALLEL']) }), StoredCommittee])).min(1),
})
const StoredSodPolicy = z.object({ approverMayReceive: z.boolean(), requesterMayReceive: z.boolean(), doaAdminSeparated: z.boolean().optional() })

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
      steps: parsed.data.steps.map((s): DoaStepSpec => ('approvers' in s ? { ...s, approvers: s.approvers.map((a) => ({ ...a })) } : { ...s, approver: { ...s.approver } })),
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

/** Statuses of a version that was approved: in effect, approved for later, or replaced since */
const ONCE_IN_EFFECT: readonly string[] = ['PUBLISHED', 'SUPERSEDED']

/**
 * The version a DOA version is compared with (FR-DOA-009 AC1, AC3). While it waits, comparisonBaselineId at this
 * moment: the version in effect just before it starts — the drafter's page, the send and the approval read the same
 * one, so the approver ticks the table the approval asks for. Once published, the version it replaced: in effect just
 * before it started (its start may have moved to the approval, BR-DOA-12).
 */
async function baselineOf(db: TenantDb, version: { readonly id: string; readonly status: string; readonly effectiveFrom: Date }, now: Date): Promise<DoaBaselineDto | null> {
  const at = ONCE_IN_EFFECT.includes(version.status) ? new Date(version.effectiveFrom.getTime() - 1) : now
  const id = await comparisonBaselineId(db, version, at)
  if (!id) return null
  const row = await db.doaVersion.findUniqueOrThrow({ where: { id }, select: { id: true, code: true, versionNo: true, status: true, effectiveFrom: true, effectiveTo: true } })
  const started = row.effectiveFrom.getTime() <= now.getTime()
  const ended = row.effectiveTo !== null && row.effectiveTo.getTime() <= now.getTime()
  const relation = row.status === 'PUBLISHED' && started && !ended ? 'IN_EFFECT' : started ? 'REPLACED' : 'NEXT'
  return { versionId: row.id, code: row.code, versionNo: row.versionNo, effectiveFrom: row.effectiveFrom, relation }
}

interface WithdrawableRow {
  readonly status: string
  readonly approvedAt: Date | null
  readonly publishedAt: Date | null
  readonly withdrawalRequestedAt: Date | null
  readonly withdrawalRequestedById: string | null
  readonly withdrawalReason: string | null
  readonly withdrawnAt: Date | null
}

/**
 * Whether a route of a version is its withdrawal's: made after the version was approved (its publishing route was made
 * before), and what the approver reads of it — who asked, when and why, kept while it waits and once it is withdrawn
 */
async function withdrawalOf(db: TenantDb, version: WithdrawableRow, routeId: string): Promise<WithdrawalTaskDto | null> {
  const approved = version.approvedAt ?? version.publishedAt
  if (!approved) return null
  const route = await db.approvalRoute.findUnique({ where: { id: routeId }, select: { createdAt: true } })
  if (!route || route.createdAt.getTime() <= approved.getTime()) return null
  const asked = (version.status === 'PUBLISHED' && version.withdrawalRequestedAt !== null) || version.status === 'WITHDRAWN'
  const by = asked && version.withdrawalRequestedById ? (await membersById(db, [version.withdrawalRequestedById])).get(version.withdrawalRequestedById) ?? null : null
  return { requestedBy: by, requestedAt: asked ? version.withdrawalRequestedAt : null, reason: asked ? version.withdrawalReason : null, withdrawnAt: version.status === 'WITHDRAWN' ? version.withdrawnAt : null }
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
  // What the approver publishes, and the version it is compared with (FR-DOA-002 AC2, FR-DOA-009 AC1, AC3)
  const baseline = await baselineOf(db, version, now)
  const [content, baselineContent] = await Promise.all([doaContentOf(db, version.id), baseline ? doaContentOf(db, baseline.versionId) : Promise.resolve(null)])
  const approvers = [...(content?.rules ?? []), ...(baselineContent?.rules ?? [])].flatMap((r) => r.steps.flatMap(stepApprovers))
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
    withdrawal: await withdrawalOf(db, version, routeId),
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
    baseline,
    baselineContent,
    positionNames: new Map(positionRows.map((p) => [p.code, { th: p.nameTh, en: p.nameEn }])),
    memberNames,
  }
}

// ---------- who decided it (FR-DOA-004 AC2, §9.3) ----------

/** What closingDecisionOf reads of a task: a row of ApprovalTask */
export interface DecidableTask {
  readonly id: string
  readonly stepId: string
  readonly status: string
  readonly decision: 'APPROVE' | 'RETURN' | 'REJECT' | null
  readonly decidedAt: Date | null
  readonly decidedByMemberId: string | null
}

/** The decision that closed a task */
export interface ClosingDecision {
  /** The task that was decided: the task itself, or the other task of its step whose decision closed it */
  readonly taskId: string
  readonly decision: 'APPROVE' | 'RETURN' | 'REJECT' | null
  readonly decidedAt: Date
  /** The decider's names as stored; null when their member row is gone */
  readonly decidedBy: { readonly id: string; readonly displayNameTh: string; readonly displayNameEn: string | null } | null
}

const DECIDABLE = { id: true, stepId: true, status: true, decision: true, decidedAt: true, decidedByMemberId: true } as const

/**
 * The decision that closed a task — the one rule of every answer "ดำเนินการแล้วโดย … เมื่อ …" (FR-DOA-004 AC2, §9.3,
 * ADR-050 item 4): the decision page, a late decision on the web or in LIFF, the LINE button and the e-mail link. Its
 * own decision; or, for a task cancelled or moved with nothing decided of its own — the other approver of an escalated
 * step decided first (BR-SLA-04, CO_ASSIGNEE_DECIDED), or the delegate it moved to decided it — the first decision on
 * its step. null: nothing was decided (the task is still open, waits for an answer, or closed with its route: the
 * request cancelled, the route replaced). Reads with the caller's client: a query's, or the transaction of a command
 * that holds the task's lock. Names come back only to callers that checked who may act on the task first.
 */
export async function closingDecisionOf(db: Pick<TenantTx, 'approvalTask' | 'member'>, task: DecidableTask): Promise<ClosingDecision | null> {
  const byStep = !task.decidedAt && (task.status === 'CANCELLED' || task.status === 'REASSIGNED')
  const decided = byStep
    ? await db.approvalTask.findFirst({ where: { stepId: task.stepId, decidedAt: { not: null } }, orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }], select: DECIDABLE })
    : task
  if (!decided?.decidedAt) return null
  const decidedBy = decided.decidedByMemberId ? await db.member.findUnique({ where: { id: decided.decidedByMemberId }, select: { id: true, displayNameTh: true, displayNameEn: true } }) : null
  return { taskId: decided.id, decision: decided.decision, decidedAt: decided.decidedAt, decidedBy }
}

const memberRefOf = (m: { readonly id: string; readonly displayNameTh: string; readonly displayNameEn: string | null }): MemberRefDto => ({ id: m.id, name: { th: m.displayNameTh, en: m.displayNameEn } })

/**
 * Who decided a task and when, in both languages (FR-DOA-004 AC2: a second decision is told who and when): the decision
 * that closed it (closingDecisionOf), so a task cancelled because the other approver of its step decided first names that
 * approver. The caller has checked that the reader may act on the task (the decision services refuse anyone else first).
 */
export async function taskDecision(ctx: Ctx, taskId: string): Promise<{ readonly decidedBy: MemberRefDto | null; readonly decidedAt: Date | null } | null> {
  if (!isUuid(taskId)) return null
  const db = forTenant(ctx.organizationId)
  const task = await db.approvalTask.findUnique({ where: { id: taskId }, select: DECIDABLE })
  if (!task) return null
  const decided = await closingDecisionOf(db, task)
  return { decidedBy: decided?.decidedBy ? memberRefOf(decided.decidedBy) : null, decidedAt: decided?.decidedAt ?? null }
}

const CANCELLED_WHY = ['REQUEST_CANCELLED', 'ROUTE_REPLACED', 'DOCUMENT_DECIDED', 'CO_ASSIGNEE_DECIDED'] as const

export async function getTaskView(ctx: Ctx, taskId: string): Promise<TaskViewDto | null> {
  if (!isUuid(taskId)) return null
  const db = forTenant(ctx.organizationId)
  const task = await db.approvalTask.findUnique({
    where: { id: taskId },
    include: {
      step: { select: { routeId: true, kind: true, route: { select: STEP_UP_ROUTE } } },
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
  // A task closed by another task of its step names that decision (its own decision has the fields above)
  const closing = await closingDecisionOf(db, task)
  const stepDecision = closing && closing.taskId !== task.id ? { decision: closing.decision, decidedBy: closing.decidedBy ? memberRefOf(closing.decidedBy) : null, decidedAt: closing.decidedAt } : null

  let policy: PolicySubjectDto | null = null
  let track: TrackEntryDto[] = []
  if (POLICY_SUBJECTS.includes(subjectType)) {
    policy = subjectType === 'DOA_VERSION' ? await doaVersionOf(db, ctx, subjectId, task.step.routeId, departments) : await orgChangeOf(db, subjectId, departments)
    const tasks = await db.approvalTask.findMany({ where: { step: { route: { subjectType, subjectId } } }, select: { id: true, resolvedFrom: true } })
    const events = await documentEvents(db, subjectType === 'DOA_VERSION' ? 'DoaVersion' : 'OrgAuthorityChange', subjectId, tasks.map((t) => t.id))
    track = await historyOf(db, events, new Map(tasks.map((t) => [t.id, t.resolvedFrom])), roleOf)
  }

  let workflow: WorkflowTaskDto | null = null
  if (subjectType === 'WORKFLOW_VERSION') {
    const v = await db.workflowVersion.findFirst({ where: { id: subjectId }, include: { _count: { select: { rules: true } } } })
    if (v) {
      const by = await membersById(db, [v.submittedById])
      workflow = {
        versionId: v.id,
        code: v.code,
        versionNo: v.versionNo,
        status: v.status,
        effectiveFrom: v.effectiveFrom,
        changeReason: v.changeReason,
        submittedBy: v.submittedById ? (by.get(v.submittedById) ?? null) : null,
        rules: v._count.rules,
        withdrawal: await withdrawalOf(db, v, task.step.routeId),
      }
    }
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
    stepDecision,
    openQuestion: task.status === 'INFO_REQUESTED' && unanswered ? { id: unanswered.id, question: unanswered.question, askedAt: unanswered.askedAt } : null,
    stepUp: stepUpOf(task.step),
    review: task.step.kind === 'REVIEW',
    route,
    policy,
    workflow,
    track,
  }
}

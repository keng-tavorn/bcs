import { z } from 'zod'
import type { RouteInput } from '@/core/doa'
import { err, ok, type Result } from '@/core/result'
import type { ApprovalSubject } from '@/core/sod'
import { backtestPolicy, backtestWorkflow, type BacktestDocument, type BacktestResult, type WorkflowBacktestDocument } from '@/core/workflow'
import { BACKTEST_SYNC_LIMIT, BACKTEST_TX_TIMEOUT_MS, BACKTEST_WINDOW_DAYS, COMMAND_TX_MAX_WAIT_MS, MS_PER_DAY } from '@/lib/constants'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadRoutePolicy } from '@/server/doa/policy'
import { routeInputOf } from '@/server/doa/route-inputs'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import { loadWorkflowVersions, requestReviewFacts } from '@/server/workflow/policy'
import { workflowVersionFromRows } from '@/server/workflow/snapshot'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { isRegisteredSubject } from '../approvals/subjects'
import { subjectFacts } from '../sla/subject'

// The 90-day backtest of a draft (S6-07 · FR-DOA-103 · BR-WF-13 · ADR-111): every document sent in the last 90 days is
// routed again with the real engine — by the version in effect when it was sent and by the draft as if in effect then
// (backtestPolicy, backtestWorkflow of src/core/workflow). A DOA draft tries every document the DOA routes (requests,
// purchase orders, variances and the phase-1 documents; not the policy changes themselves); a workflow draft tries the
// purchase requests. Each document counts once, by its latest sending in the window. Read by who may try the draft
// (admin.doa.simulate · admin.workflow.simulate) and by the approver of its DOA_CHANGE route, who sees it before
// deciding (BR-DOA-14). Up to BACKTEST_SYNC_LIMIT documents the answer comes at once; more, a BacktestRun is made and
// the job backtest-run fills it (FR-DOA-103 AC3). Nothing it does writes business data.

export type BacktestKind = 'DOA_VERSION' | 'WORKFLOW_VERSION'

/** What a document of a row is, for the screens */
export interface BacktestDocumentRef {
  readonly ref: string
  readonly subjectType: string
  readonly label: string
  readonly sentAt: string
}

export type BacktestView =
  | { readonly status: 'DONE'; readonly from: string; readonly to: string; readonly documentCount: number; readonly result: BacktestResult; readonly documents: readonly BacktestDocumentRef[] }
  | { readonly status: 'PENDING'; readonly runId: string; readonly documentCount: number }
  | { readonly status: 'FAILED'; readonly runId: string; readonly documentCount: number }

/** The kinds of document a DOA draft is tried with (the policy changes are not) */
const DOA_SUBJECTS: readonly ApprovalSubject[] = ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'BUDGET_TRANSFER', 'BUDGET_OVERRUN', 'INVOICE', 'PO_CHANGE', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE']
const CAPABILITY = { DOA_VERSION: 'admin.doa.simulate', WORKFLOW_VERSION: 'admin.workflow.simulate' } as const

/** The approver of the draft's DOA_CHANGE route, or whom a delegate holds the task for (BR-DOA-14) */
async function holdsTask(tx: TenantTx, ctx: Ctx, kind: BacktestKind, versionId: string): Promise<boolean> {
  if (ctx.actor.type !== 'USER') return false
  const me = ctx.actor.memberId
  return (await tx.approvalTask.count({ where: { OR: [{ assigneeMemberId: me }, { principalMemberId: me }], step: { route: { subjectType: kind, subjectId: versionId } } } })) > 0
}

interface Sent {
  readonly subjectType: string
  readonly subjectId: string
  /** When it was sent (its route input's time) */
  readonly createdAt: Date
  readonly amountSatang: bigint | null
}

/**
 * The documents sent in [at − 90 days, at), each once by its latest sending (BR-WF-13): requests and purchase orders by
 * their own submittedAt; the others by the time of their latest route
 */
async function sentInWindow(tx: TenantTx, kind: BacktestKind, at: Date): Promise<{ from: Date; routes: Sent[] }> {
  const from = new Date(at.getTime() - BACKTEST_WINDOW_DAYS * MS_PER_DAY)
  const window = { gte: from, lt: at }
  const requests = await tx.request.findMany({ where: { submittedAt: window, currentRouteId: { not: null } }, select: { id: true, submittedAt: true }, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }] })
  const sent: Sent[] = requests.map((r) => ({ subjectType: 'REQUEST', subjectId: r.id, createdAt: r.submittedAt!, amountSatang: null }))
  if (kind === 'WORKFLOW_VERSION') return { from, routes: sent }
  const pos = await tx.purchaseOrder.findMany({ where: { submittedAt: window, currentRouteId: { not: null } }, select: { id: true, submittedAt: true }, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }] })
  sent.push(...pos.map((p) => ({ subjectType: 'PURCHASE_ORDER', subjectId: p.id, createdAt: p.submittedAt!, amountSatang: null })))
  const routes = await tx.approvalRoute.findMany({
    where: { createdAt: window, subjectType: { in: DOA_SUBJECTS.filter((t) => t !== 'REQUEST' && t !== 'PURCHASE_ORDER') } },
    select: { subjectType: true, subjectId: true, createdAt: true, amountSatang: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const latest = new Map<string, Sent>()
  for (const r of routes) latest.set(`${r.subjectType}:${r.subjectId}`, r)
  return { from, routes: [...sent, ...latest.values()] }
}

/** The route input of a document as it was sent: read from the document, else from its subject's facts and the route's amount */
async function inputOf(tx: TenantTx, r: Sent): Promise<RouteInput | null> {
  const own = await routeInputOf(tx, r.subjectType, r.subjectId, r.createdAt)
  if (own) return own
  // A request, purchase order or variance that cannot be read again is left out; the phase-1 documents read their facts
  if (!isRegisteredSubject(r.subjectType)) return null
  const facts = await subjectFacts(tx, r.subjectType as ApprovalSubject, r.subjectId)
  if (!facts.ownerMemberId || !facts.chargedDepartmentId) return null
  return {
    documentType: facts.documentType,
    ...(r.amountSatang !== null ? { amount: { netSatang: r.amountSatang, vatSatang: 0n } } : {}),
    requesterMemberId: facts.ownerMemberId,
    chargedDepartmentId: facts.chargedDepartmentId,
    conflictMemberIds: [...facts.conflictMemberIds],
    at: r.createdAt,
  }
}

async function labelOf(tx: TenantTx, r: { subjectType: string; subjectId: string }): Promise<string> {
  if (r.subjectType === 'REQUEST') {
    const q = await tx.request.findFirst({ where: { id: r.subjectId }, select: { number: true, title: true } })
    return q ? `${q.number ?? ''} ${q.title}`.trim() : r.subjectId
  }
  const facts = await subjectFacts(tx, r.subjectType as ApprovalSubject, r.subjectId)
  return facts.number ?? facts.title ?? r.subjectId
}

/** Routes every document of the window again; the result and what each row is */
async function compute(tx: TenantTx, kind: BacktestKind, versionId: string, at: Date) {
  const { from, routes } = await sentInWindow(tx, kind, at)
  const policy = await loadRoutePolicy(tx)
  const documents: BacktestDocumentRef[] = []
  let result: BacktestResult
  if (kind === 'DOA_VERSION') {
    const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: versionId }, include: { rules: true } })
    const docs: BacktestDocument[] = []
    for (const r of routes) {
      const route = await inputOf(tx, r)
      if (!route) continue
      docs.push({ ref: r.subjectId, route })
      documents.push({ ref: r.subjectId, subjectType: r.subjectType, label: await labelOf(tx, r), sentAt: r.createdAt.toISOString() })
    }
    result = backtestPolicy(docs, policy, versionSnapshotFromRows(version, version.rules))
  } else {
    const version = await tx.workflowVersion.findUniqueOrThrow({ where: { id: versionId }, include: { rules: true } })
    const docs: WorkflowBacktestDocument[] = []
    for (const r of routes) {
      const route = await routeInputOf(tx, r.subjectType, r.subjectId, r.createdAt)
      const request = await tx.request.findFirst({ where: { id: r.subjectId }, include: { requestType: { select: { code: true } }, lines: { select: { categoryCode: true, budgetLineId: true } } } })
      if (!route || !request) continue
      const review = await requestReviewFacts(tx, { requestTypeCode: request.requestType.code, grossSatang: request.grossSatang, netSatang: request.netSatang, formData: request.formData, budgetLineId: request.budgetLineId, lines: request.lines })
      docs.push({ ref: r.subjectId, route, review })
      documents.push({ ref: r.subjectId, subjectType: r.subjectType, label: `${request.number ?? ''} ${request.title}`.trim(), sentAt: r.createdAt.toISOString() })
    }
    result = backtestWorkflow(docs, { ...policy, workflows: await loadWorkflowVersions(tx) }, workflowVersionFromRows(version, version.rules))
  }
  return { from, result, documents }
}

const RunInput = z.strictObject({ kind: z.enum(['DOA_VERSION', 'WORKFLOW_VERSION']), versionId: z.uuid() })

/** Reads only, so it may take longer than a command (COMMAND_TX_TIMEOUT_MS): up to BACKTEST_SYNC_LIMIT documents */
const readOnly = <T,>(ctx: Ctx, run: (tx: TenantTx) => Promise<T>) => forTenant(ctx.organizationId).$transaction(run, { maxWait: COMMAND_TX_MAX_WAIT_MS, timeout: BACKTEST_TX_TIMEOUT_MS })

/** Who may try the draft: its kind's try-out capability, or its approver (BR-DOA-14) */
async function mayTry(tx: TenantTx, ctx: Ctx, kind: BacktestKind, versionId: string) {
  const allowed = await authorize(tx, ctx, CAPABILITY[kind])
  return allowed.ok || (await holdsTask(tx, ctx, kind, versionId)) ? null : allowed
}

/** A run for the job backtest-run, when the window holds more documents than a page waits for (FR-DOA-103 AC3) */
export const requestBacktestRunCommand = defineCommand({
  name: 'backtest.request',
  capability: 'admin.doa.simulate',
  input: RunInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ runId: string; documentCount: number }>> {
    const refused = await mayTry(tx, ctx, input.kind, input.versionId)
    if (refused && !refused.ok) return { ok: false, error: refused.error }
    const requestedById = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!requestedById) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member asks for a backtest' } }
    const { routes } = await sentInWindow(tx, input.kind, ctx.now)
    const run = await tx.backtestRun.create({ data: { organizationId: ctx.organizationId, subjectType: input.kind, subjectId: input.versionId, documentCount: routes.length, requestedById }, select: { id: true } })
    return {
      ok: true,
      result: { runId: run.id, documentCount: routes.length },
      events: [{ type: 'backtest.requested', aggregateType: 'BacktestRun', aggregateId: run.id, data: { subjectType: input.kind, subjectId: input.versionId, documentCount: routes.length } }],
    }
  },
})

/**
 * Tries the draft: the answer at once up to BACKTEST_SYNC_LIMIT documents (it reads only); past that a run the job
 * fills (backtest.requested), read again with getBacktestRun.
 */
export async function backtestDraft(ctx: Ctx, input: z.input<typeof RunInput>, options: RunOptions): Promise<Result<BacktestView>> {
  const parsed = RunInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'kind and versionId are needed', { field: parsed.error.issues[0]?.path.join('.') ?? '' })
  const { kind, versionId } = parsed.data
  const first = await readOnly(ctx, async (tx) => {
    const refused = await mayTry(tx, ctx, kind, versionId)
    if (refused) return refused
    const exists = kind === 'DOA_VERSION' ? await tx.doaVersion.count({ where: { id: versionId } }) : await tx.workflowVersion.count({ where: { id: versionId } })
    if (!exists) return err('NOT_FOUND', 'version not found')
    const { routes } = await sentInWindow(tx, kind, ctx.now)
    if (routes.length > BACKTEST_SYNC_LIMIT) return ok({ later: true as const })
    const { from, result, documents } = await compute(tx, kind, versionId, ctx.now)
    return ok({ later: false as const, view: { status: 'DONE' as const, from: from.toISOString(), to: ctx.now.toISOString(), documentCount: result.summary.total, result, documents } })
  })
  if (!first.ok) return first
  if (!first.data.later) return ok(first.data.view)
  const asked = await runCommand(ctx, requestBacktestRunCommand, parsed.data, options)
  return asked.ok ? ok({ status: 'PENDING', runId: asked.data.runId, documentCount: asked.data.documentCount }) : asked
}

const CompleteInput = z.strictObject({ runId: z.uuid(), status: z.enum(['DONE', 'FAILED']), result: z.unknown(), error: z.string().max(200).nullable() })

/** The job writes what it computed: the run DONE with its result, or FAILED */
export const completeBacktestRunCommand = defineCommand({
  name: 'backtest.complete',
  capability: 'admin.doa.simulate',
  input: CompleteInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ status: string }>> {
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'only the job completes a backtest' } }
    const run = await tx.backtestRun.findFirst({ where: { id: input.runId } })
    if (!run) return { ok: false, error: { code: 'NOT_FOUND', message: 'backtest run not found' } }
    if (run.status !== 'PENDING') return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'the run is done already', details: { from: run.status } } }
    const done = input.status === 'DONE'
    await tx.backtestRun.update({ where: { id: run.id }, data: { status: input.status, ...(done ? { result: input.result as object } : { error: input.error }), completedAt: ctx.now } })
    const changed = done ? ((input.result as { result?: { summary?: { changed?: number } } }).result?.summary?.changed ?? null) : null
    return {
      ok: true,
      result: { status: input.status },
      events: [{ type: 'backtest.completed', aggregateType: 'BacktestRun', aggregateId: run.id, data: { subjectType: run.subjectType, subjectId: run.subjectId, documentCount: run.documentCount, status: input.status, changed } }],
    }
  },
})

/** The job backtest-run: computes a PENDING run (reading only, the window ending when it was asked for), then writes it */
export async function completeBacktestRun(organizationId: string, runId: string, now: Date): Promise<{ readonly status: string }> {
  const ctx = systemCtx(organizationId, now, 'backtest-run')
  const run = await forTenant(organizationId).backtestRun.findFirst({ where: { id: runId } })
  if (!run || run.status !== 'PENDING') return { status: run?.status ?? 'NOT_FOUND' }
  let input: z.input<typeof CompleteInput>
  try {
    const { from, result, documents } = await readOnly(ctx, (tx) => compute(tx, run.subjectType as BacktestKind, run.subjectId, run.createdAt))
    input = { runId, status: 'DONE', result: { from: from.toISOString(), to: run.createdAt.toISOString(), result, documents }, error: null }
  } catch (error) {
    input = { runId, status: 'FAILED', result: null, error: (error as Error).name || 'Error' }
  }
  const written = await runCommand(ctx, completeBacktestRunCommand, input, { idempotencyKey: `backtest-run:${runId}` })
  return { status: written.ok ? written.data.status : written.error.code }
}

/** A run as the page reads it again (the same rights as asking for it) */
export async function getBacktestRun(ctx: Ctx, runId: string): Promise<BacktestView | null> {
  if (!z.uuid().safeParse(runId).success) return null
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const run = await tx.backtestRun.findFirst({ where: { id: runId } })
    if (!run) return null
    const kind = run.subjectType as BacktestKind
    if (await mayTry(tx, ctx, kind, run.subjectId)) return null
    if (run.status === 'PENDING' || run.status === 'FAILED') return { status: run.status, runId: run.id, documentCount: run.documentCount }
    const stored = run.result as unknown as { from: string; to: string; result: BacktestResult; documents: BacktestDocumentRef[] }
    return { status: 'DONE', from: stored.from, to: stored.to, documentCount: run.documentCount, result: stored.result, documents: stored.documents }
  })
}

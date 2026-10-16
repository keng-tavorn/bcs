import { toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { authorize, isAllowed, loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { requestViewScope } from '../requests/view-scope'
import { overrunNeed } from './overruns'

// Over-budget approvals as their screens show them (S6-16 · FR-BUD-101 · §9.1 /budgets/overruns/[id]): on a request,
// what its line is short of and whether its requester may ask now (the button shows only when they may: their own draft
// or returned request, a line short of budget, an OVER_BUDGET rule in effect, nothing asked already), with the overruns
// asked for it; and one overrun with what it funded, used and gave back. Read only; the commands are in ./overruns.ts.

export interface OverrunDto {
  readonly id: string
  readonly number: string
  readonly status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED' | 'CONSUMED' | 'LAPSED'
  readonly request: { readonly id: string; readonly number: string | null; readonly title: string }
  readonly budgetLine: { readonly id: string; readonly code: string; readonly nameTh: string }
  /** M: what the request needed on the line when it asked */
  readonly requestNet: MoneyDto
  /** X: the shortfall asked and, once approved, funded */
  readonly shortfall: MoneyDto
  readonly used: MoneyDto
  readonly returned: MoneyDto
  readonly returnedAfterUse: MoneyDto
  readonly reason: string
  readonly submittedBy: { readonly id: string; readonly nameTh: string }
  readonly submittedAt: string
  readonly approvedAt: string | null
  readonly lapsesAt: string | null
  readonly consumedAt: string | null
  /** The open task of its route, for its approver */
  readonly openTaskId: string | null
  /** The reader asked for it: they may cancel it while it waits or before it is used */
  readonly mine: boolean
}

export interface OverrunOfferDto {
  /** The requester may ask now: the button shows */
  readonly canAsk: boolean
  /** The line and what is missing on it, for the requester (null for any other reader, or when the line has enough) */
  readonly line: { readonly code: string; readonly nameTh: string } | null
  readonly need: MoneyDto | null
  readonly available: MoneyDto | null
  readonly shortfall: MoneyDto | null
  /** The DOA in effect has an OVER_BUDGET rule; without it the button never shows (DOA_NOT_CONFIGURED) */
  readonly ruleInEffect: boolean
  /** Every overrun asked for the request, newest first */
  readonly overruns: readonly OverrunDto[]
}

const SELECT = {
  id: true,
  number: true,
  status: true,
  requestNetSatang: true,
  shortfallSatang: true,
  usedSatang: true,
  returnedSatang: true,
  returnedAfterUseSatang: true,
  reason: true,
  submittedAt: true,
  approvedAt: true,
  lapsesAt: true,
  consumedAt: true,
  submittedById: true,
  currentRouteId: true,
  submittedBy: { select: { id: true, displayNameTh: true } },
  request: { select: { id: true, number: true, title: true } },
  budgetLine: { select: { id: true, code: true, nameTh: true, departmentId: true } },
} as const

type Row = NonNullable<Awaited<ReturnType<typeof rowOf>>>
const rowOf = (tx: TenantTx, id: string) => tx.budgetOverrun.findFirst({ where: { id }, select: SELECT })

async function dtoOf(tx: TenantTx, row: Row, memberId: string | null): Promise<OverrunDto> {
  const task = row.currentRouteId ? await tx.approvalTask.findFirst({ where: { status: 'OPEN', step: { routeId: row.currentRouteId } }, select: { id: true } }) : null
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    request: { id: row.request.id, number: row.request.number, title: row.request.title },
    budgetLine: { id: row.budgetLine.id, code: row.budgetLine.code, nameTh: row.budgetLine.nameTh },
    requestNet: toMoneyDto(row.requestNetSatang),
    shortfall: toMoneyDto(row.shortfallSatang),
    used: toMoneyDto(row.usedSatang),
    returned: toMoneyDto(row.returnedSatang),
    returnedAfterUse: toMoneyDto(row.returnedAfterUseSatang),
    reason: row.reason,
    submittedBy: { id: row.submittedBy.id, nameTh: row.submittedBy.displayNameTh },
    submittedAt: row.submittedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    lapsesAt: row.lapsesAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    openTaskId: task?.id ?? null,
    mine: memberId === row.submittedById,
  }
}

/** May read it: who asked; who reads every budget or the budget of the line's department; who has or had a task on it */
async function mayRead(tx: TenantTx, principal: Principal, row: Row): Promise<boolean> {
  if (principal.kind !== 'member') return false
  if (principal.memberId === row.submittedById) return true
  if (scopesFor(principal, 'budget.view').has('ORG')) return true
  if (isAllowed(principal, 'budget.view', { departmentId: row.budgetLine.departmentId })) return true
  const tasks = await tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'BUDGET_OVERRUN', subjectId: row.id } } }, select: { assigneeMemberId: true, principalMemberId: true } })
  return isAllowed(principal, 'budget.view', { assigneeMemberIds: tasks.flatMap((t) => [t.assigneeMemberId, ...(t.principalMemberId ? [t.principalMemberId] : [])]) })
}

const memberOf = (ctx: Ctx) => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

export async function getBudgetOverrun(ctx: Ctx, id: string): Promise<Result<OverrunDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const row = await rowOf(tx, id)
    if (!row) return err('NOT_FOUND', 'over-budget approval not found')
    const principal = await loadPrincipal(tx, ctx)
    if (!(await mayRead(tx, principal, row))) return err('FORBIDDEN', 'not a reader of this over-budget approval', { capability: 'budget.view' })
    return ok(await dtoOf(tx, row, memberOf(ctx)))
  })
}

/** The over-budget side of a request page: whoever may read the request sees its overruns; its requester may ask */
export async function getRequestOverruns(ctx: Ctx, requestId: string): Promise<Result<OverrunOfferDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const scope = await requestViewScope(tx, requestId)
    if (!scope) return err('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.view', scope)
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const rows = await tx.budgetOverrun.findMany({ where: { requestId }, orderBy: { submittedAt: 'desc' }, select: SELECT })
    const member = memberOf(ctx)
    const overruns = await Promise.all(rows.map((r) => dtoOf(tx, r, member)))
    const ruleInEffect = await overBudgetRuleInEffect(tx, ctx.now)
    const none = { canAsk: false, line: null, need: null, available: null, shortfall: null, ruleInEffect, overruns }
    const request = await tx.request.findUniqueOrThrow({ where: { id: requestId }, select: { requesterMemberId: true } })
    // The requester only (budget.overrun.submit OWN); the amounts are of the line they chose (budget.view SELECTED_LINE_ONLY)
    if (member !== request.requesterMemberId || !isAllowed(allowed.data, 'budget.overrun.submit', { ownerMemberIds: [request.requesterMemberId] })) return ok(none)
    const needed = await overrunNeed(tx, ctx, requestId)
    if (!needed.ok) return ok(none)
    const { line, needSatang, availableSatang } = needed.need
    const shortfall = needSatang - availableSatang
    const live = rows.some((r) => r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED')
    return ok({
      ...none,
      canAsk: ruleInEffect && shortfall > 0n && !live,
      line: { code: line.code, nameTh: line.nameTh },
      need: toMoneyDto(needSatang),
      available: toMoneyDto(availableSatang),
      shortfall: shortfall > 0n ? toMoneyDto(shortfall) : null,
    })
  })
}

/** The DOA version in effect has an OVER_BUDGET rule */
async function overBudgetRuleInEffect(tx: TenantTx, now: Date): Promise<boolean> {
  const version = await tx.doaVersion.findFirst({
    where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { rules: { where: { documentType: 'OVER_BUDGET' }, select: { id: true } } },
  })
  return (version?.rules.length ?? 0) > 0
}

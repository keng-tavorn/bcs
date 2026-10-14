import { toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { authorize, isAllowed, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { budgetLowThreshold, chooseFiscalYear } from './dashboard'

// Budget transfers as their screens show them (S6-15 · FR-BUD-103 · §9.1 /budgets/transfers): the form's choice of
// lines for who may send one (budget.transfer.submit: BUDGET_ADMIN every line; a department head gives from the lines of
// the departments they head and gives to any line of the year), the list (who reads every budget, the heads of the
// departments a transfer concerns, its sender), and one transfer (also its approvers: budget.view ASSIGNED). Read only;
// the commands are in ./transfers.ts. Money as MoneyDto.

export interface TransferLineChoiceDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly departmentId: string
  readonly departmentCode: string
  readonly available: MoneyDto
  /** The member may give from this line (TRANSFER, DECREASE) */
  readonly canGive: boolean
  /** The member may raise this line alone (INCREASE): BUDGET_ADMIN, or its department's head */
  readonly canIncrease: boolean
}

export interface TransferFormDto {
  readonly fiscalYear: { readonly id: string; readonly code: string } | null
  readonly lines: readonly TransferLineChoiceDto[]
  /** The DOA in effect has a BUDGET_TRANSFER rule; without it a transfer can only be refused (FR-BUD-103 AC4) */
  readonly ruleInEffect: boolean
}

export interface TransferDto {
  readonly id: string
  readonly number: string | null
  readonly kind: 'TRANSFER' | 'INCREASE' | 'DECREASE'
  readonly status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED'
  readonly amount: MoneyDto
  readonly reason: string
  readonly from: { readonly id: string; readonly code: string; readonly nameTh: string } | null
  readonly to: { readonly id: string; readonly code: string; readonly nameTh: string } | null
  readonly submittedBy: { readonly id: string; readonly nameTh: string }
  readonly submittedAt: string | null
  readonly decidedAt: string | null
  /** The open task of its route, for the approver's link */
  readonly openTaskId: string | null
  /** The reader is its sender: they may send it (DRAFT, RETURNED) or cancel it (DRAFT, RETURNED, PENDING_APPROVAL) */
  readonly mine: boolean
}

const SELECT = {
  id: true,
  number: true,
  kind: true,
  status: true,
  amountSatang: true,
  reason: true,
  submittedAt: true,
  decidedAt: true,
  submittedById: true,
  currentRouteId: true,
  submittedBy: { select: { id: true, displayNameTh: true } },
  fromBudgetLine: { select: { id: true, code: true, nameTh: true, departmentId: true } },
  toBudgetLine: { select: { id: true, code: true, nameTh: true, departmentId: true } },
} as const

type Row = Awaited<ReturnType<typeof rowOf>>
const rowOf = (tx: TenantTx, id: string) => tx.budgetTransfer.findFirst({ where: { id }, select: SELECT })

async function dtoOf(tx: TenantTx, row: NonNullable<Row>, memberId: string | null): Promise<TransferDto> {
  const task = row.currentRouteId ? await tx.approvalTask.findFirst({ where: { status: 'OPEN', step: { routeId: row.currentRouteId } }, select: { id: true } }) : null
  const line = (l: { id: string; code: string; nameTh: string } | null) => (l ? { id: l.id, code: l.code, nameTh: l.nameTh } : null)
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    status: row.status,
    amount: toMoneyDto(row.amountSatang),
    reason: row.reason,
    from: line(row.fromBudgetLine),
    to: line(row.toBudgetLine),
    submittedBy: { id: row.submittedBy.id, nameTh: row.submittedBy.displayNameTh },
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    openTaskId: task?.id ?? null,
    mine: memberId === row.submittedById,
  }
}

/** The departments a transfer concerns: the line it gives from and the line it gives to */
const departmentsOf = (row: NonNullable<Row>) => [row.fromBudgetLine?.departmentId, row.toBudgetLine?.departmentId].filter((d): d is string => Boolean(d))

/** May read it: its sender; who reads every budget; a head of a department it concerns; who has or had a task on it */
async function mayRead(tx: TenantTx, principal: Principal, row: NonNullable<Row>): Promise<boolean> {
  if (principal.kind !== 'member') return false
  if (principal.memberId === row.submittedById) return true
  if (scopesFor(principal, 'budget.view').has('ORG')) return true
  if (departmentsOf(row).some((d) => isAllowed(principal, 'budget.view', { departmentId: d }))) return true
  const assignees = await tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'BUDGET_TRANSFER', subjectId: row.id } } }, select: { assigneeMemberId: true, principalMemberId: true } })
  return isAllowed(principal, 'budget.view', { assigneeMemberIds: assignees.flatMap((a) => [a.assigneeMemberId, ...(a.principalMemberId ? [a.principalMemberId] : [])]) })
}

export async function getBudgetTransfer(ctx: Ctx, id: string): Promise<Result<TransferDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await authorize(tx, ctx, 'budget.view')
    const row = await rowOf(tx, id)
    if (!row) return err('NOT_FOUND', 'budget transfer not found')
    const reader = principal.ok ? principal.data : null
    // The sender may not hold budget.view at all (a department head of a line with no rights left still sees their own)
    const self = ctx.actor.type === 'USER' && ctx.actor.memberId === row.submittedById
    if (!self && !(reader && (await mayRead(tx, reader, row)))) return err('FORBIDDEN', 'not a reader of this budget transfer', { capability: 'budget.view' })
    return ok(await dtoOf(tx, row, ctx.actor.type === 'USER' ? ctx.actor.memberId : null))
  })
}

/** /budgets/transfers: the transfers the member may read, newest first (at most 200) */
export async function listBudgetTransfers(ctx: Ctx): Promise<Result<TransferDto[]>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!memberId) return err('FORBIDDEN', 'only a member reads budget transfers')
    const allowed = await authorize(tx, ctx, 'budget.view')
    const sendable = await authorize(tx, ctx, 'budget.transfer.submit')
    if (!allowed.ok && !sendable.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const principal = allowed.ok ? allowed.data : sendable.ok ? sendable.data : null
    const rows = await tx.budgetTransfer.findMany({ orderBy: { createdAt: 'desc' }, take: 200, select: SELECT })
    const out: TransferDto[] = []
    for (const row of rows) if (row.submittedById === memberId || (principal && (await mayRead(tx, principal, row)))) out.push(await dtoOf(tx, row, memberId))
    return ok(out)
  })
}

/** The form of a new transfer: the lines of the fiscal year in use, what the member may do with each */
export async function getTransferForm(ctx: Ctx): Promise<Result<TransferFormDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.transfer.submit')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const principal = allowed.data
    const { timezone } = await budgetLowThreshold(tx, ctx.organizationId)
    const chosen = await chooseFiscalYear(tx, ctx.now, timezone)
    if (!chosen.ok) return chosen
    const year = chosen.data.year
    const lines = year
      ? await tx.budgetLine.findMany({
          where: { fiscalYearId: year.id, status: 'OPEN' },
          orderBy: { code: 'asc' },
          select: { id: true, code: true, nameTh: true, departmentId: true, department: { select: { code: true } }, balance: { select: { availableSatang: true } } },
        })
      : []
    const version = await tx.doaVersion.findFirst({
      where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: ctx.now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: ctx.now } }] },
      orderBy: { effectiveFrom: 'desc' },
      select: { rules: { where: { documentType: 'BUDGET_TRANSFER' }, select: { id: true } } },
    })
    return ok({
      fiscalYear: year ? { id: year.id, code: year.code } : null,
      ruleInEffect: (version?.rules.length ?? 0) > 0,
      lines: lines.map((l) => {
        const own = isAllowed(principal, 'budget.transfer.submit', { departmentId: l.departmentId })
        return { id: l.id, code: l.code, nameTh: l.nameTh, departmentId: l.departmentId, departmentCode: l.department.code, available: toMoneyDto(l.balance?.availableSatang ?? 0n), canGive: own, canIncrease: own }
      }),
    })
  })
}

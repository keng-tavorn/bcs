import { TZDate } from '@date-fns/tz'
import { BP_PER_WHOLE } from '@/core/money/constants'
import { toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { authorize, isAllowed, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { reportTx } from '../reports/tx'
import { burnContext, burnOf, type BurnDto } from './burn'

// The budget dashboard (spec §11.2, FR-BUD-005 AC1 AC3): per budget line, per department and in all, the planned
// amount and the four buckets of the ledger (§7.7) — available, reserved, committed and actual — with the share used
// ((committed + actual) ÷ planned) and the share held ((reserved + committed + actual) ÷ planned), and a warning when
// what is available falls below digest.budgetLowPct of the planned amount. The amounts come from the balance projection
// the ledger updates in the same transaction (INV-BUD-05), so the page is never behind the ledger (AC3). Who sees what
// follows budget.view: FINANCE BUDGET_ADMIN EXECUTIVE AUDITOR the whole organization, a department head the lines of
// the departments they head; a requester's grant covers the line chosen in their own form only (SELECTED_LINE_ONLY),
// never this page. The drill-down to documents (AC2) is line-detail.ts (one line) and scope-detail.ts (a department, or
// everything shown), both built by documents.ts; the Excel export of what is shown, export.ts.

const PERCENT_TO_BP = 100

export interface BudgetFiguresDto {
  readonly planned: MoneyDto
  readonly available: MoneyDto
  readonly reserved: MoneyDto
  readonly committed: MoneyDto
  readonly actual: MoneyDto
  /** (committed + actual) ÷ planned in basis points, half up; null when nothing is planned */
  readonly usedBp: number | null
  /** (reserved + committed + actual) ÷ planned in basis points, half up; null when nothing is planned */
  readonly heldBp: number | null
  /**
   * available ÷ planned in basis points, rounded down (the share left the low warning speaks of): a line below the
   * warning never reads as being at it; null when nothing is planned
   */
  readonly availableBp: number | null
  /** What is available is below digest.budgetLowPct of the planned amount */
  readonly low: boolean
}

/**
 * S6-15 (FR-BUD-103 AC3 · BR-BUD-09): how the line came to its planned amount, from its ledger — the imports, the
 * transfers in and out, the increases and decreases, and what over-budget approvals funded and kept (S6-16 · BR-BUD-13 to
 * BR-BUD-15, BR-BUD-18); planned = initial + transferredIn − transferredOut + increased − decreased + overrun
 */
export interface BudgetLineChangesDto {
  readonly initial: MoneyDto
  readonly transferredIn: MoneyDto
  readonly transferredOut: MoneyDto
  readonly increased: MoneyDto
  readonly decreased: MoneyDto
  /** Funded by over-budget approvals less what went back out (used − returned after use, and earmarks still held) */
  readonly overrun: MoneyDto
}

export interface BudgetDashboardLineDto extends BudgetFiguresDto {
  readonly changes: BudgetLineChangesDto
  /** S6-18 (BR-BUD-17): use of the current budget, the year's forecast and the alerts reached */
  readonly burn: BurnDto
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly status: 'OPEN' | 'FROZEN' | 'CLOSED'
  readonly departmentId: string
  readonly costCenterCode: string
}

export interface BudgetDashboardDepartmentDto extends BudgetFiguresDto {
  readonly burn: BurnDto
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export interface BudgetDashboardDto {
  /** The fiscal year shown: the one asked for, else the one today falls in, else the latest */
  readonly fiscalYear: { readonly id: string; readonly code: string; readonly startsOn: string; readonly endsOn: string } | null
  readonly fiscalYears: ReadonlyArray<{ readonly id: string; readonly code: string }>
  /** ORG: the whole organization · DEPT: the departments the member heads */
  readonly scope: 'ORG' | 'DEPT'
  readonly lowPct: number
  readonly lines: readonly BudgetDashboardLineDto[]
  readonly departments: readonly BudgetDashboardDepartmentDto[]
  /** Every line shown, added up: the whole organization when the scope is ORG */
  readonly total: BudgetFiguresDto & { readonly burn: BurnDto }
  /** The instant the figures were read (ISO): the page says how fresh they are (AC3) */
  readonly asOf: string
  /** What the member may also open from here (budget.import, budgetGrant.manage); the services check again */
  readonly can: { readonly import: boolean; readonly manageGrants: boolean; readonly transfer: boolean }
}

export interface BudgetAmounts {
  readonly planned: bigint
  readonly available: bigint
  readonly reserved: bigint
  readonly committed: bigint
  readonly actual: bigint
}

export const NO_AMOUNTS: BudgetAmounts = { planned: 0n, available: 0n, reserved: 0n, committed: 0n, actual: 0n }

export const addAmounts = (a: BudgetAmounts, b: BudgetAmounts): BudgetAmounts => ({
  planned: a.planned + b.planned,
  available: a.available + b.available,
  reserved: a.reserved + b.reserved,
  committed: a.committed + b.committed,
  actual: a.actual + b.actual,
})

/** What a budget line selects to be added up: its planned amount and its balance (the ledger's buckets) */
export const BUDGET_LINE_AMOUNTS = {
  plannedSatang: true,
  balance: { select: { availableSatang: true, reservedSatang: true, committedSatang: true, actualSatang: true } },
} as const

/** The amounts of a budget line as its row and its balance hold them */
export function lineAmounts(l: {
  readonly plannedSatang: bigint
  readonly balance: { readonly availableSatang: bigint; readonly reservedSatang: bigint; readonly committedSatang: bigint; readonly actualSatang: bigint } | null
}): BudgetAmounts {
  return {
    planned: l.plannedSatang,
    available: l.balance?.availableSatang ?? 0n,
    reserved: l.balance?.reservedSatang ?? 0n,
    committed: l.balance?.committedSatang ?? 0n,
    actual: l.balance?.actualSatang ?? 0n,
  }
}

/** part ÷ whole in basis points, half up (neither is ever negative); null when nothing is planned */
function basisPoints(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null
  return Number((part * BP_PER_WHOLE * 2n + whole) / (whole * 2n))
}

/** part ÷ whole in basis points, rounded down; null when nothing is planned */
function basisPointsDown(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null
  return Number((part * BP_PER_WHOLE) / whole)
}

/** The figures of some amounts: money as DTOs, the shares in basis points, and the low warning against `lowBp` */
export function budgetFigures(a: BudgetAmounts, lowBp: bigint): BudgetFiguresDto {
  return {
    planned: toMoneyDto(a.planned),
    available: toMoneyDto(a.available),
    reserved: toMoneyDto(a.reserved),
    committed: toMoneyDto(a.committed),
    actual: toMoneyDto(a.actual),
    usedBp: basisPoints(a.committed + a.actual, a.planned),
    heldBp: basisPoints(a.reserved + a.committed + a.actual, a.planned),
    availableBp: basisPointsDown(a.available, a.planned),
    low: a.planned > 0n && a.available * BP_PER_WHOLE < a.planned * lowBp,
  }
}

/** The calendar day of an instant in the organization's time zone, as a DATE column stores it (midnight UTC) */
function dayIn(at: Date, timezone: string): Date {
  const local = new TZDate(at.getTime(), timezone)
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()))
}

export const dateText = (day: Date) => day.toISOString().slice(0, 10)

const zero = toMoneyDto(0n)
const NO_CHANGES: BudgetLineChangesDto = { initial: zero, transferredIn: zero, transferredOut: zero, increased: zero, decreased: zero, overrun: zero }

/** BR-BUD-09: what crossed each line's edge, by why — from the ledger rows that leave or enter OUTSIDE */
async function lineChanges(tx: TenantTx, lineIds: readonly string[]): Promise<Map<string, BudgetLineChangesDto>> {
  if (lineIds.length === 0) return new Map()
  const rows = await tx.budgetLedgerEntry.groupBy({
    by: ['budgetLineId', 'sourceType', 'sourceId', 'fromBucket'],
    where: { budgetLineId: { in: [...lineIds] }, OR: [{ fromBucket: 'OUTSIDE' }, { toBucket: 'OUTSIDE' }] },
    _sum: { amountSatang: true },
  })
  const transferIds = [...new Set(rows.filter((r) => r.sourceType === 'BUDGET_TRANSFER').map((r) => r.sourceId))]
  const kinds = new Map((await tx.budgetTransfer.findMany({ where: { id: { in: transferIds } }, select: { id: true, kind: true } })).map((t) => [t.id, t.kind]))
  const sums = new Map<string, { initial: bigint; transferredIn: bigint; transferredOut: bigint; increased: bigint; decreased: bigint; overrun: bigint }>()
  for (const r of rows) {
    const s = sums.get(r.budgetLineId) ?? { initial: 0n, transferredIn: 0n, transferredOut: 0n, increased: 0n, decreased: 0n, overrun: 0n }
    const amount = r._sum.amountSatang ?? 0n
    const into = r.fromBucket === 'OUTSIDE'
    if (r.sourceType === 'IMPORT') s.initial += amount
    else if (r.sourceType === 'BUDGET_OVERRUN') s.overrun += into ? amount : -amount
    else if (r.sourceType === 'BUDGET_TRANSFER') {
      const kind = kinds.get(r.sourceId)
      if (kind === 'TRANSFER' && into) s.transferredIn += amount
      else if (kind === 'TRANSFER') s.transferredOut += amount
      else if (into) s.increased += amount
      else s.decreased += amount
    }
    sums.set(r.budgetLineId, s)
  }
  return new Map([...sums].map(([id, s]) => [id, { initial: toMoneyDto(s.initial), transferredIn: toMoneyDto(s.transferredIn), transferredOut: toMoneyDto(s.transferredOut), increased: toMoneyDto(s.increased), decreased: toMoneyDto(s.decreased), overrun: toMoneyDto(s.overrun) }]))
}

/** The DOA version in effect has a BUDGET_TRANSFER rule (FR-BUD-103 AC4) */
async function hasTransferRule(tx: TenantTx, now: Date): Promise<boolean> {
  const version = await tx.doaVersion.findFirst({
    where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { rules: { where: { documentType: 'BUDGET_TRANSFER' }, select: { id: true } } },
  })
  return (version?.rules.length ?? 0) > 0
}

/**
 * The low warning of the organization (digest.budgetLowPct, percent), the same in basis points, and the organization's
 * time zone (the Organization.timezone column, which the grants, delegations and holidays use too).
 */
export async function budgetLowThreshold(tx: TenantTx, organizationId: string): Promise<{ lowPct: number; lowBp: bigint; timezone: string }> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true, timezone: true } })
  const settings = org.settings as { digest?: unknown } | null
  const lowPct = OrgSettingsSchema.shape.digest.parse(settings?.digest).budgetLowPct
  return { lowPct, lowBp: BigInt(Math.round(lowPct * PERCENT_TO_BP)), timezone: org.timezone }
}

export interface FiscalYearChoice {
  readonly years: ReadonlyArray<{ readonly id: string; readonly code: string; readonly startsOn: Date; readonly endsOn: Date }>
  readonly year: { readonly id: string; readonly code: string; readonly startsOn: Date; readonly endsOn: Date } | null
}

/** The fiscal year to show: the one asked for (NOT_FOUND when the organization has no such year), else the one today falls in, else the latest */
export async function chooseFiscalYear(tx: TenantTx, now: Date, timezone: string, fiscalYearId?: string): Promise<Result<FiscalYearChoice>> {
  const years = await tx.fiscalYear.findMany({ select: { id: true, code: true, startsOn: true, endsOn: true }, orderBy: { startsOn: 'desc' } })
  const today = dayIn(now, timezone)
  const year = fiscalYearId ? years.find((y) => y.id === fiscalYearId) : (years.find((y) => y.startsOn <= today && y.endsOn >= today) ?? years[0])
  if (fiscalYearId && !year) return err('NOT_FOUND', 'fiscal year not found')
  return ok({ years, year: year ?? null })
}

/** A fiscal year as the screens show it */
export const fiscalYearDto = (y: { id: string; code: string; startsOn: Date; endsOn: Date }) => ({ id: y.id, code: y.code, startsOn: dateText(y.startsOn), endsOn: dateText(y.endsOn) })

/**
 * Which budget lines this principal may see (budget.view): every line (ORG), the lines of the departments they head
 * (DEPT, with the subtrees), or none. A requester's own-line grant (SELECTED_LINE_ONLY) never opens the budget pages.
 */
export function budgetViewScope(principal: Principal): { kind: 'ORG' } | { kind: 'DEPT'; departmentIds: ReadonlySet<string> } | null {
  const scopes = scopesFor(principal, 'budget.view')
  if (scopes.has('ORG')) return { kind: 'ORG' }
  const headed = principal.kind === 'member' ? principal.headOfDepartmentIds : new Set<string>()
  return scopes.has('DEPT') && headed.size > 0 ? { kind: 'DEPT', departmentIds: headed } : null
}

export async function budgetDashboard(ctx: Ctx, input: { readonly fiscalYearId?: string } = {}): Promise<Result<BudgetDashboardDto>> {
  return reportTx(ctx, async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const principal = allowed.data
    const view = budgetViewScope(principal)
    if (!view) return err('FORBIDDEN', 'the budget dashboard is for department heads and the budget roles', { capability: 'budget.view' })
    const scope = view.kind
    const headed = view.kind === 'DEPT' ? view.departmentIds : new Set<string>()

    const { lowPct, lowBp, timezone } = await budgetLowThreshold(tx, ctx.organizationId)
    const chosen = await chooseFiscalYear(tx, ctx.now, timezone, input.fiscalYearId)
    if (!chosen.ok) return chosen
    const { years, year } = chosen.data

    const rows = year
      ? await tx.budgetLine.findMany({
          where: { fiscalYearId: year.id, ...(scope === 'DEPT' ? { departmentId: { in: [...headed] } } : {}) },
          select: { id: true, code: true, nameTh: true, status: true, departmentId: true, costCenter: { select: { code: true } }, ...BUDGET_LINE_AMOUNTS },
          orderBy: { code: 'asc' },
        })
      : []

    const changes = await lineChanges(tx, rows.map((l) => l.id))
    const byDepartment = new Map<string, BudgetAmounts>()
    for (const l of rows) byDepartment.set(l.departmentId, addAmounts(byDepartment.get(l.departmentId) ?? NO_AMOUNTS, lineAmounts(l)))
    const departments = await tx.department.findMany({ where: { id: { in: [...byDepartment.keys()] } }, select: { id: true, code: true, nameTh: true, nameEn: true }, orderBy: { code: 'asc' } })
    // S6-18 (FR-BUD-104 AC1): the burn of each line, department and the total, against the year shown
    const settings = (await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })).settings
    const pace = year ? burnContext(year, ctx.now, timezone, settings) : null
    const burn = (a: BudgetAmounts): BurnDto => (pace ? burnOf(a, pace) : { usedBp: null, forecastBp: null, alerts: [] })
    const total = rows.map(lineAmounts).reduce(addAmounts, NO_AMOUNTS)

    return ok({
      fiscalYear: year ? fiscalYearDto(year) : null,
      fiscalYears: years.map((y) => ({ id: y.id, code: y.code })),
      scope,
      lowPct,
      lines: rows.map((l) => ({ id: l.id, code: l.code, nameTh: l.nameTh, status: l.status, departmentId: l.departmentId, costCenterCode: l.costCenter.code, ...budgetFigures(lineAmounts(l), lowBp), changes: changes.get(l.id) ?? NO_CHANGES, burn: burn(lineAmounts(l)) })),
      departments: departments.map((d) => ({ ...d, ...budgetFigures(byDepartment.get(d.id)!, lowBp), burn: burn(byDepartment.get(d.id)!) })),
      total: { ...budgetFigures(total, lowBp), burn: burn(total) },
      asOf: ctx.now.toISOString(),
      // AC4: no transfer button while the DOA in effect has no BUDGET_TRANSFER rule
      can: { import: isAllowed(principal, 'budget.import'), manageGrants: isAllowed(principal, 'budgetGrant.manage'), transfer: isAllowed(principal, 'budget.transfer.submit') && (await hasTransferRule(tx, ctx.now)) },
    })
  })
}

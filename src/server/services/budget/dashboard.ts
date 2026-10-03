import { TZDate } from '@date-fns/tz'
import { BP_PER_WHOLE } from '@/core/money/constants'
import { toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { err, ok, type Result } from '@/core/result'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { authorize, scopesFor } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'

// The budget dashboard (spec §11.2, FR-BUD-005 AC1 AC3): per budget line, per department and in all, the planned
// amount and the four buckets of the ledger (§7.7) — available, reserved, committed and actual — with the share used
// ((committed + actual) ÷ planned) and the share held ((reserved + committed + actual) ÷ planned), and a warning when
// what is available falls below digest.budgetLowPct of the planned amount. The amounts come from the balance projection
// the ledger updates in the same transaction (INV-BUD-05), so the page is never behind the ledger (AC3). Who sees what
// follows budget.view: FINANCE BUDGET_ADMIN EXECUTIVE AUDITOR the whole organization, a department head the lines of
// the departments they head; a requester's grant covers the line chosen in their own form only (SELECTED_LINE_ONLY),
// never this page. The drill-down to documents (AC2) and the Excel export come with the page (S3-08).

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
  /** What is available is below digest.budgetLowPct of the planned amount */
  readonly low: boolean
}

export interface BudgetDashboardLineDto extends BudgetFiguresDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly status: 'OPEN' | 'FROZEN' | 'CLOSED'
  readonly departmentId: string
  readonly costCenterCode: string
}

export interface BudgetDashboardDepartmentDto extends BudgetFiguresDto {
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
  readonly total: BudgetFiguresDto
}

interface Amounts {
  readonly planned: bigint
  readonly available: bigint
  readonly reserved: bigint
  readonly committed: bigint
  readonly actual: bigint
}

const NONE: Amounts = { planned: 0n, available: 0n, reserved: 0n, committed: 0n, actual: 0n }

const add = (a: Amounts, b: Amounts): Amounts => ({
  planned: a.planned + b.planned,
  available: a.available + b.available,
  reserved: a.reserved + b.reserved,
  committed: a.committed + b.committed,
  actual: a.actual + b.actual,
})

/** part ÷ whole in basis points, half up (neither is ever negative); null when nothing is planned */
function basisPoints(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null
  return Number((part * BP_PER_WHOLE * 2n + whole) / (whole * 2n))
}

function figures(a: Amounts, lowBp: bigint): BudgetFiguresDto {
  return {
    planned: toMoneyDto(a.planned),
    available: toMoneyDto(a.available),
    reserved: toMoneyDto(a.reserved),
    committed: toMoneyDto(a.committed),
    actual: toMoneyDto(a.actual),
    usedBp: basisPoints(a.committed + a.actual, a.planned),
    heldBp: basisPoints(a.reserved + a.committed + a.actual, a.planned),
    low: a.planned > 0n && a.available * BP_PER_WHOLE < a.planned * lowBp,
  }
}

/** The calendar day of an instant in the organization's time zone, as a DATE column stores it (midnight UTC) */
function dayIn(at: Date, timezone: string): Date {
  const local = new TZDate(at.getTime(), timezone)
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()))
}

const dateText = (day: Date) => day.toISOString().slice(0, 10)

export async function budgetDashboard(ctx: Ctx, input: { readonly fiscalYearId?: string } = {}): Promise<Result<BudgetDashboardDto>> {
  const db = forTenant(ctx.organizationId)
  return db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budget.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const principal = allowed.data
    const scopes = scopesFor(principal, 'budget.view')
    const headed = principal.kind === 'member' ? principal.headOfDepartmentIds : new Set<string>()
    const scope = scopes.has('ORG') ? 'ORG' : scopes.has('DEPT') && headed.size > 0 ? 'DEPT' : null
    if (!scope) return err('FORBIDDEN', 'the budget dashboard is for department heads and the budget roles', { capability: 'budget.view' })

    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const settings = org.settings as { digest?: unknown; timezone?: unknown } | null
    const lowPct = OrgSettingsSchema.shape.digest.parse(settings?.digest).budgetLowPct
    const lowBp = BigInt(Math.round(lowPct * PERCENT_TO_BP))
    const timezone = OrgSettingsSchema.shape.timezone.parse(settings?.timezone)

    const years = await tx.fiscalYear.findMany({ select: { id: true, code: true, startsOn: true, endsOn: true }, orderBy: { startsOn: 'desc' } })
    const today = dayIn(ctx.now, timezone)
    const year = input.fiscalYearId ? years.find((y) => y.id === input.fiscalYearId) : (years.find((y) => y.startsOn <= today && y.endsOn >= today) ?? years[0])
    if (input.fiscalYearId && !year) return err('NOT_FOUND', 'fiscal year not found')

    const rows = year
      ? await tx.budgetLine.findMany({
          where: { fiscalYearId: year.id, ...(scope === 'DEPT' ? { departmentId: { in: [...headed] } } : {}) },
          select: {
            id: true,
            code: true,
            nameTh: true,
            status: true,
            departmentId: true,
            plannedSatang: true,
            costCenter: { select: { code: true } },
            balance: { select: { availableSatang: true, reservedSatang: true, committedSatang: true, actualSatang: true } },
          },
          orderBy: { code: 'asc' },
        })
      : []
    const amountsOf = (l: (typeof rows)[number]): Amounts => ({
      planned: l.plannedSatang,
      available: l.balance?.availableSatang ?? 0n,
      reserved: l.balance?.reservedSatang ?? 0n,
      committed: l.balance?.committedSatang ?? 0n,
      actual: l.balance?.actualSatang ?? 0n,
    })

    const byDepartment = new Map<string, Amounts>()
    for (const l of rows) byDepartment.set(l.departmentId, add(byDepartment.get(l.departmentId) ?? NONE, amountsOf(l)))
    const departments = await tx.department.findMany({ where: { id: { in: [...byDepartment.keys()] } }, select: { id: true, code: true, nameTh: true, nameEn: true }, orderBy: { code: 'asc' } })

    return ok({
      fiscalYear: year ? { id: year.id, code: year.code, startsOn: dateText(year.startsOn), endsOn: dateText(year.endsOn) } : null,
      fiscalYears: years.map((y) => ({ id: y.id, code: y.code })),
      scope,
      lowPct,
      lines: rows.map((l) => ({ id: l.id, code: l.code, nameTh: l.nameTh, status: l.status, departmentId: l.departmentId, costCenterCode: l.costCenter.code, ...figures(amountsOf(l), lowBp) })),
      departments: departments.map((d) => ({ ...d, ...figures(byDepartment.get(d.id)!, lowBp) })),
      total: figures(rows.map(amountsOf).reduce(add, NONE), lowBp),
    })
  })
}

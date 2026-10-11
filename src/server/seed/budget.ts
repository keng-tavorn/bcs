import { fund } from '@/core/budget'
import { amountToSatang } from '@/core/money/dto'
import { newId } from '@/lib/ids'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { applyBudget } from '@/server/budget/ledger'
import type { parseBudget, parseCostCenters } from './sheets'

// Budget of the demo organization (spec Appendix A, S3-04): sheet Budget of docs/inputs/BCS_inputs_v1_demo.xlsx after
// the organization structure exists. Local and staging only (prisma/seed.ts checks APP_ENV). Each fiscal year runs
// January to December (OQ-11 default); each cost center belongs to the department of its lines; each line is funded
// with its planned amount through the ledger (OUTSIDE → AVAILABLE, one event per line), as an import would. Running
// again adds nothing: lines that exist are left as they are. A cost center takes its name from sheet CostCenters when
// the workbook has one (phase 1, P1-02), otherwise the name of its department.

export type BudgetSheet = ReturnType<typeof parseBudget>
export type CostCenterSheet = ReturnType<typeof parseCostCenters>

export interface BudgetSeedReport {
  readonly fiscalYears: number
  readonly costCenters: number
  readonly lines: number
}

/** FY2569 → 1 Jan to 31 Dec 2026 (Buddhist year − 543; OQ-11 default) */
export function fiscalYearDates(code: string): { startsOn: Date; endsOn: Date } {
  const year = Number(code.slice(2)) - 543
  return { startsOn: new Date(`${year}-01-01T00:00:00Z`), endsOn: new Date(`${year}-12-31T00:00:00Z`) }
}

export async function seedBudget(organizationId: string, sheet: BudgetSheet, now: Date, costCenterSheet: CostCenterSheet = []): Promise<BudgetSeedReport> {
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    const report = { fiscalYears: 0, costCenters: 0, lines: 0 }
    const departments = await tx.department.findMany({ select: { id: true, code: true, nameTh: true } })
    const departmentOf = (code: string) => {
      const d = departments.find((x) => x.code === code)
      if (!d) throw new Error(`Budget: department ${code} is not in the Departments sheet`)
      return d
    }

    const years = new Map<string, string>()
    for (const code of new Set(sheet.map((l) => l.fiscalYear))) {
      let year = await tx.fiscalYear.findFirst({ where: { code }, select: { id: true } })
      if (!year) {
        year = await tx.fiscalYear.create({ data: { organizationId, code, ...fiscalYearDates(code) }, select: { id: true } })
        report.fiscalYears++
      }
      years.set(code, year.id)
    }

    const named = new Map(costCenterSheet.map((c) => [c.code, c]))
    const costCenters = new Map<string, string>()
    for (const l of sheet) {
      if (costCenters.has(l.costCenter)) continue
      const department = departmentOf(l.department)
      const listed = named.get(l.costCenter)
      if (costCenterSheet.length > 0 && !listed) throw new Error(`Budget: cost center ${l.costCenter} is not in the CostCenters sheet`)
      if (listed && listed.department !== l.department) throw new Error(`Budget: cost center ${l.costCenter} belongs to ${listed.department} in the CostCenters sheet, not ${l.department}`)
      let cc = await tx.costCenter.findFirst({ where: { code: l.costCenter }, select: { id: true, departmentId: true } })
      if (!cc) {
        const nameTh = listed?.nameTh ?? `ศูนย์ต้นทุน${department.nameTh}`
        cc = await tx.costCenter.create({ data: { organizationId, code: l.costCenter, nameTh, departmentId: department.id }, select: { id: true, departmentId: true } })
        report.costCenters++
      }
      if (cc.departmentId !== department.id) throw new Error(`Budget: cost center ${l.costCenter} belongs to another department than ${l.department}`)
      costCenters.set(l.costCenter, cc.id)
    }

    const created: Array<{ id: string; amount: bigint }> = []
    for (const l of sheet) {
      const fiscalYearId = years.get(l.fiscalYear)!
      if (await tx.budgetLine.findFirst({ where: { fiscalYearId, code: l.code }, select: { id: true } })) continue
      const line = await tx.budgetLine.create({
        data: { organizationId, fiscalYearId, departmentId: departmentOf(l.department).id, costCenterId: costCenters.get(l.costCenter)!, code: l.code, nameTh: l.nameTh, accountCode: l.accountCode, plannedSatang: 0n },
        select: { id: true },
      })
      await tx.budgetLineBalance.create({ data: { organizationId, budgetLineId: line.id } })
      created.push({ id: line.id, amount: amountToSatang(l.planned) })
      report.lines++
    }
    if (created.length) {
      const importId = newId()
      const funded = await applyBudget(
        tx,
        ctx,
        created.map((c) => ({ budgetLineId: c.id, document: { type: 'IMPORT' as const, id: importId }, run: (s) => fund(s, c.amount, importId) })),
      )
      if (!funded.ok) throw new Error(`Budget: funding failed: ${funded.error.code}`)
      await appendEvents(tx, ctx, funded.events)
    }
    return report
  })
}

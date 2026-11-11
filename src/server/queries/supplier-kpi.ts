import { dateIn } from '@/core/supplier-docs'
import type { BusinessCalendar } from '@/core/sla'
import { g7BusinessDays, g7Median } from '@/core/supplier-onboarding'
import type { TenantTx } from '@/server/db/tenant'

// KPI G-7 and the supplier report of /reports/suppliers (S7-16 · BR-SUP ข้อ 13 · §11.4): the applications of new
// suppliers approved in the period (by decidedAt), each with its business days from invitation to approval
// (g7BusinessDays · businessMinutesBetween ÷ the minutes of a business day, one decimal half up), the lower median of
// all of them, of the ones the supplier filled in itself and of the ones procurement filled in for it
// (filledOnBehalfById); the applications waiting past their escalation; the suppliers whose required documents expired,
// by category. The numbers come from this code, never from the AI. Read only, inside the caller's transaction (the
// report checks report.view and its scope first).

const WAITING = ['INVITED', 'DRAFT', 'RETURNED'] as const
/** An individual's application is named by its number, never the person's name (BR-NOTI-10 · NFR-PRIV-02) */
const nameOf = (a: { readonly payeeType: string; readonly nameTh: string; readonly number: string | null }) => (a.payeeType === 'INDIVIDUAL' ? (a.number ?? '-') : a.nameTh)
const TIMEZONE = 'Asia/Bangkok'

export interface SupplierKpiRow {
  readonly applicationId: string
  readonly number: string | null
  readonly nameTh: string
  readonly invitedAt: string
  readonly decidedAt: string
  readonly businessDays: string
  readonly filledOnBehalf: boolean
}

export interface SupplierKpi {
  readonly median: { readonly all: string | null; readonly self: string | null; readonly onBehalf: string | null }
  readonly approved: readonly SupplierKpiRow[]
  readonly overdue: readonly { readonly applicationId: string; readonly number: string | null; readonly nameTh: string; readonly status: string; readonly escalatedAt: string }[]
  readonly expiredByCategory: readonly { readonly category: string; readonly suppliers: number }[]
}

/**
 * The supplier report of a period [from, to) on the organization's business calendar; `inviterDepartmentIds` narrows it
 * to the applications invited by members of those departments (report.view DEPT), null for the whole organization. The
 * expired documents are counts by category, of the organization (no names: a supplier is no department's)
 */
export async function computeSupplierKpi(tx: TenantTx, calendar: BusinessCalendar, period: { readonly from: Date; readonly to: Date; readonly now: Date }, inviterDepartmentIds: readonly string[] | null): Promise<SupplierKpi> {
  const inScope = inviterDepartmentIds ? { invitedBy: { primaryDepartmentId: { in: [...inviterDepartmentIds] } } } : {}
  const approved = await tx.supplierApplication.findMany({
    where: { kind: 'NEW', status: 'APPROVED', decidedAt: { gte: period.from, lt: period.to }, ...inScope },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, number: true, nameTh: true, payeeType: true, invitedAt: true, decidedAt: true, filledOnBehalfById: true },
  })
  const decided = approved.filter((a): a is typeof a & { decidedAt: Date } => a.decidedAt !== null)
  const businessDays = g7BusinessDays(decided, calendar)
  const rows = decided.map((a, i) => ({ a, days: businessDays[i]! }))
  const days = (filter: (onBehalf: boolean) => boolean) => rows.filter((r) => filter(r.a.filledOnBehalfById !== null)).map((r) => r.days)
  const overdue = await tx.supplierApplication.findMany({
    where: { status: { in: [...WAITING] }, escalatedAt: { not: null }, ...inScope },
    orderBy: [{ escalatedAt: 'asc' }, { id: 'asc' }],
    take: 100,
    select: { id: true, number: true, nameTh: true, payeeType: true, status: true, escalatedAt: true },
  })
  // a supplier whose document is past its expiry today (BR-SDOC-02), counted once, by its category
  const today = dateIn(period.now, TIMEZONE)
  const expired = await tx.supplierDocument.findMany({
    where: { supplierId: { not: null }, OR: [{ status: 'EXPIRED' }, { status: 'VERIFIED', expiresOn: { lt: new Date(`${today}T00:00:00Z`) } }], documentType: { required: true } },
    select: { supplierId: true, supplier: { select: { category: true } } },
    distinct: ['supplierId'],
  })
  const byCategory = new Map<string, number>()
  for (const e of expired) byCategory.set(e.supplier?.category ?? '-', (byCategory.get(e.supplier?.category ?? '-') ?? 0) + 1)
  return {
    median: { all: g7Median(days(() => true)), self: g7Median(days((b) => !b)), onBehalf: g7Median(days((b) => b)) },
    approved: rows.map((r) => ({ applicationId: r.a.id, number: r.a.number, nameTh: nameOf(r.a), invitedAt: r.a.invitedAt.toISOString(), decidedAt: r.a.decidedAt.toISOString(), businessDays: r.days, filledOnBehalf: r.a.filledOnBehalfById !== null })),
    overdue: overdue.map((o) => ({ applicationId: o.id, number: o.number, nameTh: nameOf(o), status: o.status, escalatedAt: o.escalatedAt!.toISOString() })),
    expiredByCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category, suppliers]) => ({ category, suppliers })),
  }
}

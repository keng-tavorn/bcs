import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'

// The budget lines a requester may choose in the request form (BR-BUD-04, FR-BUD-004 AC2): the open lines of their own
// department, and of other departments through a grant in force, in the fiscal year of `day` (YYYY-MM-DD, Thai date).
// The submit checks the same again; this list only fills the form.

export interface UsableBudgetLineDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly departmentId: string
  /** Through a grant (another department's line) */
  readonly granted: boolean
}

export async function listUsableBudgetLines(ctx: Ctx, day: string): Promise<UsableBudgetLineDto[]> {
  if (ctx.actor.type !== 'USER') return []
  const memberId = ctx.actor.memberId
  const db = forTenant(ctx.organizationId)
  const member = await db.member.findUniqueOrThrow({ where: { id: memberId }, select: { primaryDepartmentId: true } })
  const date = new Date(`${day}T00:00:00Z`)
  const own = member.primaryDepartmentId ? [{ departmentId: member.primaryDepartmentId }] : []
  const grantees = [{ granteeMemberId: memberId }, ...(member.primaryDepartmentId ? [{ granteeDepartmentId: member.primaryDepartmentId }] : [])]
  const lines = await db.budgetLine.findMany({
    where: {
      status: 'OPEN',
      fiscalYear: { startsOn: { lte: date }, endsOn: { gte: date } },
      OR: [...own, { grants: { some: { revokedAt: null, validFrom: { lte: ctx.now }, AND: [{ OR: [{ validTo: null }, { validTo: { gt: ctx.now } }] }, { OR: grantees }] } } }],
    },
    select: { id: true, code: true, nameTh: true, departmentId: true },
    orderBy: { code: 'asc' },
  })
  return lines.map((l) => ({ ...l, granted: l.departmentId !== member.primaryDepartmentId }))
}

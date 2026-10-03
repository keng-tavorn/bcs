import { TZDate } from '@date-fns/tz'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Budget grants (spec FR-BUD-004 AC1, BR-BUD-04): BUDGET_ADMIN lets one department, or one member, use a budget line of
// another department for a period, and can take it back. Requests check the grant at submit (S3-05), and the approvers
// then come from the department that owns the budget (AC3).

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const Instant = z.iso.datetime({ offset: true })
const CreateInput = z
  .strictObject({ budgetLineId: z.uuid(), granteeDepartmentId: z.uuid().optional(), granteeMemberId: z.uuid().optional(), validFrom: Instant, validTo: Instant.optional() })
  .refine((g) => Boolean(g.granteeDepartmentId) !== Boolean(g.granteeMemberId), { message: 'a grant goes to one department or one member', path: ['granteeDepartmentId'] })

export const createBudgetGrantCommand = defineCommand({
  name: 'budget_grant.create',
  capability: 'budgetGrant.manage',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ grantId: string }>> {
    const allowed = await authorize(tx, ctx, 'budgetGrant.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member grants' } }
    const line = await tx.budgetLine.findFirst({ where: { id: input.budgetLineId }, select: { id: true, departmentId: true, status: true } })
    if (!line) return fail('NOT_FOUND', 'budget line not found')
    if (line.status === 'CLOSED') return fail('VALIDATION_FAILED', 'the budget line is closed', { field: 'budgetLineId', reason: 'BUDGET_LINE_CLOSED' })
    const validFrom = new Date(input.validFrom)
    const validTo = input.validTo ? new Date(input.validTo) : null
    if (validTo && validTo <= validFrom) return fail('VALIDATION_FAILED', 'the grant ends before it starts', { field: 'validTo', reason: 'PERIOD' })
    if (input.granteeDepartmentId) {
      if (input.granteeDepartmentId === line.departmentId) return fail('VALIDATION_FAILED', 'the department owns this budget line already', { field: 'granteeDepartmentId', reason: 'OWN_DEPARTMENT' })
      if (!(await tx.department.findFirst({ where: { id: input.granteeDepartmentId, active: true }, select: { id: true } }))) {
        return fail('VALIDATION_FAILED', 'unknown department', { field: 'granteeDepartmentId', reason: 'DEPARTMENT' })
      }
    }
    if (input.granteeMemberId && !(await tx.member.findFirst({ where: { id: input.granteeMemberId, status: 'ACTIVE' }, select: { id: true } }))) {
      return fail('VALIDATION_FAILED', 'unknown or inactive member', { field: 'granteeMemberId', reason: 'MEMBER' })
    }
    const grant = await tx.budgetGrant.create({
      data: { organizationId: ctx.organizationId, budgetLineId: line.id, granteeDepartmentId: input.granteeDepartmentId ?? null, granteeMemberId: input.granteeMemberId ?? null, validFrom, validTo, grantedById: actor },
      select: { id: true },
    })
    return {
      ok: true,
      result: { grantId: grant.id },
      events: [
        {
          type: 'budget_grant.created',
          aggregateType: 'BudgetGrant',
          aggregateId: grant.id,
          data: { budgetLineId: line.id, granteeDepartmentId: input.granteeDepartmentId ?? null, granteeMemberId: input.granteeMemberId ?? null, validFrom: validFrom.toISOString(), validTo: validTo?.toISOString() ?? null },
        },
      ],
    }
  },
})

export function createBudgetGrant(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createBudgetGrantCommand, input, options)
}

const RevokeInput = z.strictObject({ grantId: z.uuid() })

export const revokeBudgetGrantCommand = defineCommand({
  name: 'budget_grant.revoke',
  capability: 'budgetGrant.manage',
  input: RevokeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ grantId: string }>> {
    const allowed = await authorize(tx, ctx, 'budgetGrant.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const grant = await tx.budgetGrant.findFirst({ where: { id: input.grantId }, select: { id: true, budgetLineId: true, revokedAt: true } })
    if (!grant) return fail('NOT_FOUND', 'grant not found')
    if (grant.revokedAt) return fail('INVALID_STATE_TRANSITION', 'the grant was revoked already', { from: 'REVOKED' })
    await tx.budgetGrant.update({ where: { id: grant.id }, data: { revokedAt: ctx.now } })
    // Requests submitted before keep what they reserved; new submits no longer find the grant
    return { ok: true, result: { grantId: grant.id }, events: [{ type: 'budget_grant.revoked', aggregateType: 'BudgetGrant', aggregateId: grant.id, data: { budgetLineId: grant.budgetLineId } }] }
  },
})

export function revokeBudgetGrant(ctx: Ctx, input: z.input<typeof RevokeInput>, options: RunOptions) {
  return runCommand(ctx, revokeBudgetGrantCommand, input, options)
}

// ---------- screen support (S3-07 /budgets/grants): the grants with their state, the choices, grants by whole days ----------

/** What a grant is at a moment, from its period: in force, coming, ended, or taken back */
export type BudgetGrantState = 'ACTIVE' | 'SCHEDULED' | 'ENDED' | 'REVOKED'

export function budgetGrantState(g: { validFrom: Date; validTo: Date | null; revokedAt: Date | null }, now: Date): BudgetGrantState {
  if (g.revokedAt) return 'REVOKED'
  if (g.validTo && g.validTo.getTime() <= now.getTime()) return 'ENDED'
  return g.validFrom.getTime() > now.getTime() ? 'SCHEDULED' : 'ACTIVE'
}

export interface GrantNameDto {
  readonly th: string
  readonly en: string | null
}

export interface BudgetGrantViewRow {
  readonly id: string
  readonly state: BudgetGrantState
  readonly line: { readonly id: string; readonly code: string; readonly nameTh: string; readonly department: GrantNameDto & { readonly code: string } }
  readonly grantee:
    | { readonly kind: 'DEPARTMENT'; readonly id: string; readonly code: string; readonly name: GrantNameDto }
    | { readonly kind: 'MEMBER'; readonly id: string; readonly name: GrantNameDto; readonly employeeCode: string | null; readonly department: GrantNameDto | null }
  readonly validFrom: string
  readonly validTo: string | null
  /** First and last day (YYYY-MM-DD, the organization's time zone) when the period runs midnight to midnight; last null = no end */
  readonly days: { readonly first: string; readonly last: string | null } | null
  readonly grantedBy: GrantNameDto
  readonly grantedAt: string
  readonly revokedAt: string | null
}

export interface BudgetGrantsViewDto {
  /** In force now and coming, the latest start first */
  readonly current: readonly BudgetGrantViewRow[]
  /** Ended or taken back, the latest first (at most BUDGET_GRANT_PAST_ROWS) */
  readonly past: readonly BudgetGrantViewRow[]
  /** Lines that may be granted: open or frozen, in a fiscal year that is open (a closed line is refused) */
  readonly lines: ReadonlyArray<{ readonly id: string; readonly code: string; readonly nameTh: string; readonly departmentId: string; readonly department: GrantNameDto; readonly fiscalYearCode: string; readonly fiscalYearEnds: string }>
  readonly departments: ReadonlyArray<{ readonly id: string; readonly code: string; readonly name: GrantNameDto }>
  /** Active members (name, employee code and main department) — who a grant to one member can go to */
  readonly members: ReadonlyArray<{ readonly id: string; readonly name: GrantNameDto; readonly employeeCode: string | null; readonly department: GrantNameDto | null }>
  /** Today in the organization's time zone (YYYY-MM-DD) */
  readonly today: string
}

/** How many ended or revoked grants the page lists */
export const BUDGET_GRANT_PAST_ROWS = 50

const ymd = (d: TZDate) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const atMidnight = (d: TZDate) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0

/** The whole days of a period that runs from one local midnight to another (the last day included); null otherwise */
function wholeDays(validFrom: Date, validTo: Date | null, timezone: string): BudgetGrantViewRow['days'] {
  const start = new TZDate(validFrom.getTime(), timezone)
  if (!atMidnight(start)) return null
  if (!validTo) return { first: ymd(start), last: null }
  const end = new TZDate(validTo.getTime(), timezone)
  if (!atMidnight(end)) return null
  return { first: ymd(start), last: ymd(new TZDate(end.getFullYear(), end.getMonth(), end.getDate() - 1, 0, 0, timezone)) }
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local midnight of a calendar day (YYYY-MM-DD) `plusDays` later, in `timezone`; null when it is not a date */
function midnight(day: string, timezone: string, plusDays = 0): Date | null {
  const m = DAY.exec(day)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return new Date(new TZDate(y, mo - 1, d + plusDays, 0, 0, timezone).getTime())
}

const nameOf = (m: { displayNameTh: string; displayNameEn: string | null }): GrantNameDto => ({ th: m.displayNameTh, en: m.displayNameEn })
const deptName = (d: { nameTh: string; nameEn: string | null }): GrantNameDto => ({ th: d.nameTh, en: d.nameEn })

/** The grants page (budgetGrant.manage): every grant with its state now, and what a new grant can be made of */
export async function budgetGrantsView(ctx: Ctx): Promise<Result<BudgetGrantsViewDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'budgetGrant.manage')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const { timezone } = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })
    const department = { select: { code: true, nameTh: true, nameEn: true } } as const
    const [grants, lines, departments, members] = await Promise.all([
      tx.budgetGrant.findMany({
        select: {
          id: true,
          validFrom: true,
          validTo: true,
          revokedAt: true,
          createdAt: true,
          budgetLine: { select: { id: true, code: true, nameTh: true, department } },
          granteeDepartment: { select: { id: true, code: true, nameTh: true, nameEn: true } },
          granteeMember: { select: { id: true, displayNameTh: true, displayNameEn: true, employeeCode: true, primaryDepartment: { select: { nameTh: true, nameEn: true } } } },
          grantedBy: { select: { displayNameTh: true, displayNameEn: true } },
        },
        orderBy: { validFrom: 'desc' },
      }),
      tx.budgetLine.findMany({
        where: { status: { in: ['OPEN', 'FROZEN'] }, fiscalYear: { status: 'OPEN' } },
        select: { id: true, code: true, nameTh: true, departmentId: true, department, fiscalYear: { select: { code: true, endsOn: true } } },
        orderBy: { code: 'asc' },
      }),
      tx.department.findMany({ where: { active: true }, select: { id: true, code: true, nameTh: true, nameEn: true }, orderBy: { code: 'asc' } }),
      tx.member.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, displayNameTh: true, displayNameEn: true, employeeCode: true, primaryDepartment: { select: { nameTh: true, nameEn: true } } },
        orderBy: { displayNameTh: 'asc' },
      }),
    ])
    const rows = grants.map((g): BudgetGrantViewRow => ({
      id: g.id,
      state: budgetGrantState(g, ctx.now),
      line: { id: g.budgetLine.id, code: g.budgetLine.code, nameTh: g.budgetLine.nameTh, department: { code: g.budgetLine.department.code, ...deptName(g.budgetLine.department) } },
      grantee: g.granteeMember
        ? {
            kind: 'MEMBER',
            id: g.granteeMember.id,
            name: nameOf(g.granteeMember),
            employeeCode: g.granteeMember.employeeCode,
            department: g.granteeMember.primaryDepartment ? deptName(g.granteeMember.primaryDepartment) : null,
          }
        : { kind: 'DEPARTMENT', id: g.granteeDepartment!.id, code: g.granteeDepartment!.code, name: deptName(g.granteeDepartment!) },
      validFrom: g.validFrom.toISOString(),
      validTo: g.validTo?.toISOString() ?? null,
      days: wholeDays(g.validFrom, g.validTo, timezone),
      grantedBy: nameOf(g.grantedBy),
      grantedAt: g.createdAt.toISOString(),
      revokedAt: g.revokedAt?.toISOString() ?? null,
    }))
    const endOf = (r: BudgetGrantViewRow) => new Date(r.revokedAt ?? r.validTo ?? r.validFrom).getTime()
    return ok({
      current: rows.filter((r) => r.state === 'ACTIVE' || r.state === 'SCHEDULED'),
      past: rows
        .filter((r) => r.state === 'ENDED' || r.state === 'REVOKED')
        .sort((a, b) => endOf(b) - endOf(a))
        .slice(0, BUDGET_GRANT_PAST_ROWS),
      lines: lines.map((l) => ({ id: l.id, code: l.code, nameTh: l.nameTh, departmentId: l.departmentId, department: deptName(l.department), fiscalYearCode: l.fiscalYear.code, fiscalYearEnds: l.fiscalYear.endsOn.toISOString().slice(0, 10) })),
      departments: departments.map((d) => ({ id: d.id, code: d.code, name: deptName(d) })),
      members: members.map((m) => ({ id: m.id, name: nameOf(m), employeeCode: m.employeeCode, department: m.primaryDepartment ? deptName(m.primaryDepartment) : null })),
      today: ymd(new TZDate(ctx.now.getTime(), timezone)),
    })
  })
}

/** What the grants page sends; every value is checked here and again by createBudgetGrant */
export interface BudgetGrantDaysRequest {
  readonly budgetLineId: string
  readonly granteeKind: string
  readonly granteeDepartmentId?: string
  readonly granteeMemberId?: string
  /** First day of the grant (YYYY-MM-DD, the organization's time zone) */
  readonly firstDay: string
  /** Last day, included: the grant ends at the next midnight */
  readonly lastDay: string
}

const DaysInput = z.strictObject({
  budgetLineId: z.string(),
  granteeKind: z.enum(['DEPARTMENT', 'MEMBER']),
  granteeDepartmentId: z.string().optional(),
  granteeMemberId: z.string().optional(),
  firstDay: z.string(),
  lastDay: z.string(),
})

/**
 * Grants a budget line by whole days (FR-BUD-004 AC1: with a start and an end): [first day 00:00, the day after the last
 * 00:00) in the organization's time zone, then createBudgetGrant applies its rules (one grantee, never the owning
 * department, a line that is not closed). A period that ended before today would never let anyone use the line, so it
 * is refused (PAST_PERIOD). budgetGrant.manage is checked before anything is read from the input (BR-AUTH-01), so a
 * member who may not grant learns nothing about it; createBudgetGrant checks it again.
 */
export async function createBudgetGrantForDays(ctx: Ctx, input: BudgetGrantDaysRequest, options: RunOptions) {
  const allowed = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await authorize(tx, ctx, 'budgetGrant.manage')
    if (!principal.ok) return principal
    return ok((await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })).timezone)
  })
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const timezone = allowed.data
  const parsed = DaysInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid budget grant', { field: parsed.error.issues[0]?.path.join('.') ?? '(input)' })
  const g = parsed.data
  const validFrom = midnight(g.firstDay, timezone)
  if (!validFrom) return err('VALIDATION_FAILED', 'the first day is not a date', { field: 'firstDay' })
  const validTo = midnight(g.lastDay, timezone, 1)
  if (!validTo) return err('VALIDATION_FAILED', 'the last day is not a date', { field: 'lastDay' })
  if (validTo.getTime() <= validFrom.getTime()) return err('VALIDATION_FAILED', 'the grant ends before it starts', { field: 'lastDay', reason: 'PERIOD' })
  if (validTo.getTime() <= ctx.now.getTime()) return err('VALIDATION_FAILED', 'the period has passed', { field: 'lastDay', reason: 'PAST_PERIOD' })
  const grantee = g.granteeKind === 'DEPARTMENT' ? { granteeDepartmentId: g.granteeDepartmentId ?? '' } : { granteeMemberId: g.granteeMemberId ?? '' }
  return createBudgetGrant(ctx, { budgetLineId: g.budgetLineId, ...grantee, validFrom: validFrom.toISOString(), validTo: validTo.toISOString() }, options)
}

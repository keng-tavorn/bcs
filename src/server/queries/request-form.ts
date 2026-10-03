import { toMoneyDto, type MoneyDto } from '@/core/money/dto'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { listUsableBudgetLines } from './budget'

// What the request catalog and form read (spec FR-INT-001, FR-INT-003, FR-INT-004, BR-FORM-02, BR-BUD-04): the budget
// lines, the delivery sites and the suppliers a requester may choose, and what the form starts with. Read only; the
// services check everything again when the request is saved and submitted.

export type ScreenLocale = 'th' | 'en'

export interface CatalogTypeDto {
  readonly code: string
  readonly name: string
  /** When to use this type (RequestType.descriptionTh: the organization writes it in its own language) */
  readonly description: string | null
  readonly documentType: 'PURCHASE_REQUEST' | 'SUPPLIER_REQUEST'
}

/**
 * FR-INT-001 AC1: the active request types whose current form version is published, in the organization's order — the
 * same rule the form (getNewRequestForm), the preview and createDraft use, so every card opens a form
 */
export async function listRequestCatalog(ctx: Ctx, locale: ScreenLocale): Promise<CatalogTypeDto[]> {
  const types = await forTenant(ctx.organizationId).requestType.findMany({
    where: { active: true, currentFormVersion: { is: { status: 'PUBLISHED' } } },
    select: { code: true, nameTh: true, nameEn: true, descriptionTh: true, documentType: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  })
  return types.map((t) => ({ code: t.code, name: (locale === 'en' ? t.nameEn : null) ?? t.nameTh, description: t.descriptionTh, documentType: t.documentType }))
}

export interface MyDraftDto {
  readonly id: string
  readonly title: string
  readonly typeName: string
  readonly status: 'DRAFT' | 'RETURNED'
  /** ISO 8601 UTC */
  readonly updatedAt: string
}

/** FR-INT-006: the member's own drafts and returned requests, newest first, so they go on from any device */
export async function listMyOpenDrafts(ctx: Ctx, locale: ScreenLocale, limit: number): Promise<MyDraftDto[]> {
  if (ctx.actor.type !== 'USER') return []
  const rows = await forTenant(ctx.organizationId).request.findMany({
    where: { requesterMemberId: ctx.actor.memberId, status: { in: ['DRAFT', 'RETURNED'] } },
    select: { id: true, title: true, status: true, updatedAt: true, requestType: { select: { nameTh: true, nameEn: true } } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  })
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    typeName: (locale === 'en' ? r.requestType.nameEn : null) ?? r.requestType.nameTh,
    status: r.status as 'DRAFT' | 'RETURNED',
    updatedAt: r.updatedAt.toISOString(),
  }))
}

export interface FormBudgetLineDto {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly departmentId: string
  readonly departmentName: string
  readonly costCenterCode: string
  readonly costCenterName: string
  /** Another department's line, used through a BudgetGrant (FR-BUD-004) */
  readonly granted: boolean
}

/**
 * The budget lines the requester may choose in the form (BR-BUD-04, FR-INT-003 AC2, FR-BUD-004 AC2): their own
 * department's open lines and other departments' lines through a grant in force, with the names the screen shows. No
 * amounts: the requester sees what is left only of the line they chose (budget.view SELECTED_LINE_ONLY).
 */
export async function listFormBudgetLines(ctx: Ctx, day: string, locale: ScreenLocale): Promise<FormBudgetLineDto[]> {
  const usable = await listUsableBudgetLines(ctx, day)
  if (usable.length === 0) return []
  const db = forTenant(ctx.organizationId)
  const lines = await db.budgetLine.findMany({
    where: { id: { in: usable.map((l) => l.id) } },
    select: { id: true, department: { select: { nameTh: true, nameEn: true } }, costCenter: { select: { code: true, nameTh: true } } },
  })
  const byId = new Map(lines.map((l) => [l.id, l]))
  return usable.map((l) => {
    const row = byId.get(l.id)!
    return {
      id: l.id,
      code: l.code,
      name: l.nameTh,
      departmentId: l.departmentId,
      departmentName: (locale === 'en' ? row.department.nameEn : null) ?? row.department.nameTh,
      costCenterCode: row.costCenter.code,
      costCenterName: row.costCenter.nameTh,
      granted: l.granted,
    }
  })
}

/**
 * BR-FORM-02: the budget line the requester used last with this request type in the fiscal year of `day`, when they
 * may still use it; otherwise their department's only line. null when the requester has to choose.
 */
export async function defaultBudgetLineId(ctx: Ctx, requestTypeCode: string, usable: readonly FormBudgetLineDto[]): Promise<string | null> {
  if (ctx.actor.type !== 'USER' || usable.length === 0) return null
  const ids = new Set(usable.map((l) => l.id))
  const recent = await forTenant(ctx.organizationId).request.findMany({
    where: { requesterMemberId: ctx.actor.memberId, requestType: { code: requestTypeCode }, submittedAt: { not: null }, budgetLineId: { in: [...ids] } },
    select: { budgetLineId: true },
    orderBy: { submittedAt: 'desc' },
    take: 1,
  })
  if (recent[0]?.budgetLineId) return recent[0].budgetLineId
  const own = usable.filter((l) => !l.granted)
  return own.length === 1 ? own[0]!.id : null
}

export interface FormDeliverySiteDto {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly address: string | null
}

/** Where goods may go: the organization's active delivery sites (sheet Sites), by code (BR-CONS-01 groups POs by site) */
export async function listFormDeliverySites(ctx: Ctx): Promise<FormDeliverySiteDto[]> {
  const sites = await forTenant(ctx.organizationId).deliverySite.findMany({ where: { active: true }, select: { id: true, code: true, nameTh: true, address: true }, orderBy: { code: 'asc' } })
  return sites.map((s) => ({ id: s.id, code: s.code, name: s.nameTh, address: s.address }))
}

/**
 * BR-FORM-02 "สถานที่ส่งล่าสุด": the delivery site of the requester's latest request — the one they started last — that
 * names one still in use (any request type, a draft included: the latest place they chose); otherwise the organization's
 * only site. null when the requester has to choose. The requester may change it (FR-INT-003 AC1). Ordered by when the
 * request was created, never by its last update: an approver's decision or a cancel on an older request must not bring
 * its site back.
 */
export async function defaultDeliverySiteId(ctx: Ctx, sites: readonly FormDeliverySiteDto[]): Promise<string | null> {
  if (ctx.actor.type !== 'USER' || sites.length === 0) return null
  const latest = await forTenant(ctx.organizationId).request.findFirst({
    where: { requesterMemberId: ctx.actor.memberId, deliverySiteId: { in: sites.map((s) => s.id) } },
    select: { deliverySiteId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (latest?.deliverySiteId) return latest.deliverySiteId
  return sites.length === 1 ? sites[0]!.id : null
}

export interface FormSupplierDto {
  readonly id: string
  readonly code: string
  readonly name: string
}

/**
 * The suppliers a requester may suggest (FR-P2P-001 AC2: PROCUREMENT chooses the supplier of each line; the requester's
 * choice is a suggestion): the active ones of the register, with the basic details every member may see (§2.4
 * supplier.view BASIC_FIELDS_ONLY).
 */
export async function listFormSuppliers(ctx: Ctx, locale: ScreenLocale): Promise<FormSupplierDto[]> {
  const suppliers = await forTenant(ctx.organizationId).supplier.findMany({ where: { status: 'ACTIVE' }, select: { id: true, code: true, nameTh: true, nameEn: true }, orderBy: { code: 'asc' } })
  return suppliers
    .map((s) => ({ id: s.id, code: s.code, name: (locale === 'en' ? s.nameEn : null) ?? s.nameTh }))
    .sort((a, b) => a.name.localeCompare(b.name, locale === 'en' ? 'en' : 'th') || a.code.localeCompare(b.code))
}

export interface BudgetAvailabilityDto {
  readonly budgetLineId: string
  readonly departmentId: string
  /** What the request can still reserve on the line: what is available, plus what this request itself holds there */
  readonly available: MoneyDto
}

/**
 * FR-INT-004 AC1 (budget.view SELECTED_LINE_ONLY): what is left on one budget line, for its requester only — the line
 * must be one they may choose (their own department's or granted, open, in the fiscal year of `day`). When editing a
 * request, what that request already reserves on the line counts as available to it, as the resubmit gives it back
 * before reserving again. null: not a line this member may use.
 */
export async function budgetLineAvailability(ctx: Ctx, input: { budgetLineId: string; day: string; requestId?: string | null }): Promise<BudgetAvailabilityDto | null> {
  if (ctx.actor.type !== 'USER') return null
  const usable = (await listUsableBudgetLines(ctx, input.day)).find((l) => l.id === input.budgetLineId)
  if (!usable) return null
  const db = forTenant(ctx.organizationId)
  const balance = await db.budgetLineBalance.findFirst({ where: { budgetLineId: usable.id }, select: { availableSatang: true } })
  let available = balance?.availableSatang ?? 0n
  if (input.requestId) {
    const own = await db.requestLine.findMany({ where: { requestId: input.requestId, request: { requesterMemberId: ctx.actor.memberId } }, select: { id: true } })
    if (own.length) {
      const held = await db.budgetAllocation.aggregate({
        where: { budgetLineId: usable.id, sourceType: 'REQUEST_LINE', sourceId: { in: own.map((l) => l.id) } },
        _sum: { reservedSatang: true },
      })
      available += held._sum.reservedSatang ?? 0n
    }
  }
  return { budgetLineId: usable.id, departmentId: usable.departmentId, available: toMoneyDto(available) }
}

/** The names behind the codes of a DOA gap (APPROVER_NOT_FOUND names a position code and department codes) */
export async function doaGapNames(ctx: Ctx, gap: { position: string | null; departments: readonly string[] }, locale: ScreenLocale): Promise<{ position: string | null; departments: string[] }> {
  const db = forTenant(ctx.organizationId)
  const [position, departments] = await Promise.all([
    gap.position ? db.position.findFirst({ where: { code: gap.position }, select: { nameTh: true, nameEn: true } }) : null,
    gap.departments.length ? db.department.findMany({ where: { code: { in: [...gap.departments] } }, select: { code: true, nameTh: true, nameEn: true } }) : [],
  ])
  const name = (row: { nameTh: string; nameEn: string | null }) => (locale === 'en' ? row.nameEn : null) ?? row.nameTh
  return {
    position: position ? name(position) : gap.position,
    departments: gap.departments.map((code) => {
      const row = departments.find((d) => d.code === code)
      return row ? name(row) : code
    }),
  }
}

export interface SentRequestDto {
  readonly number: string | null
  /** Who decides it now: the assignees of its open approval tasks (a delegate with the person they act for) */
  readonly waitingFor: ReadonlyArray<{ readonly name: string; readonly principalName: string | null }>
}

/**
 * What the form confirms right after "ส่งขออนุมัติ" (§9.9 rule 7): the number the request got and who decides it now.
 * The requester's own request only; null for anyone else's.
 */
export async function sentRequestSummary(ctx: Ctx, requestId: string, locale: ScreenLocale): Promise<SentRequestDto | null> {
  if (ctx.actor.type !== 'USER') return null
  const db = forTenant(ctx.organizationId)
  const request = await db.request.findFirst({ where: { id: requestId, requesterMemberId: ctx.actor.memberId }, select: { number: true, currentRouteId: true } })
  if (!request) return null
  const name = (m: { displayNameTh: string; displayNameEn: string | null }) => (locale === 'en' ? m.displayNameEn : null) ?? m.displayNameTh
  const tasks = request.currentRouteId
    ? await db.approvalTask.findMany({
        where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { routeId: request.currentRouteId } },
        select: { assignee: { select: { displayNameTh: true, displayNameEn: true } }, principal: { select: { displayNameTh: true, displayNameEn: true } } },
        orderBy: { assignedAt: 'asc' },
      })
    : []
  return { number: request.number, waitingFor: tasks.map((t) => ({ name: name(t.assignee), principalName: t.principal ? name(t.principal) : null })) }
}

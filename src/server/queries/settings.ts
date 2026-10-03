import type { Weekday } from '@/core/sla'
import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'

// Read-only facts for the organization settings pages (FR-ADM-003 to FR-ADM-005): the business calendar, holidays,
// number patterns with their counters, and the request types with their form versions. The caller (a service in
// src/server/services/{calendar,numbering,request-types}) has already checked the admin capability.

export type NumberingRules = OrgSettings['numbering']
export type NumberedDocumentCode = keyof NumberingRules

export interface BusinessHoursDto {
  readonly workdays: readonly Weekday[]
  /** "HH:mm" in the organization's time zone */
  readonly start: string
  readonly end: string
  readonly timezone: string
}

export interface HolidayDto {
  /** Local date "YYYY-MM-DD" */
  readonly date: string
  readonly nameTh: string
}

const dateKey = (d: Date) => d.toISOString().slice(0, 10)

async function storedSettings(ctx: Ctx): Promise<{ settings: Record<string, unknown>; timezone: string }> {
  const org = await forTenant(ctx.organizationId).organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true, timezone: true } })
  return { settings: (org.settings ?? {}) as Record<string, unknown>, timezone: org.timezone }
}

/** settings.businessCalendar (BR-SLA-01) with the organization's time zone */
export async function readBusinessHours(ctx: Ctx): Promise<BusinessHoursDto> {
  const { settings, timezone } = await storedSettings(ctx)
  const calendar = OrgSettingsSchema.shape.businessCalendar.parse(settings.businessCalendar)
  return { workdays: calendar.workdays as Weekday[], start: calendar.start, end: calendar.end, timezone }
}

/** Holidays on or after `fromDate` (YYYY-MM-DD), oldest first */
export async function listHolidays(ctx: Ctx, fromDate: string): Promise<HolidayDto[]> {
  const rows = await forTenant(ctx.organizationId).holiday.findMany({
    where: { date: { gte: new Date(`${fromDate}T00:00:00Z`) } },
    orderBy: { date: 'asc' },
    select: { date: true, nameTh: true },
  })
  return rows.map((h) => ({ date: dateKey(h.date), nameTh: h.nameTh }))
}

/** settings.numbering (OQ-12): the pattern and reset period of each numbered document */
export async function readNumberingRules(ctx: Ctx): Promise<NumberingRules> {
  const { settings } = await storedSettings(ctx)
  return OrgSettingsSchema.shape.numbering.parse(settings.numbering)
}

/** The next value of one numbering scope, or null when nothing was issued in it yet (BR-NUM-03) */
export async function nextSequenceValue(ctx: Ctx, documentType: string, scopeKey: string): Promise<number | null> {
  const row = await forTenant(ctx.organizationId).documentSequence.findFirst({ where: { documentType, scopeKey }, select: { nextValue: true } })
  return row?.nextValue ?? null
}

/** Codes of the departments that can be charged, for the {DEPT} part of a number */
export async function departmentCodes(ctx: Ctx): Promise<string[]> {
  const rows = await forTenant(ctx.organizationId).department.findMany({ where: { active: true }, select: { code: true }, orderBy: { code: 'asc' } })
  return rows.map((d) => d.code)
}

/**
 * Numbers already issued in the uniqueness domain of a document type that start with one of the given prefixes and end
 * with its suffix (the fixed texts around the running number of a pattern): PR and RQ share Request.number (unique per
 * organization), so both read request numbers. The filter runs in the database, so a check never loads every number of
 * the organization. PO and GR documents arrive in S4; until then nothing carries those numbers.
 * TODO(S4-01): read PurchaseOrder.number for PO and GoodsReceipt.number for GR once the tables exist.
 */
export async function issuedDocumentNumbers(ctx: Ctx, document: NumberedDocumentCode, around: ReadonlyArray<{ readonly prefix: string; readonly suffix: string }>): Promise<string[]> {
  if ((document !== 'PR' && document !== 'RQ') || around.length === 0) return []
  const rows = await forTenant(ctx.organizationId).request.findMany({
    where: { OR: around.map((a) => ({ number: { startsWith: a.prefix, endsWith: a.suffix } })) },
    select: { number: true },
  })
  return rows.flatMap((r) => (r.number ? [r.number] : []))
}

export interface RequestTypeRowDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly descriptionTh: string | null
  readonly documentType: 'PURCHASE_REQUEST' | 'SUPPLIER_REQUEST'
  readonly active: boolean
  readonly sortOrder: number
  readonly currentFormVersionId: string | null
  readonly currentVersionNo: number | null
}

/** Request types in catalog order (FR-INT-001): sortOrder, then code */
export async function listRequestTypeRows(ctx: Ctx): Promise<RequestTypeRowDto[]> {
  const rows = await forTenant(ctx.organizationId).requestType.findMany({
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: {
      id: true,
      code: true,
      nameTh: true,
      nameEn: true,
      descriptionTh: true,
      documentType: true,
      active: true,
      sortOrder: true,
      currentFormVersionId: true,
      currentFormVersion: { select: { versionNo: true } },
    },
  })
  return rows.map(({ currentFormVersion, ...r }) => ({ ...r, currentVersionNo: currentFormVersion?.versionNo ?? null }))
}

export interface FormVersionRowDto {
  readonly id: string
  readonly versionNo: number
  readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'
  readonly publishedAt: string | null
  readonly publishedByName: string | null
  /** Requests made with this version (FR-ADM-005 AC3: they keep it) */
  readonly requestCount: number
  readonly schema: unknown
}

/** Every form version of one request type, newest first */
export async function listFormVersionRows(ctx: Ctx, requestTypeId: string): Promise<FormVersionRowDto[]> {
  const db = forTenant(ctx.organizationId)
  const versions = await db.formVersion.findMany({
    where: { requestTypeId },
    orderBy: { versionNo: 'desc' },
    select: { id: true, versionNo: true, status: true, publishedAt: true, publishedById: true, schema: true },
  })
  const [counts, publishers] = await Promise.all([
    db.request.groupBy({ by: ['formVersionId'], where: { requestTypeId }, _count: { _all: true } }),
    db.member.findMany({ where: { id: { in: versions.flatMap((v) => (v.publishedById ? [v.publishedById] : [])) } }, select: { id: true, displayNameTh: true } }),
  ])
  const countOf = new Map(counts.map((c) => [c.formVersionId, c._count._all]))
  const nameOf = new Map(publishers.map((m) => [m.id, m.displayNameTh]))
  return versions.map((v) => ({
    id: v.id,
    versionNo: v.versionNo,
    status: v.status,
    publishedAt: v.publishedAt?.toISOString() ?? null,
    publishedByName: v.publishedById ? (nameOf.get(v.publishedById) ?? null) : null,
    requestCount: countOf.get(v.id) ?? 0,
    schema: v.schema,
  }))
}

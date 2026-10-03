import type { DelegationSnapshot, DelegationStatus, DoaDocumentType, OrgSnapshot, RoutePolicy } from '@/core/doa'
import type { BusinessCalendar, Weekday } from '@/core/sla'
import { OrgSettingsSchema } from '@/lib/org-settings'
import type { TenantTx } from '@/server/db/tenant'
import { orgSnapshotFromRows, versionSnapshotFromRows } from './snapshot'

// What the DOA and SLA engines need from one organization, read inside the caller's transaction (spec §7.4, §7.8):
// every version that is or was in effect with its rules, the organization structure with position holders over time,
// the delegations that can still apply, and the business calendar with its holidays.

/** Versions in effect at some time (PUBLISHED or SUPERSEDED); drafts and withdrawn versions never route anything. */
const ROUTING_STATUSES = ['PUBLISHED', 'SUPERSEDED'] as const
const LIVE_DELEGATIONS = ['SCHEDULED', 'ACTIVE'] as const

export async function loadOrgSnapshot(tx: TenantTx): Promise<OrgSnapshot> {
  const [departments, holders, members] = await Promise.all([
    tx.department.findMany({ select: { id: true, code: true, nameTh: true, parentId: true } }),
    tx.positionAssignment.findMany({ select: { departmentId: true, memberId: true, validFrom: true, validTo: true, position: { select: { code: true } } } }),
    tx.member.findMany({ select: { id: true, displayNameTh: true, status: true } }),
  ])
  return orgSnapshotFromRows({
    departments,
    holders: holders.map((h) => ({ positionCode: h.position.code, departmentId: h.departmentId, memberId: h.memberId, validFrom: h.validFrom, validTo: h.validTo })),
    members,
  })
}

export async function loadDelegations(tx: TenantTx): Promise<DelegationSnapshot[]> {
  const rows = await tx.delegation.findMany({ where: { status: { in: [...LIVE_DELEGATIONS] }, revokedAt: null } })
  return rows.map((d) => ({
    id: d.id,
    delegatorMemberId: d.delegatorMemberId,
    delegateMemberId: d.delegateMemberId,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    documentTypes: d.documentTypes.length ? (d.documentTypes as DoaDocumentType[]) : null,
    maxAmountSatang: d.maxAmountSatang,
    status: d.status as DelegationStatus,
  }))
}

export async function loadRoutePolicy(tx: TenantTx): Promise<RoutePolicy> {
  const versions = await tx.doaVersion.findMany({ where: { status: { in: [...ROUTING_STATUSES] } }, include: { rules: true } })
  const [org, delegations] = await Promise.all([loadOrgSnapshot(tx), loadDelegations(tx)])
  return { versions: versions.map((v) => versionSnapshotFromRows(v, v.rules)), org, delegations }
}

/** settings.businessCalendar with the organization's time zone and holidays (BR-SLA-01). */
export async function loadBusinessCalendar(tx: TenantTx, organizationId: string): Promise<BusinessCalendar> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true, timezone: true } })
  const settings = org.settings as { businessCalendar?: unknown } | null
  const calendar = OrgSettingsSchema.shape.businessCalendar.parse(settings?.businessCalendar)
  const holidays = await tx.holiday.findMany({ select: { date: true } })
  return {
    timezone: org.timezone,
    workdays: calendar.workdays as Weekday[],
    start: calendar.start,
    end: calendar.end,
    holidays: holidays.map((h) => h.date.toISOString().slice(0, 10)),
  }
}

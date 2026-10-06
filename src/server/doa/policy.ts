import type { DelegationSnapshot, DelegationStatus, DoaDocumentType, OrgSnapshot, RoutePolicy } from '@/core/doa'
import type { BusinessCalendar, Weekday } from '@/core/sla'
import type { SodPolicy } from '@/core/sod'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { escapeLike } from '@/server/db/like'
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

/**
 * Whether the DOA relies on this member now (BR-AUTH-07, BR-DOA-17): they hold a position that a rule of a version in
 * effect or awaiting approval names, a rule names them as approver, or they have an open approval task. Such a member's
 * identity and positions change only through an ORG_AUTHORITY_CHANGE.
 */
export async function reliedOnByDoa(tx: TenantTx, memberId: string, now: Date): Promise<boolean> {
  if (await tx.approvalTask.count({ where: { assigneeMemberId: memberId, status: { in: ['OPEN', 'INFO_REQUESTED'] } } })) return true
  const named = await doaNamedApprovers(tx, now)
  if (named.members.has(memberId)) return true
  const held = await tx.positionAssignment.findMany({
    where: { memberId, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { position: { select: { code: true } } },
  })
  return held.some((h) => named.positions.has(h.position.code))
}

/** Position codes and members the rules of versions in effect, to come, or awaiting approval name as approvers. */
export async function doaNamedApprovers(tx: TenantTx, now: Date): Promise<{ positions: Set<string>; members: Set<string> }> {
  const versions = await tx.doaVersion.findMany({
    where: { OR: [{ status: 'PENDING_APPROVAL' }, { status: 'PUBLISHED', OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }] },
    include: { rules: true },
  })
  const positions = new Set<string>()
  const members = new Set<string>()
  for (const v of versions) {
    for (const rule of versionSnapshotFromRows(v, v.rules).rules) {
      for (const step of rule.steps) {
        if (step.approver.kind === 'MEMBER') members.add(step.approver.memberId)
        else positions.add(step.approver.position)
      }
    }
  }
  return { positions, members }
}

/**
 * Whether a position carries authority now (BR-DOA-17): a DOA version in effect, to come or awaiting approval names it,
 * or open approval tasks came from it — from a slot of this very position: a `_` of its code matches itself only, never
 * another position (escapeLike). Its holders change only through an ORG_AUTHORITY_CHANGE.
 */
export async function positionHasAuthority(tx: TenantTx, positionCode: string, now: Date): Promise<boolean> {
  if ((await doaNamedApprovers(tx, now)).positions.has(positionCode)) return true
  const open = await tx.approvalTask.count({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, resolvedFrom: { startsWith: escapeLike(`POSITION:${positionCode}@`) } } })
  return open > 0
}

/**
 * Open approval tasks of documents routed under this version (BR-DOA-13): they keep that version's route to the end,
 * so the page that approves a new version shows how many are still waiting under the one it replaces. The approval of
 * a DOA version itself is not counted.
 */
export async function openTasksUnderVersion(tx: TenantTx, versionId: string): Promise<number> {
  return tx.approvalTask.count({
    where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { doaVersionId: versionId, status: 'ACTIVE', subjectType: { not: 'DOA_VERSION' } } } },
  })
}

/**
 * The separation-of-duties policy of the DOA version in effect at `now` (BR-SOD-02, BR-SOD-07, OQ-04): who may receive
 * goods. Without a version in effect the defaults of the spec apply (approvers may not, requesters may).
 */
export async function effectiveSodPolicy(tx: TenantTx, now: Date): Promise<SodPolicy> {
  const version = await tx.doaVersion.findFirst({
    where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { sodPolicy: true },
  })
  return (version?.sodPolicy as unknown as SodPolicy | undefined) ?? { approverMayReceive: false, requesterMayReceive: true }
}

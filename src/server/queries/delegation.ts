import type { DoaDocumentType } from '@/core/doa'
import { satangToAmount } from '@/core/money/dto'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'

// Read-only data of the delegation page (NEW-06, FR-DOA-006 AC2, §7.6): the delegations a member gave and received,
// the members they may choose as delegate, and the positions that give them authority to delegate. Every query reads
// the given member's own rows; src/server/services/delegations/view.ts checks delegation.manage first.

export interface DelegationPersonDto {
  readonly id: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export interface DelegationRowDto {
  readonly id: string
  readonly delegator: DelegationPersonDto
  readonly delegate: DelegationPersonDto
  /** [startsAt, endsAt) as ISO 8601 UTC */
  readonly startsAt: string
  readonly endsAt: string
  /** Empty = every document type the delegator's positions approve (BR-DLG-01) */
  readonly documentTypes: readonly DoaDocumentType[]
  /** Baht with two decimals ("10000.00"), or null for no cap */
  readonly maxAmount: string | null
  readonly reason: string
  readonly status: 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'REVOKED'
  readonly createdVia: 'SELF' | 'ORG_AUTHORITY_CHANGE'
  readonly revokedAt: string | null
}

const PERSON = { select: { id: true, displayNameTh: true, displayNameEn: true } } as const

type Row = {
  id: string
  startsAt: Date
  endsAt: Date
  documentTypes: string[]
  maxAmountSatang: bigint | null
  reason: string
  status: DelegationRowDto['status']
  createdVia: DelegationRowDto['createdVia']
  revokedAt: Date | null
  delegator: { id: string; displayNameTh: string; displayNameEn: string | null }
  delegate: { id: string; displayNameTh: string; displayNameEn: string | null }
}

const person = (m: Row['delegator']): DelegationPersonDto => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn })

function toDto(r: Row): DelegationRowDto {
  return {
    id: r.id,
    delegator: person(r.delegator),
    delegate: person(r.delegate),
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    documentTypes: r.documentTypes as DoaDocumentType[],
    maxAmount: r.maxAmountSatang === null ? null : satangToAmount(r.maxAmountSatang),
    reason: r.reason,
    status: r.status,
    createdVia: r.createdVia,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  }
}

const SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  documentTypes: true,
  maxAmountSatang: true,
  reason: true,
  status: true,
  createdVia: true,
  revokedAt: true,
  delegator: PERSON,
  delegate: PERSON,
} as const

/** Delegations the member set (or that were set for them), latest start first */
export async function listDelegationsGiven(ctx: Ctx, memberId: string): Promise<DelegationRowDto[]> {
  const rows = await forTenant(ctx.organizationId).delegation.findMany({ where: { delegatorMemberId: memberId }, orderBy: [{ startsAt: 'desc' }, { id: 'asc' }], select: SELECT })
  return rows.map(toDto)
}

/** Delegations naming the member as delegate that still run or will run, earliest start first */
export async function listDelegationsReceived(ctx: Ctx, memberId: string, now: Date): Promise<DelegationRowDto[]> {
  const rows = await forTenant(ctx.organizationId).delegation.findMany({
    where: { delegateMemberId: memberId, status: { in: ['SCHEDULED', 'ACTIVE'] }, endsAt: { gt: now } },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    select: SELECT,
  })
  return rows.map(toDto)
}

export interface DelegateCandidateDto extends DelegationPersonDto {
  readonly departmentTh: string | null
  readonly departmentEn: string | null
}

/** Active members other than the delegator (BR-DLG-03: the delegate is active and not the delegator), by Thai name */
export async function listDelegateCandidates(ctx: Ctx, memberId: string): Promise<DelegateCandidateDto[]> {
  const rows = await forTenant(ctx.organizationId).member.findMany({
    where: { status: 'ACTIVE', id: { not: memberId } },
    select: { id: true, displayNameTh: true, displayNameEn: true, primaryDepartment: { select: { nameTh: true, nameEn: true } } },
  })
  return rows
    .map((m) => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn, departmentTh: m.primaryDepartment?.nameTh ?? null, departmentEn: m.primaryDepartment?.nameEn ?? null }))
    .sort((a, b) => a.nameTh.localeCompare(b.nameTh, 'th'))
}

export interface HeldPositionDto {
  readonly positionTh: string
  readonly positionEn: string | null
  readonly departmentTh: string
  readonly departmentEn: string | null
  /** ISO 8601, or null while held without an end */
  readonly validTo: string | null
}

/** Positions the member holds now or will hold: the authority they can delegate (BR-DLG-01) */
export async function listHeldPositions(ctx: Ctx, memberId: string, now: Date): Promise<HeldPositionDto[]> {
  const rows = await forTenant(ctx.organizationId).positionAssignment.findMany({
    where: { memberId, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    orderBy: { validFrom: 'asc' },
    select: { validTo: true, position: { select: { nameTh: true, nameEn: true } }, department: { select: { nameTh: true, nameEn: true } } },
  })
  return rows.map((r) => ({ positionTh: r.position.nameTh, positionEn: r.position.nameEn, departmentTh: r.department.nameTh, departmentEn: r.department.nameEn, validTo: r.validTo?.toISOString() ?? null }))
}

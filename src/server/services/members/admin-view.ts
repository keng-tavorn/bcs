import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import { STORED_ROLES, type StoredRole } from '@/server/authz/permissions'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { buildMemberImportTemplate, type ImportColumn, type ImportTemplateGuide } from './import'

// The member list of /admin/members (FR-ADM-001). Reading it needs admin.members too (BR-AUTH-05).

export interface AdminMemberDto {
  readonly id: string
  readonly displayNameTh: string
  readonly displayNameEn: string | null
  readonly email: string
  readonly employeeCode: string | null
  readonly status: 'INVITED' | 'ACTIVE' | 'DEACTIVATED'
  readonly roles: StoredRole[]
  readonly isSelf: boolean
}

const STATUS_ORDER = { ACTIVE: 0, INVITED: 1, DEACTIVATED: 2 } as const

const MEMBER_SELECT = {
  id: true,
  displayNameTh: true,
  displayNameEn: true,
  email: true,
  employeeCode: true,
  status: true,
  roleAssignments: { where: { revokedAt: null }, select: { role: true } },
} as const

type MemberRow = {
  id: string
  displayNameTh: string
  displayNameEn: string | null
  email: string
  employeeCode: string | null
  status: AdminMemberDto['status']
  roleAssignments: Array<{ role: string }>
}

function toDto(m: MemberRow, selfId: string | null): AdminMemberDto {
  return {
    id: m.id,
    displayNameTh: m.displayNameTh,
    displayNameEn: m.displayNameEn,
    email: m.email,
    employeeCode: m.employeeCode,
    status: m.status,
    roles: STORED_ROLES.filter((r) => m.roleAssignments.some((a) => a.role === r)),
    isSelf: m.id === selfId,
  }
}

async function allowAdmin(ctx: Ctx): Promise<Result<true>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.members'))
  return allowed.ok ? ok(true) : err(allowed.error.code, allowed.error.message, allowed.error.details)
}

export async function listMembersForAdmin(ctx: Ctx): Promise<Result<AdminMemberDto[]>> {
  const allowed = await allowAdmin(ctx)
  if (!allowed.ok) return allowed
  const members = await forTenant(ctx.organizationId).member.findMany({ select: MEMBER_SELECT })
  const selfId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  return ok(
    members
      .map((m) => toDto(m, selfId))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.displayNameTh.localeCompare(b.displayNameTh, 'th')),
  )
}

/** The Excel template of the member import (FR-ADM-001 AC3), for admins only like the rest of /admin/members. */
export async function memberImportTemplate(ctx: Ctx, labels: Record<ImportColumn, string>, guide?: ImportTemplateGuide): Promise<Result<Buffer>> {
  const allowed = await allowAdmin(ctx)
  if (!allowed.ok) return allowed
  return ok(await buildMemberImportTemplate(labels, guide))
}

/** One member for /admin/members/[memberId]; NOT_FOUND for an id outside the organization. */
export async function getMemberForAdmin(ctx: Ctx, memberId: string): Promise<Result<AdminMemberDto>> {
  const allowed = await allowAdmin(ctx)
  if (!allowed.ok) return allowed
  if (!z.uuid().safeParse(memberId).success) return err('NOT_FOUND', 'member not found')
  const member = await forTenant(ctx.organizationId).member.findFirst({ where: { id: memberId }, select: MEMBER_SELECT })
  if (!member) return err('NOT_FOUND', 'member not found')
  return ok(toDto(member, ctx.actor.type === 'USER' ? ctx.actor.memberId : null))
}

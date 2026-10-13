import type { StoredRole } from '@/server/authz/permissions'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { doaAdminSeparated } from '@/server/doa/policy'
import type { NotificationDraft } from '@/server/notifications/create'
import type { CommandFailure } from '../_pipeline'

// S6-09 (FR-ADM-101 · BR-WF-16 · BR-WF-17 · OQ-109): the rules of the role DOA_ADMIN that every way of giving a role
// follows (the member's page, an invitation, an import of members):
//   - nobody gives DOA_ADMIN to themselves (SOD_VIOLATION)
//   - once a DOA version in effect, or published to take effect, separates the DOA administrators, nobody holds both
//     DOA_ADMIN and ORG_ADMIN (SOD_VIOLATION): otherwise two ORG_ADMINs give it to each other and the separation is a label
//   - every AUDITOR hears at once that DOA_ADMIN was given or taken (template audit.policy_changed)

const blocked = (ctx: Ctx, memberId: string, rule: string, reason: string, message: string): CommandFailure => ({
  ok: false,
  error: { code: 'SOD_VIOLATION', message, details: { field: 'role', reason, rule } },
  ...(ctx.actor.type === 'USER'
    ? { auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: memberId, data: { rule, action: 'member.grant_role', subjectType: 'MEMBER', subjectId: memberId, actorMemberId: ctx.actor.memberId } }] }
    : {}),
})

/** Why `adding` may not be given to the member on top of the roles they hold; null when it may */
export async function roleGrantRefusal(tx: TenantTx, ctx: Ctx, memberId: string, adding: readonly StoredRole[], holding: ReadonlySet<string>): Promise<CommandFailure | null> {
  if (adding.includes('DOA_ADMIN') && ctx.actor.type === 'USER' && ctx.actor.memberId === memberId) {
    return blocked(ctx, memberId, 'BR-WF-16', 'SELF_GRANT', 'nobody gives DOA_ADMIN to themselves')
  }
  const after = new Set<string>([...holding, ...adding])
  if (!after.has('DOA_ADMIN') || !after.has('ORG_ADMIN') || !adding.some((r) => r === 'DOA_ADMIN' || r === 'ORG_ADMIN')) return null
  if (!(await doaAdminSeparated(tx, ctx.now, { scheduled: true }))) return null
  return blocked(ctx, memberId, 'BR-WF-17', 'ADMIN_ROLES_COMBINED', 'the DOA administrators are separated: nobody holds both DOA_ADMIN and ORG_ADMIN')
}

/** BR-WF-16: whether taking DOA_ADMIN from the member leaves the separated DOA without any active DOA_ADMIN */
export async function lastDoaAdmin(tx: TenantTx, ctx: Ctx, memberId: string): Promise<boolean> {
  if (!(await doaAdminSeparated(tx, ctx.now, { scheduled: true }))) return false
  const others = await tx.roleAssignment.count({ where: { role: 'DOA_ADMIN', revokedAt: null, memberId: { not: memberId }, member: { status: 'ACTIVE' } } })
  return others === 0
}

/** BR-WF-16 (§10.1): every active AUDITOR is told at once that DOA_ADMIN was given to or taken from the member */
export async function doaAdminNotices(tx: TenantTx, memberId: string, change: 'GRANTED' | 'REVOKED', at: Date): Promise<NotificationDraft[]> {
  const [auditors, member] = await Promise.all([
    tx.roleAssignment.findMany({ where: { role: 'AUDITOR', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } }),
    tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { displayNameTh: true } }),
  ])
  return [...new Set(auditors.map((a) => a.memberId))].map((recipientMemberId) => ({
    recipientMemberId,
    templateKey: 'audit.policy_changed',
    data: { change: change === 'GRANTED' ? 'DOA_ADMIN_GRANTED' : 'DOA_ADMIN_REVOKED', memberId, name: member.displayNameTh },
    urgency: 'IMMEDIATE',
    dedupeKey: `audit.policy_changed:DOA_ADMIN_${change}:${memberId}:${at.toISOString()}:${recipientMemberId}`,
    subjectType: 'MEMBER',
    subjectId: memberId,
  }))
}

import { MS_PER_MINUTE } from '@/lib/constants'
import { supplierSettingsOf } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// What keeps the SUPPLIER module on (BR-SUP ข้อ 16 · OQ-33 · §4.11 rule 4): an application not yet APPROVED, REJECTED,
// EXPIRED or CANCELLED, and a portal session still open (not revoked, before its absolute end, seen within
// supplier.sessionIdleMinutes · BR-PORTAL ข้อ 03). An application is named
// by its number, or by its id before the first submit gives it one; sessions are counted, never named (a contact's
// e-mail is personal data and the platform team does not need it).

const CLOSED_APPLICATION = ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const
const LISTED = 20

export async function openSupplierDocuments(tx: TenantTx, ctx: Ctx): Promise<string[]> {
  const applications = await tx.supplierApplication.findMany({
    where: { status: { notIn: [...CLOSED_APPLICATION] } },
    orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
    take: LISTED,
    select: { id: true, number: true },
  })
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const idleSince = new Date(ctx.now.getTime() - supplierSettingsOf(org.settings).sessionIdleMinutes * MS_PER_MINUTE)
  const sessions = await tx.portalSession.count({ where: { revokedAt: null, expiresAt: { gt: ctx.now }, lastSeenAt: { gt: idleSince } } })
  return [...applications.map((a) => a.number ?? a.id), ...(sessions ? [`PORTAL_SESSIONS:${sessions}`] : [])]
}

import { toJsonSafe } from '@/lib/json'
import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'

// Gives an organization an Express layout for a test (tests/support/express-layout.ts). The settings command
// (organization.save_settings) saves only the sections §2.4 gives a capability to — the business calendar and numbering
// (NEW-12) — and none covers the Express layout, which an organization gets from the inputs file at seed time (S4-09).
// So a test writes it here as the command would: under the same row lock, with the whole settings checked by
// OrgSettingsSchema like every save (FR-PLT-001 AC2), and nothing else of the settings changed.

export async function setExpressLayout(organizationId: string, express: OrgSettings['express']): Promise<void> {
  await forTenant(organizationId).$transaction(async (tx) => {
    await lockRowsForUpdate(tx, 'Organization', organizationId, [organizationId])
    const row = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
    const settings = OrgSettingsSchema.parse({ ...(row.settings as Record<string, unknown>), express })
    await tx.organization.update({ where: { id: organizationId }, data: { settings: toJsonSafe(settings) as object } })
  })
}

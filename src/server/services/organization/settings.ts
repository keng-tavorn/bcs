import { z } from 'zod'
import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Capability } from '@/server/authz/permissions'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { toJsonSafe } from '@/lib/json'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Save one section of Organization.settings (spec §6.2, FR-PLT-001 AC2). The whole settings object must pass
// OrgSettingsSchema after the change, otherwise VALIDATION_FAILED and the stored value stays as it was. Only sections
// with a capability in §2.4 can be saved: the business calendar (admin.calendar) and numbering (admin.numbering).

const SECTION_CAPABILITY = {
  businessCalendar: 'admin.calendar',
  numbering: 'admin.numbering',
} as const satisfies Partial<Record<keyof OrgSettings, Capability>>

type Section = keyof typeof SECTION_CAPABILITY
const SECTIONS = Object.keys(SECTION_CAPABILITY) as [Section, ...Section[]]

const SaveSettingsInput = z.object({ section: z.enum(SECTIONS), value: z.unknown() })

export const saveOrgSettingsCommand = defineCommand({
  name: 'organization.save_settings',
  // Declared for the command registry; execute() authorizes the capability of the section being saved
  capability: 'admin.calendar',
  input: SaveSettingsInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ section: Section }>> {
    const allowed = await authorize(tx, ctx, SECTION_CAPABILITY[input.section])
    if (!allowed.ok) return { ok: false, error: allowed.error }
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const current = (org.settings ?? {}) as Record<string, unknown>
    const parsed = OrgSettingsSchema.safeParse({ ...current, [input.section]: input.value })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = ['settings', ...(issue?.path ?? [input.section]).map(String)].join('.')
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: `invalid settings at ${field}`, details: { field } } }
    }
    await tx.organization.update({ where: { id: ctx.organizationId }, data: { settings: toJsonSafe(parsed.data) as object } })
    return {
      ok: true,
      result: { section: input.section },
      events: [{ type: 'organization.settings_updated', aggregateType: 'Organization', aggregateId: ctx.organizationId, data: { section: input.section } }],
    }
  },
})

export function saveOrgSettings(ctx: Ctx, input: z.input<typeof SaveSettingsInput>, options: RunOptions) {
  return runCommand(ctx, saveOrgSettingsCommand, input, options)
}

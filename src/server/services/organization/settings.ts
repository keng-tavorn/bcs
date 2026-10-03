import { z } from 'zod'
import { patternProblems } from '@/core/numbering'
import { OrgSettingsSchema, type OrgSettings } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Capability } from '@/server/authz/permissions'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { toJsonSafe } from '@/lib/json'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { NUMBERED_DOCUMENTS, numberingChangeRefusal, txNumberingReader } from '../numbering/admin'

// Save one section of Organization.settings (spec §6.2, FR-PLT-001 AC2). The whole settings object must pass
// OrgSettingsSchema after the change, otherwise VALIDATION_FAILED and the stored value stays as it was. Only sections
// with a capability in §2.4 can be saved: the business calendar (admin.calendar) and numbering (admin.numbering).

const SECTION_CAPABILITY = {
  businessCalendar: 'admin.calendar',
  numbering: 'admin.numbering',
} as const satisfies Partial<Record<keyof OrgSettings, Capability>>

type Section = keyof typeof SECTION_CAPABILITY
const SECTIONS = Object.keys(SECTION_CAPABILITY) as [Section, ...Section[]]

const SaveSettingsInput = z.object({
  section: z.enum(SECTIONS),
  value: z.unknown(),
  /**
   * Numbering only: `value` is the rule of this one document, merged into the section as stored after the row lock.
   * Two admins saving different documents at the same time then never put back each other's rule, which a section
   * read before the command (outside the lock) could do.
   */
  document: z.enum(NUMBERED_DOCUMENTS).optional(),
})

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

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
    let value = input.value
    if (input.document !== undefined) {
      if (input.section !== 'numbering') return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'a document rule belongs to the numbering section', details: { field: 'document' } } }
      value = { ...(isRecord(current.numbering) ? current.numbering : {}), [input.document]: input.value }
    }
    const parsed = OrgSettingsSchema.safeParse({ ...current, [input.section]: value })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = ['settings', ...(issue?.path ?? [input.section]).map(String)].join('.')
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: `invalid settings at ${field}`, details: { field } } }
    }
    // BR-NUM-02: a number pattern uses known tokens and exactly one {SEQn}, so a typo never prints into a document number
    if (input.section === 'numbering') {
      // FR-ADM-004 AC2–AC3 (INV-NUM-01): a changed rule repeats no number of an earlier period, scope or document; the
      // refusal names the reason so the screen can say what to fix
      const before = OrgSettingsSchema.shape.numbering.safeParse(current.numbering)
      const refused = await numberingChangeRefusal(txNumberingReader(tx), before.success ? before.data : null, parsed.data.numbering, ctx.now)
      if (refused) {
        const field = `settings.numbering.${refused.document}.pattern`
        return { ok: false, error: { code: 'VALIDATION_FAILED', message: `number rule refused at ${field}: ${refused.refusal.reason}`, details: { field, ...refused.refusal } } }
      }
      for (const [document, rule] of Object.entries(parsed.data.numbering)) {
        if (patternProblems(rule.pattern).length) {
          const field = `settings.numbering.${document}.pattern`
          return { ok: false, error: { code: 'VALIDATION_FAILED', message: `invalid number pattern at ${field}`, details: { field } } }
        }
      }
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

import { z } from 'zod'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { sandboxSettingsOf } from '@/lib/uat'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { isActivePlatformAdmin } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { insertSandboxOrganization } from '@/server/db/sql/sandbox'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// A UAT sandbox of a customer (S6-21 · FR-PLT-101 AC1 · BR-UAT-01 BR-UAT-04 · ADR-110 · OQ-108): the BCS team makes,
// under the customer's contract, an empty organization of kind SANDBOX that belongs to the production one — the same
// legal entity, production's settings (the configuration a sandbox is there to try — numbering, calendar, e-mail
// sender — with LINE off), the CORE module on. Nothing else is copied from production: no structure, position, member,
// DOA, workflow or document, and the command has no way to ask for it (NG-12). The
// customer's ORG_ADMIN sets the sandbox up as a new tenant (BR-DOA-19), tries configurations there, exports them and
// imports them into production as drafts (config-packages). LINE is off in a sandbox, its e-mails start with "[UAT]"
// and every page shows that it is a trial system.

const SandboxInput = z.strictObject({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
  contractRef: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(3).max(REASON_MAX_LENGTH),
})

const fail = (code: 'VALIDATION_FAILED' | 'FORBIDDEN', message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

export const createSandboxCommand = defineCommand({
  name: 'organization.create_sandbox',
  capability: 'platform.sandbox.manage',
  input: SandboxInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ sandboxOrganizationId: string }>> {
    if (ctx.actor.type !== 'PLATFORM_ADMIN' || !(await isActivePlatformAdmin(ctx.actor.platformAdminId))) return fail('FORBIDDEN', 'only the BCS team makes a sandbox')
    const allowed = await authorize(tx, ctx, 'platform.sandbox.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const production = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { kind: true, legalNameTh: true, taxId: true, branchCode: true, timezone: true, settings: true } })
    if (production.kind !== 'PRODUCTION') return fail('VALIDATION_FAILED', 'a sandbox belongs to a production organization', { reason: 'NOT_PRODUCTION' })
    const id = newId()
    const created = await insertSandboxOrganization(tx, {
      id,
      code: input.code,
      legalNameTh: production.legalNameTh,
      taxId: production.taxId,
      branchCode: production.branchCode,
      timezone: production.timezone,
      settings: sandboxSettingsOf(OrgSettingsSchema.parse(production.settings)),
      sandboxOfOrganizationId: ctx.organizationId,
      platformAdminId: ctx.actor.platformAdminId,
      contractRef: input.contractRef,
      reason: input.reason,
      now: ctx.now,
    })
    if (created === 'CODE_TAKEN') return fail('VALIDATION_FAILED', 'the organization code is taken', { field: 'code', reason: 'CODE_TAKEN' })
    // The reason stays as a Comment the event points to (§4.11 rule 1), on the production organization
    const reason = await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'Organization', subjectId: ctx.organizationId, authorMemberId: null, body: input.reason }, select: { id: true } })
    return {
      ok: true,
      result: { sandboxOrganizationId: id },
      events: [{ type: 'organization.sandbox_created', aggregateType: 'Organization', aggregateId: ctx.organizationId, data: { sandboxOrganizationId: id, code: input.code, contractRef: input.contractRef, reasonCommentId: reason.id } }],
    }
  },
})

export function createSandbox(ctx: Ctx, input: z.input<typeof SandboxInput>, options: RunOptions) {
  return runCommand(ctx, createSandboxCommand, input, options)
}

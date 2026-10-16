import { z } from 'zod'
import { moduleRequiredDocumentTypes, type DoaDocumentType } from '@/core/doa'
import { checkModuleChange, MODULES, type Module } from '@/core/modules'
import { err, ok, type Result } from '@/core/result'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { isActivePlatformAdmin } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { openInvoiceNumbers } from '../ap/track'
import { openPaymentDocuments } from '../payments/runs'

// Modules (spec §4.11, FR-PLT-011, FR-ADM-006 AC1, BR-AUTH-08, ADR-034). Only the BCS team switches modules, with a
// contract reference and a reason, at /platform/tenants/[orgId]/modules; ORG_ADMIN sees the state at /admin/modules
// and is told at once. Switching off never deletes data: menus hide and commands of the module are refused.

// ---------- gate used by every service of an optional module ----------

/** MODULE_DISABLED unless the organization has the module switched on. CORE is always on. */
export async function requireModule(ctx: Ctx, module: Module, tx?: TenantTx): Promise<Result<true>> {
  if (module === 'CORE') return ok(true)
  const db = tx ?? forTenant(ctx.organizationId)
  const row = await db.orgModule.findFirst({ where: { module, enabled: true }, select: { id: true } })
  return row ? ok(true) : err('MODULE_DISABLED', `module ${module} is switched off`, { module })
}

/** The modules switched on (CORE always): what lint makes required (BR-DOA-23). Read inside the caller's transaction. */
export async function enabledModules(tx: TenantTx): Promise<Module[]> {
  const rows = await tx.orgModule.findMany({ where: { enabled: true }, select: { module: true } })
  return [...new Set<Module>(['CORE', ...rows.map((r) => r.module as Module)])].sort((a, b) => MODULES.indexOf(a) - MODULES.indexOf(b))
}

// ---------- DOA rules a module needs before it is switched on (rule 7, BR-DOA-24, ADR-067) ----------

export interface MissingModuleRules {
  readonly documentTypes: readonly DoaDocumentType[]
  /** Every version that lacks one; empty when the organization has no DOA in effect at all */
  readonly versions: readonly { readonly code: string; readonly versionNo: number }[]
}

/**
 * The document types the module requires that the DOA versions in effect, waiting to take effect, or waiting for
 * approval lack (none → null). An organization without a DOA in effect lacks them all. BCS never writes the rules
 * for the customer (NG-12): the customer publishes them, then the module is switched on.
 */
export async function missingModuleRules(tx: TenantTx, module: Module, now: Date): Promise<MissingModuleRules | null> {
  const required = moduleRequiredDocumentTypes(module)
  if (required.length === 0) return null
  const versions = await tx.doaVersion.findMany({
    where: { OR: [{ status: 'PUBLISHED', OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, { status: 'PENDING_APPROVAL' }] },
    select: { code: true, versionNo: true, status: true, effectiveFrom: true, rules: { select: { documentType: true } } },
    orderBy: [{ code: 'asc' }, { versionNo: 'asc' }],
  })
  const inEffect = versions.some((v) => v.status === 'PUBLISHED' && v.effectiveFrom.getTime() <= now.getTime())
  if (!inEffect) return { documentTypes: required, versions: [] }
  const missing = new Set<DoaDocumentType>()
  const lacking: { code: string; versionNo: number }[] = []
  for (const v of versions) {
    const has = new Set(v.rules.map((r) => r.documentType as DoaDocumentType))
    const gaps = required.filter((t) => !has.has(t))
    if (gaps.length === 0) continue
    gaps.forEach((t) => missing.add(t))
    lacking.push({ code: v.code, versionNo: v.versionNo })
  }
  return missing.size ? { documentTypes: required.filter((t) => missing.has(t)), versions: lacking } : null
}

// ---------- documents still open in a module (rule 4, OQ-33) ----------

/** Lists open documents of the module that must be closed before it can be switched off (e.g. "PR-2569-00012"). */
export type ModuleUsageCheck = (tx: TenantTx, ctx: Ctx) => Promise<string[]>
const usageChecks = new Map<Module, ModuleUsageCheck>()
// S8 (BR-IVC-06): PAY stays on while an invoice is not yet paid, rejected or cancelled; S9 (OQ-33): nor while a payment
// run or a bank account change is not finished
usageChecks.set('PAY', async (tx) => [...(await openInvoiceNumbers(tx)), ...(await openPaymentDocuments(tx))])

/** Each optional module registers its check when it is built (S7 onwards); tier 1 has none. */
export function registerModuleUsageCheck(module: Module, check: ModuleUsageCheck): void {
  usageChecks.set(module, check)
}

// ---------- switch a module on or off ----------

const SetModuleInput = z.object({
  module: z.enum(MODULES),
  enabled: z.boolean(),
  contractRef: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(3).max(REASON_MAX_LENGTH),
})

export const setModuleCommand = defineCommand({
  name: 'organization.set_module',
  capability: 'platform.modules.manage',
  input: SetModuleInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ module: Module; enabled: boolean }>> {
    if (ctx.actor.type !== 'PLATFORM_ADMIN' || !(await isActivePlatformAdmin(ctx.actor.platformAdminId))) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'only the BCS team switches modules' } }
    }
    const allowed = await authorize(tx, ctx, 'platform.modules.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // One module change at a time per organization, so two changes cannot both pass the dependency rules
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])

    const enabledNow = (await tx.orgModule.findMany({ where: { enabled: true }, select: { module: true } })).map((r) => r.module as Module)
    const refusal = checkModuleChange(input.module, input.enabled, enabledNow)
    if (refusal) {
      switch (refusal.code) {
        case 'CORE_ALWAYS_ON':
        case 'NO_CHANGE':
          return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'module change refused', details: { field: 'module', reason: refusal.code } } }
        case 'REQUIRES_DISABLED':
          return { ok: false, error: { code: 'MODULE_DISABLED', message: 'a required module is off', details: { module: refusal.missing[0], missing: refusal.missing } } }
        case 'REQUIRED_BY_ENABLED':
          return { ok: false, error: { code: 'MODULE_IN_USE', message: 'other modules depend on it', details: { reason: 'REQUIRED_BY', modules: refusal.dependents } } }
      }
    }
    if (input.enabled) {
      // Rule 7 (BR-DOA-24): every approval the module starts must find its DOA rule; the row lock above keeps a
      // doa.submit (which takes the same lock before reading the modules) from slipping in between
      const missing = await missingModuleRules(tx, input.module, ctx.now)
      if (missing) {
        return {
          ok: false,
          error: { code: 'DOA_NOT_CONFIGURED', message: 'the DOA lacks rules the module needs', details: { reason: 'MODULE_RULES_MISSING', module: input.module, ...missing } },
        }
      }
    }
    if (!input.enabled) {
      const open = (await usageChecks.get(input.module)?.(tx, ctx)) ?? []
      if (open.length) return { ok: false, error: { code: 'MODULE_IN_USE', message: 'documents are still open', details: { reason: 'OPEN_DOCUMENTS', documents: open } } }
    }

    const change = {
      enabled: input.enabled,
      ...(input.enabled ? { enabledAt: ctx.now } : { disabledAt: ctx.now }),
      changedByPlatformAdminId: ctx.actor.platformAdminId,
      contractRef: input.contractRef,
      reason: input.reason,
    }
    const existing = await tx.orgModule.findFirst({ where: { module: input.module }, select: { id: true } })
    if (existing) await tx.orgModule.update({ where: { id: existing.id }, data: change })
    else await tx.orgModule.create({ data: { organizationId: ctx.organizationId, module: input.module, ...change } })
    // The row keeps the latest reason only; each change's reason stays in a Comment that its event points to
    const reasonComment = await tx.comment.create({
      data: { organizationId: ctx.organizationId, subjectType: 'Organization', subjectId: ctx.organizationId, authorMemberId: null, body: input.reason },
      select: { id: true },
    })

    // Tell every active ORG_ADMIN at once (§4.11 rule 5, §10.1 admin.module_changed)
    const admins = await tx.roleAssignment.findMany({
      where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } },
      select: { memberId: true },
    })
    const notifications: NotificationDraft[] = [...new Set(admins.map((a) => a.memberId))].map((memberId) => ({
      recipientMemberId: memberId,
      templateKey: 'admin.module_changed',
      data: { module: input.module, enabled: input.enabled, contractRef: input.contractRef },
      urgency: 'IMMEDIATE',
      dedupeKey: `admin.module_changed:${input.module}:${ctx.requestId}:${memberId}`,
      subjectType: 'Organization',
      subjectId: ctx.organizationId,
    }))
    return {
      ok: true,
      result: { module: input.module, enabled: input.enabled },
      events: [
        {
          type: input.enabled ? 'organization.module_enabled' : 'organization.module_disabled',
          aggregateType: 'Organization',
          aggregateId: ctx.organizationId,
          data: { module: input.module, contractRef: input.contractRef, reasonCommentId: reasonComment.id },
        },
      ],
      notifications,
    }
  },
})

export function setModule(ctx: Ctx, input: z.input<typeof SetModuleInput>, options: RunOptions) {
  return runCommand(ctx, setModuleCommand, input, options)
}

// ---------- read: module state for /admin/modules and the platform page ----------

export interface ModuleStateDto {
  readonly module: Module
  readonly enabled: boolean
  readonly contractRef: string | null
  readonly changedAt: string | null
}

/** Every module with its state; ORG_ADMIN may look (admin.modules.view), the BCS team uses it before changing. */
export async function listModules(ctx: Ctx): Promise<Result<ModuleStateDto[]>> {
  const db = forTenant(ctx.organizationId)
  if (ctx.actor.type === 'PLATFORM_ADMIN') {
    if (!(await isActivePlatformAdmin(ctx.actor.platformAdminId))) return err('FORBIDDEN', 'only the BCS team')
  } else {
    const allowed = await db.$transaction((tx) => authorize(tx, ctx, 'admin.modules.view'))
    if (!allowed.ok) return allowed
  }
  const rows = await db.orgModule.findMany({ select: { module: true, enabled: true, contractRef: true, enabledAt: true, disabledAt: true } })
  const byModule = new Map(rows.map((r) => [r.module as Module, r]))
  return ok(
    MODULES.map((module) => {
      const row = byModule.get(module)
      const changedAt = row ? (row.enabled ? row.enabledAt : row.disabledAt) : null
      return { module, enabled: module === 'CORE' ? true : Boolean(row?.enabled), contractRef: row?.contractRef ?? null, changedAt: changedAt?.toISOString() ?? null }
    }),
  )
}

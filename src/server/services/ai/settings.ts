import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { AI_AGENTS, DEFAULT_MIN_CONFIDENCE_BP, LEVEL_OF_AGENT, type AiAgentName } from '@/lib/ai-config'
import { BP_WHOLE } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Switching agents on and off (BR-AI-05, BR-AI-24, docs/sub-specs/S13.md "ฐานของโมดูล" AC1): ORG_ADMIN at /admin/ai,
// one agent at a time, for new calls at once; a PENDING call finishes and a DRAFT can still be confirmed. Phase 1 sets
// L0 or L1 only. Switching an agent on or off tells every ORG_ADMIN (§10.1 admin.ai_agent_changed).

const UpdateAgentInput = z.strictObject({
  agent: z.enum(AI_AGENTS),
  enabled: z.boolean().optional(),
  level: z.enum(['L0', 'L1']).optional(),
  minConfidenceBp: z.number().int().min(0).max(BP_WHOLE).optional(),
  /** The version the screen showed (CONFLICT_VERSION when someone saved in between); absent for an agent with no row */
  expectedVersion: z.number().int().nonnegative().optional(),
})

/** Members who hold ORG_ADMIN now (the notices of the AI module go to them) */
export async function activeOrgAdminIds(tx: TenantTx): Promise<string[]> {
  const rows = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
  return [...new Set(rows.map((r) => r.memberId))].sort()
}

export const updateAgentCommand = defineCommand({
  name: 'ai_agent.update',
  capability: 'admin.ai.manage',
  input: UpdateAgentInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ agent: AiAgentName; enabled: boolean; version: number }>> {
    const allowed = await authorize(tx, ctx, 'admin.ai.manage')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    const existing = await tx.aiAgentSetting.findFirst({ where: { agent: input.agent }, select: { id: true, enabled: true, level: true, minConfidenceBp: true, version: true } })
    if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      return { ok: false, error: { code: 'CONFLICT_VERSION', message: 'the setting changed in between' } }
    }
    const before = existing ?? { enabled: false, level: LEVEL_OF_AGENT[input.agent], minConfidenceBp: DEFAULT_MIN_CONFIDENCE_BP, version: -1 }
    const after = {
      enabled: input.enabled ?? before.enabled,
      level: input.level ?? before.level,
      minConfidenceBp: input.minConfidenceBp ?? before.minConfidenceBp,
    }
    if (existing && after.enabled === before.enabled && after.level === before.level && after.minConfidenceBp === before.minConfidenceBp) {
      return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'nothing changed', details: { field: 'agent', reason: 'NO_CHANGE' } } }
    }
    const row = existing
      ? await tx.aiAgentSetting.update({ where: { id: existing.id }, data: { ...after, updatedById: memberId, version: { increment: 1 } }, select: { id: true, version: true } })
      : await tx.aiAgentSetting.create({ data: { organizationId: ctx.organizationId, agent: input.agent, ...after, updatedById: memberId }, select: { id: true, version: true } })

    const switched = after.enabled !== before.enabled
    const type = switched ? (after.enabled ? 'ai_agent.enabled' : 'ai_agent.disabled') : 'ai_agent.updated'
    const events: EventDraft[] = [{ type, aggregateType: 'AiAgentSetting', aggregateId: row.id, data: { agent: input.agent, ...after } }]
    const notifications: NotificationDraft[] = switched
      ? (await activeOrgAdminIds(tx)).map((recipient) => ({
          recipientMemberId: recipient,
          templateKey: 'admin.ai_agent_changed',
          data: { agent: input.agent, enabled: after.enabled },
          urgency: 'IMMEDIATE',
          dedupeKey: `admin.ai_agent_changed:${row.id}:${row.version}:${recipient}`,
          subjectType: 'Organization',
          subjectId: ctx.organizationId,
        }))
      : []
    return { ok: true, result: { agent: input.agent, enabled: after.enabled, version: row.version }, events, notifications }
  },
})

export function updateAgentSetting(ctx: Ctx, input: z.input<typeof UpdateAgentInput>, options: RunOptions) {
  return runCommand(ctx, updateAgentCommand, input, options)
}

export interface AgentSettingDto {
  readonly agent: AiAgentName
  readonly enabled: boolean
  readonly level: 'L0' | 'L1'
  readonly minConfidenceBp: number
  /** -1 for an agent that has no row yet (off) */
  readonly version: number
}

/** Every agent with its setting, for /admin/ai (admin.ai.manage) */
export async function listAgentSettings(ctx: Ctx): Promise<Result<AgentSettingDto[]>> {
  const db = forTenant(ctx.organizationId)
  return db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'admin.ai.manage')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const rows = await tx.aiAgentSetting.findMany({ select: { agent: true, enabled: true, level: true, minConfidenceBp: true, version: true } })
    const byAgent = new Map(rows.map((r) => [r.agent, r]))
    return ok(
      AI_AGENTS.map((agent) => {
        const r = byAgent.get(agent)
        return r
          ? { agent, enabled: r.enabled, level: r.level, minConfidenceBp: r.minConfidenceBp, version: r.version }
          : { agent, enabled: false, level: LEVEL_OF_AGENT[agent], minConfidenceBp: DEFAULT_MIN_CONFIDENCE_BP, version: -1 }
      }),
    )
  })
}

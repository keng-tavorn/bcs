import { newId } from '@/lib/ids'
import { toJsonSafe, type JsonValue } from '@/lib/json'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { getEventDefinition } from './registry'
import './schemas'

// Writes audit events inside the caller's transaction (spec §4.5, INV-EVT-02). Data is validated against the
// registered schema; unknown types and malformed data are programming errors and abort the transaction.

export interface EventDraft {
  readonly type: string
  readonly aggregateType: string
  readonly aggregateId: string
  readonly data: Record<string, unknown>
  readonly doaVersionId?: string
  readonly doaRuleCode?: string
  readonly onBehalfOfMemberId?: string
}

export interface AppendedEvent {
  readonly id: string
  readonly type: string
  readonly aggregateType: string
  readonly aggregateId: string
  readonly occurredAt: Date
  readonly data: JsonValue
}

export class EventSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EventSchemaError'
  }
}

function actorColumns(ctx: Ctx) {
  switch (ctx.actor.type) {
    case 'USER':
      return { actorType: 'USER' as const, actorMemberId: ctx.actor.memberId }
    case 'PLATFORM_ADMIN':
      return { actorType: 'PLATFORM_ADMIN' as const, actorPlatformAdminId: ctx.actor.platformAdminId }
    case 'AI_AGENT':
      return { actorType: 'AI_AGENT' as const, agentId: ctx.actor.agentId }
    case 'SUPPLIER':
      return { actorType: 'SUPPLIER' as const }
    case 'SYSTEM':
      return { actorType: 'SYSTEM' as const }
  }
}

export function validateEventDraft(draft: EventDraft): JsonValue {
  const def = getEventDefinition(draft.type)
  if (!def) throw new EventSchemaError(`event type "${draft.type}" has no schema in src/server/events/schemas`)
  if (def.aggregateType !== draft.aggregateType) {
    throw new EventSchemaError(`event "${draft.type}" belongs to ${def.aggregateType}, not ${draft.aggregateType}`)
  }
  if (def.requiresDoaRef && (!draft.doaVersionId || !draft.doaRuleCode)) {
    throw new EventSchemaError(`event "${draft.type}" must cite doaVersionId and doaRuleCode (INV-DOA-01)`)
  }
  const parsed = def.schema.safeParse(draft.data)
  if (!parsed.success) {
    throw new EventSchemaError(`event "${draft.type}" data does not match its schema: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`)
  }
  return toJsonSafe(parsed.data)
}

export async function appendEvents(tx: TenantTx, ctx: Ctx, drafts: readonly EventDraft[]): Promise<AppendedEvent[]> {
  const rows = drafts.map((draft) => {
    const def = getEventDefinition(draft.type)
    return {
      id: newId(),
      type: draft.type,
      aggregateType: draft.aggregateType,
      aggregateId: draft.aggregateId,
      occurredAt: ctx.now,
      ...actorColumns(ctx),
      ...(draft.onBehalfOfMemberId ? { onBehalfOfMemberId: draft.onBehalfOfMemberId } : {}),
      channel: ctx.channel,
      ...(draft.doaVersionId ? { doaVersionId: draft.doaVersionId } : {}),
      ...(draft.doaRuleCode ? { doaRuleCode: draft.doaRuleCode } : {}),
      correlationId: ctx.correlationId,
      ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
      requestId: ctx.requestId,
      data: validateEventDraft(draft) as object,
      schemaVersion: def?.schemaVersion ?? 1,
    }
  })
  if (rows.length) await tx.event.createMany({ data: rows.map((r) => ({ ...r, organizationId: ctx.organizationId })) })
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    occurredAt: r.occurredAt,
    data: r.data as JsonValue,
  }))
}

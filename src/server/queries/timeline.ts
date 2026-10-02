import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'

// Timeline of one document built from its Events (FR-PLT-003 AC3): who did what, through which channel,
// when, and under which DOA version and rule for approvals. The caller must already have checked that the
// actor may view the document (e.g. request.view) — this query only reads the document's own events.

export interface TimelineActorDto {
  readonly kind: 'MEMBER' | 'SYSTEM' | 'PLATFORM_ADMIN' | 'AI_AGENT' | 'SUPPLIER'
  readonly name: string | null
}

export interface TimelineEntryDto {
  readonly id: string
  readonly type: string
  readonly occurredAt: string
  readonly channel: string
  readonly actor: TimelineActorDto
  readonly onBehalfOf: string | null
  readonly doa: { readonly versionId: string; readonly ruleCode: string } | null
  readonly data: unknown
}

export async function getTimeline(ctx: Ctx, aggregateType: string, aggregateId: string): Promise<TimelineEntryDto[]> {
  const db = forTenant(ctx.organizationId)
  const events = await db.event.findMany({
    where: { aggregateType, aggregateId },
    orderBy: { seq: 'asc' },
  })
  const memberIds = [
    ...new Set(events.flatMap((e) => [e.actorMemberId, e.onBehalfOfMemberId]).filter((id): id is string => Boolean(id))),
  ]
  const members = memberIds.length
    ? await db.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, displayNameTh: true } })
    : []
  const nameOf = new Map(members.map((m) => [m.id, m.displayNameTh]))
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    occurredAt: e.occurredAt.toISOString(),
    channel: e.channel,
    actor: {
      kind: e.actorType === 'USER' ? 'MEMBER' : e.actorType,
      name: e.actorMemberId ? (nameOf.get(e.actorMemberId) ?? null) : null,
    },
    onBehalfOf: e.onBehalfOfMemberId ? (nameOf.get(e.onBehalfOfMemberId) ?? null) : null,
    doa: e.doaVersionId && e.doaRuleCode ? { versionId: e.doaVersionId, ruleCode: e.doaRuleCode } : null,
    data: e.data,
  }))
}

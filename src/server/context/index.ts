import { newId } from '@/lib/ids'

// Request context passed to every service and query (spec §4.3 step 3). `now` is business time from an
// injectable clock, so tests, the demo-history seed and e2e can control it.

export const CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const
export type Channel = (typeof CHANNELS)[number]

export type Actor =
  | { readonly type: 'USER'; readonly memberId: string }
  | { readonly type: 'SYSTEM'; readonly job?: string }
  | { readonly type: 'PLATFORM_ADMIN'; readonly platformAdminId: string }
  | { readonly type: 'AI_AGENT'; readonly agentId: string }
  | { readonly type: 'SUPPLIER'; readonly supplierContactId: string }

export interface Ctx {
  readonly organizationId: string
  readonly actor: Actor
  readonly channel: Channel
  /** HTTP request id (for tracing logs), not a Request document id */
  readonly requestId: string
  readonly now: Date
  readonly correlationId: string
  readonly causationId?: string
}

export function makeCtx(params: {
  organizationId: string
  actor: Actor
  channel: Channel
  now: Date
  requestId?: string
  correlationId?: string
  causationId?: string
}): Ctx {
  return {
    organizationId: params.organizationId,
    actor: params.actor,
    channel: params.channel,
    now: params.now,
    requestId: params.requestId ?? newId(),
    correlationId: params.correlationId ?? newId(),
    ...(params.causationId ? { causationId: params.causationId } : {}),
  }
}

export function systemCtx(organizationId: string, now: Date, job?: string): Ctx {
  return makeCtx({ organizationId, actor: job ? { type: 'SYSTEM', job } : { type: 'SYSTEM' }, channel: 'SYSTEM', now })
}

export function actorMemberId(ctx: Ctx): string | null {
  return ctx.actor.type === 'USER' ? ctx.actor.memberId : null
}

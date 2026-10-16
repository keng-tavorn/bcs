import { titleFromText } from '@/core/chat-intake'
import { err, ok, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'

// What LIFF shows of chat drafts (S17-07 · BR-LINE-12, BR-LINE-15 · FR-LINE-301 AC3 AC4 AC7): only the member who wrote
// them ever reads them — anyone else gets NOT_FOUND, as for a draft that does not exist — and reading never changes
// anything (a GET never makes a draft, BR-LINE-15). The text is shown as a reference until the sweep clears it.

export type ChatImageState = 'PENDING' | 'STORED' | 'FAILED'

export interface ChatIntakeView {
  readonly id: string
  readonly status: 'OPEN' | 'DRAFTED' | 'DISMISSED' | 'EXPIRED'
  /** What the member typed, joined; null when only photos came or after the sweep cleared it */
  readonly text: string | null
  readonly textTruncated: boolean
  readonly purged: boolean
  readonly messageCount: number
  readonly imageCount: number
  readonly lastMessageAt: string
  readonly expiresAt: string
  /** The request it became (DRAFTED) */
  readonly requestId: string | null
  /** The title the draft starts with: the first line of the text that is not blank (BR-LINE-12) */
  readonly proposedTitle: string
  readonly images: ReadonlyArray<{ readonly seq: number; readonly state: ChatImageState }>
}

export interface MyChatIntakeRow {
  readonly id: string
  readonly proposedTitle: string
  readonly messageCount: number
  readonly imageCount: number
  readonly lastMessageAt: string
}

const ownerOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

export async function getMyChatIntake(ctx: Ctx, intakeId: string): Promise<Result<ChatIntakeView>> {
  const memberId = ownerOf(ctx)
  if (!memberId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intakeId)) return err('NOT_FOUND', 'no such chat draft')
  const row = await forTenant(ctx.organizationId).chatIntake.findFirst({
    where: { id: intakeId, memberId, member: { status: 'ACTIVE' } },
    select: {
      id: true,
      status: true,
      text: true,
      textTruncated: true,
      purgedAt: true,
      messageCount: true,
      imageCount: true,
      lastMessageAt: true,
      expiresAt: true,
      requestId: true,
      items: { where: { kind: 'IMAGE' }, select: { seq: true, fetchStatus: true }, orderBy: { seq: 'asc' } },
    },
  })
  if (!row) return err('NOT_FOUND', 'no such chat draft')
  return ok({
    id: row.id,
    status: row.status,
    text: row.text,
    textTruncated: row.textTruncated,
    purged: row.purgedAt !== null,
    messageCount: row.messageCount,
    imageCount: row.imageCount,
    lastMessageAt: row.lastMessageAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    requestId: row.requestId,
    proposedTitle: titleFromText(row.text ?? ''),
    images: row.items.map((i) => ({ seq: i.seq, state: i.fetchStatus === 'NOT_NEEDED' ? 'FAILED' : i.fetchStatus })),
  })
}

/** The member's own OPEN chat drafts, newest first: /liff/requests/new offers them when opened without one (BR-LINE-15) */
export async function listMyOpenChatIntakes(ctx: Ctx, limit: number): Promise<MyChatIntakeRow[]> {
  const memberId = ownerOf(ctx)
  if (!memberId) return []
  const rows = await forTenant(ctx.organizationId).chatIntake.findMany({
    where: { memberId, status: 'OPEN' },
    select: { id: true, text: true, messageCount: true, imageCount: true, lastMessageAt: true },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: limit,
  })
  return rows.map((r) => ({ id: r.id, proposedTitle: titleFromText(r.text ?? ''), messageCount: r.messageCount, imageCount: r.imageCount, lastMessageAt: r.lastMessageAt.toISOString() }))
}

/** The chat draft a request of the member's own was made from (BR-LINE-12: its text stays a reference until purged) */
export async function chatIntakeIdOfRequest(ctx: Ctx, requestId: string): Promise<string | null> {
  const memberId = ownerOf(ctx)
  if (!memberId) return null
  const row = await forTenant(ctx.organizationId).chatIntake.findFirst({ where: { requestId, memberId }, select: { id: true } })
  return row?.id ?? null
}

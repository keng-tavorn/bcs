import { z } from 'zod'
import type { Result } from '@/core/result'
import type { Jsonified } from '@/lib/json'
import { authorize } from '@/server/authz'
import { actorMemberId, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { refusedCommand } from './refusals'
import { switchLineRichMenuNow } from './rich-menu'

// Ending a LINE link (FR-LINE-001 AC3, §9.2 step 4: from either side, with an event).
//  - The member ends their own (self.lineLink): from the workspace (/settings/line, channel WEB) or from LINE, in the
//    LIFF app (channel LIFF, signed in with the LINE ID token). There is no unlink button in the chat: it would be a
//    postback without an action token, which BR-TOK-02 does not allow.
//  - Deactivating the member ends it in the deactivation's transaction (FR-AUTH-003 AC2): the lineLink revoker of
//    src/server/services/members/revokers.ts.
//  - Blocking the account (unfollow) does not end it: it only stops pushes (BR-LINE-08, lineReachable).
// A code issued before the link ended no longer links (./link.ts): a QR shown or photographed earlier dies with it.
// The ChannelIdentity row is kept with unlinkedAt (the history of who was linked when). The member's unused LINE action
// tokens are revoked with it (S5 sub-spec row "ActionToken ของ LINE": the card buttons of an unlinked account no longer
// decide anything). Event line.unlinked per link ended. A LIFF session of the member ends at its next request (liff.ts
// checks the link every time), and the rich menu goes back to UNLINKED: at once after the commit, or by job
// line-rich-menu, which the event starts.

export type LineUnlinkReason = 'SELF' | 'MEMBER_DEACTIVATED'

interface EndedLinks {
  readonly identityIds: string[]
  readonly lineActionTokensRevoked: number
  readonly events: EventDraft[]
}

/** Ends the member's live LINE links (only `identityId` when given) and their unused LINE tokens, in the caller's tx. */
async function endLineLinks(tx: TenantTx, ctx: Ctx, memberId: string, reason: LineUnlinkReason, identityId?: string): Promise<EndedLinks> {
  const live = await tx.channelIdentity.findMany({
    where: { memberId, channel: 'LINE', unlinkedAt: null, ...(identityId ? { id: identityId } : {}) },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  if (live.length === 0) return { identityIds: [], lineActionTokensRevoked: 0, events: [] }
  const identityIds = live.map((l) => l.id)
  await tx.channelIdentity.updateMany({ where: { id: { in: identityIds }, unlinkedAt: null }, data: { unlinkedAt: ctx.now } })
  const tokens = await tx.actionToken.updateMany({ where: { memberId, channel: 'LINE', usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
  return {
    identityIds,
    lineActionTokensRevoked: tokens.count,
    events: identityIds.map((id) => ({ type: 'line.unlinked', aggregateType: 'ChannelIdentity', aggregateId: id, data: { memberId, reason } })),
  }
}

const UnlinkInput = z.strictObject({
  /** Only this link of the member (a screen that shows it); left out: the member's live link */
  identityId: z.uuid().optional(),
})

export interface LineUnlinkResult {
  readonly identityId: string
  readonly lineActionTokensRevoked: number
}

export const unlinkLineCommand = defineCommand({
  name: 'line.unlink',
  capability: 'self.lineLink',
  input: UnlinkInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<LineUnlinkResult>> {
    const memberId = actorMemberId(ctx)
    if (!memberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'a member unlinks their own LINE account' } }
    const allowed = await authorize(tx, ctx, 'self.lineLink', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // One change of the member's links at a time (the link command and a deactivation take the same row lock)
    await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [memberId])
    const ended = await endLineLinks(tx, ctx, memberId, 'SELF', input.identityId)
    const identityId = ended.identityIds[0]
    if (!identityId) return refusedCommand('NOT_LINKED')
    return { ok: true, result: { identityId, lineActionTokensRevoked: ended.lineActionTokensRevoked }, events: ended.events }
  },
})

/**
 * The member ends their own LINE link (self.lineLink) — from the workspace (ctx channel WEB) or the LIFF app (LIFF) —
 * then the rich menu goes back to UNLINKED. Input {} (or { identityId }). NOT_LINKED when there is no live link.
 */
export async function unlinkMyLine(ctx: Ctx, input: unknown, options: RunOptions): Promise<Result<Jsonified<LineUnlinkResult>>> {
  const result = await runCommand(ctx, unlinkLineCommand, input ?? {}, options)
  if (result.ok) await switchLineRichMenuNow(ctx.organizationId, result.data.identityId)
  return result
}

/**
 * The lineLink revoker of a deactivation (FR-AUTH-003 AC2, FR-LINE-001 AC3), in the deactivation's transaction: every
 * live LINE link of the member ends with line.unlinked (reason MEMBER_DEACTIVATED). The deactivate command holds the
 * member's row lock already. The rich menu follows in job line-rich-menu, after the commit.
 */
export async function unlinkLineOnDeactivation(tx: TenantTx, ctx: Ctx, memberId: string): Promise<{ readonly count: number; readonly events: readonly EventDraft[] }> {
  const ended = await endLineLinks(tx, ctx, memberId, 'MEMBER_DEACTIVATED')
  return { count: ended.identityIds.length, events: ended.events }
}

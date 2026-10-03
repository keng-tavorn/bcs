import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { ACTION_TOKEN_TTL_MS } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { newId } from '@/lib/ids'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'

// ActionTokens (spec §4.9): the buttons and links that decide an approval task outside the workspace. Each task gets
// one per (task × assignee × channel) when it is assigned, and its tokens are revoked the moment it is decided,
// cancelled or moved to someone else (BR-TOK-01). Both follow the task's own events in the command that assigns or
// closes it, so no way of assigning or closing a task can miss them; a token lives 72 hours at most.
// E-mail links are "/a/<tokenId>.<secret>" (BR-TOK-03): the secret is derived from the token id with the server key
// and only its sha256 is stored, so the database alone opens nothing and the e-mail can be written later by the
// delivery job. LINE tokens (BR-TOK-02) come with the LINE channel (S5).

/** What an e-mail link may do (§6.2 ActionToken.allowedActions) */
export const EMAIL_LINK_ACTIONS = ['APPROVE', 'REJECT'] as const
const SECRET_CONTEXT = 'bcs/action-token/email/v1/'
const LINK = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/

/** The secret of an e-mail token's link */
export function emailLinkSecret(tokenId: string): string {
  return createHmac('sha256', getEnv().BETTER_AUTH_SECRET).update(`${SECRET_CONTEXT}${tokenId}`).digest('base64url')
}

export const hashLinkSecret = (secret: string) => createHash('sha256').update(secret).digest('hex')

/** "/a/<tokenId>.<secret>" */
export const emailLinkPath = (tokenId: string) => `/a/${tokenId}.${emailLinkSecret(tokenId)}`

/** The token id and secret of "<tokenId>.<secret>", or null when it is not shaped like a link */
export function parseEmailLink(value: string): { tokenId: string; secret: string } | null {
  const m = LINK.exec(value)
  return m ? { tokenId: m[1]!, secret: m[2]! } : null
}

/** The secret opens the token (its sha256 matches, compared in constant time) */
export function linkSecretMatches(secret: string, storedHash: string | null): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false
  return timingSafeEqual(Buffer.from(hashLinkSecret(secret), 'hex'), Buffer.from(storedHash, 'hex'))
}

/**
 * BR-TOK-01 from a command's events, in its transaction: an e-mail token for every task assigned (or moved to a new
 * assignee), and every token of a task decided, cancelled or moved away revoked.
 */
export async function applyTokenLifecycle(tx: TenantTx, ctx: Ctx, events: readonly EventDraft[]): Promise<void> {
  const issue: Array<{ taskId: string; memberId: string }> = []
  const revoke = new Set<string>()
  for (const e of events) {
    const data = e.data as Record<string, unknown>
    if (e.type === 'approval_task.assigned' && typeof data.assigneeMemberId === 'string') issue.push({ taskId: e.aggregateId, memberId: data.assigneeMemberId })
    else if (e.type === 'approval_task.reassigned') {
      if (typeof data.toMemberId === 'string') issue.push({ taskId: e.aggregateId, memberId: data.toMemberId })
      if (typeof data.fromTaskId === 'string') revoke.add(data.fromTaskId)
    } else if (e.type === 'approval_task.decided' || e.type === 'approval_task.cancelled') revoke.add(e.aggregateId)
  }
  if (revoke.size) await tx.actionToken.updateMany({ where: { taskId: { in: [...revoke] }, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
  if (issue.length) {
    const expiresAt = new Date(ctx.now.getTime() + ACTION_TOKEN_TTL_MS)
    await tx.actionToken.createMany({
      data: issue.map(({ taskId, memberId }) => {
        const id = newId()
        return { id, organizationId: ctx.organizationId, memberId, taskId, allowedActions: [...EMAIL_LINK_ACTIONS], channel: 'EMAIL' as const, secretHash: hashLinkSecret(emailLinkSecret(id)), expiresAt }
      }),
    })
  }
}

/** A deactivated member's unused tokens (BR-AUTH-06) */
export async function revokeMemberTokens(tx: TenantTx, ctx: Ctx, memberId: string): Promise<number> {
  const { count } = await tx.actionToken.updateMany({ where: { memberId, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
  return count
}

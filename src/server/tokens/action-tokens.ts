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
// delivery job. LINE tokens (BR-TOK-02) are issued as well when the assignee is linked to LINE — a live
// ChannelIdentity under the provider of the organization's channel, and the channel switched on. They carry no secret:
// the card's postback holds only `v=1&a=approve&k=<tokenId>`, and what makes it safe is the signature of the webhook and
// the LINE user of the event, who must be linked to the member the token was issued to
// (src/server/services/approvals/line-postback.ts). Unlinking LINE revokes the member's LINE tokens (the unlink command
// of src/server/services/line-link).

/** What an e-mail link may do (§6.2 ActionToken.allowedActions) */
export const EMAIL_LINK_ACTIONS = ['APPROVE', 'REJECT'] as const
/** A reviewer's e-mail link passes only: a reviewer never rejects, and a return needs its reason (S6 · BR-WF-09) */
export const REVIEW_EMAIL_LINK_ACTIONS = ['APPROVE'] as const
/** What the card's button may do in the chat (§9.3): approve; a return or a rejection needs a reason, typed in LIFF */
export const LINE_BUTTON_ACTIONS = ['APPROVE'] as const
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
 * The members, of these, who can receive a LINE card: linked to LINE (a live ChannelIdentity) under the provider of the
 * organization's channel, while the channel is switched on (LineChannelConfig.active, the switch the webhook and LIFF
 * obey too). LINE user ids differ per provider (§9.2), so a link made under another provider does not count.
 */
async function membersOnLine(tx: TenantTx, memberIds: readonly string[]): Promise<Set<string>> {
  const channel = await tx.lineChannelConfig.findFirst({ select: { active: true, providerId: true } })
  if (!channel?.active) return new Set()
  const links = await tx.channelIdentity.findMany({
    where: { memberId: { in: [...new Set(memberIds)] }, channel: 'LINE', providerKey: channel.providerId, unlinkedAt: null },
    select: { memberId: true },
  })
  return new Set(links.map((l) => l.memberId))
}

/** Whether a document's tasks may be decided from the chat or an e-mail link (outsideChannels of the subject registry) */
export type SubjectChannelsOf = (tx: TenantTx, subjectType: string, subjectId: string) => Promise<{ readonly chatButton: boolean; readonly emailLink: boolean }>

/**
 * BR-TOK-01 from a command's events, in its transaction: for every task assigned (or moved to a new assignee) an e-mail
 * token, and a LINE token when the assignee is linked to LINE — none for a channel its subject keeps closed (BR-DOA-25:
 * no button, no link); every token of a task decided, cancelled or moved away revoked.
 */
export async function applyTokenLifecycle(tx: TenantTx, ctx: Ctx, events: readonly EventDraft[], channelsOf: SubjectChannelsOf): Promise<void> {
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
    const onLine = await membersOnLine(tx, issue.map((i) => i.memberId))
    const routes = await tx.approvalTask.findMany({ where: { id: { in: issue.map((i) => i.taskId) } }, select: { id: true, step: { select: { kind: true, route: { select: { subjectType: true, subjectId: true } } } } } })
    const channels = new Map<string, Awaited<ReturnType<SubjectChannelsOf>>>()
    const reviews = new Set(routes.filter((t) => t.step.kind === 'REVIEW').map((t) => t.id))
    for (const t of routes) channels.set(t.id, await channelsOf(tx, t.step.route.subjectType, t.step.route.subjectId))
    await tx.actionToken.createMany({
      data: issue.flatMap(({ taskId, memberId }) => {
        const open = channels.get(taskId) ?? { chatButton: false, emailLink: false }
        const id = newId()
        const email = { id, organizationId: ctx.organizationId, memberId, taskId, allowedActions: [...(reviews.has(taskId) ? REVIEW_EMAIL_LINK_ACTIONS : EMAIL_LINK_ACTIONS)], channel: 'EMAIL' as const, secretHash: hashLinkSecret(emailLinkSecret(id)), expiresAt }
        // BR-TOK-02: no secret; the postback is checked against the LINE user of the signed webhook
        const line = { id: newId(), organizationId: ctx.organizationId, memberId, taskId, allowedActions: [...LINE_BUTTON_ACTIONS], channel: 'LINE' as const, secretHash: null, expiresAt }
        return [...(open.emailLink ? [email] : []), ...(open.chatButton && onLine.has(memberId) ? [line] : [])]
      }),
    })
  }
}

/** A deactivated member's unused tokens (BR-AUTH-06) */
export async function revokeMemberTokens(tx: TenantTx, ctx: Ctx, memberId: string): Promise<number> {
  const { count } = await tx.actionToken.updateMany({ where: { memberId, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
  return count
}

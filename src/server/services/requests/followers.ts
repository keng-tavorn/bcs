import { z } from 'zod'
import { isAllowed, loadMemberPrincipals, loadPrincipal, type ResourceScope } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { memberRef, type MemberRefDto } from '@/server/queries/requests'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requestViewScope } from './view-scope'

// Followers of a request (FR-INT-013 AC1–AC3, §2.4 request.follow and request.followers.manage, NEW-29):
//  - whoever may view the request follows or stops following it themselves (request.follow); the requester does not
//    follow their own request;
//  - only the requester adds or removes others (request.followers.manage): the scope OWN passed here is the requester
//    alone, so a follower — who is OWN for request.view — never adds anybody (AC3);
//  - OQ-39 (default "no"): only a member who already has request.view of the request is added, so following never
//    widens who sees the request, its quotations or its files;
//  - every change writes request.follower_added or request.follower_removed (§10.2); the member the requester adds is
//    told (§10.1 request.follower_added). Followers then hear of the approval, the return and the rejection with the
//    requester (approvals/decide.ts, §10.1).

const fail = (code: 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION_FAILED' | 'INVALID_STATE_TRANSITION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** At most this many followers on one request */
export const MAX_FOLLOWERS = 50

interface FollowedRequest {
  readonly id: string
  readonly number: string | null
  readonly title: string
  readonly requesterMemberId: string
  readonly scope: ResourceScope
}

async function followedRequest(tx: TenantTx, requestId: string): Promise<FollowedRequest | null> {
  const [request, scope] = await Promise.all([
    tx.request.findFirst({ where: { id: requestId }, select: { id: true, number: true, title: true, requesterMemberId: true } }),
    requestViewScope(tx, requestId),
  ])
  return request && scope ? { ...request, scope } : null
}

const memberOf = (ctx: Ctx) => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

/** Adds the row unless it is there (a second add at the same moment adds nothing) and says whether it was added */
async function addRow(tx: TenantTx, ctx: Ctx, requestId: string, memberId: string): Promise<boolean> {
  const added = await tx.requestFollower.createMany({ data: [{ organizationId: ctx.organizationId, requestId, memberId }], skipDuplicates: true })
  return added.count > 0
}

async function removeRow(tx: TenantTx, requestId: string, memberId: string): Promise<boolean> {
  const removed = await tx.requestFollower.deleteMany({ where: { requestId, memberId } })
  return removed.count > 0
}

async function roomForOneMore(tx: TenantTx, requestId: string): Promise<boolean> {
  return (await tx.requestFollower.count({ where: { requestId } })) < MAX_FOLLOWERS
}

// ---------- follow or stop following, by oneself (request.follow) ----------

const SelfInput = z.strictObject({ requestId: z.uuid(), follow: z.boolean() })

export const followCommand = defineCommand({
  name: 'request.follow',
  capability: 'request.follow',
  input: SelfInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string; following: boolean }>> {
    const me = memberOf(ctx)
    const request = await followedRequest(tx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    if (!me || !isAllowed(await loadPrincipal(tx, ctx), 'request.follow', request.scope)) return fail('FORBIDDEN', 'missing capability request.follow', { capability: 'request.follow' })
    if (me === request.requesterMemberId) return fail('VALIDATION_FAILED', 'the requester does not follow their own request', { reason: 'REQUESTER' })
    if (input.follow) {
      if (!(await roomForOneMore(tx, request.id))) return fail('VALIDATION_FAILED', 'the request has as many followers as it may', { reason: 'TOO_MANY', max: MAX_FOLLOWERS })
      if (!(await addRow(tx, ctx, request.id, me))) return fail('INVALID_STATE_TRANSITION', 'already following', { reason: 'ALREADY_FOLLOWING' })
    } else if (!(await removeRow(tx, request.id, me))) {
      return fail('INVALID_STATE_TRANSITION', 'not following', { reason: 'NOT_FOLLOWING' })
    }
    return {
      ok: true,
      result: { requestId: request.id, following: input.follow },
      events: [{ type: input.follow ? 'request.follower_added' : 'request.follower_removed', aggregateType: 'Request', aggregateId: request.id, data: { memberId: me, by: 'SELF' } }],
    }
  },
})

export function followRequest(ctx: Ctx, input: z.input<typeof SelfInput>, options: RunOptions) {
  return runCommand(ctx, followCommand, input, options)
}

// ---------- add or remove someone else, by the requester (request.followers.manage) ----------

const ManageInput = z.strictObject({ requestId: z.uuid(), memberId: z.uuid(), follow: z.boolean() })

export const manageFollowersCommand = defineCommand({
  name: 'request.followers.manage',
  capability: 'request.followers.manage',
  input: ManageInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string; memberId: string; following: boolean }>> {
    const request = await followedRequest(tx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    // OWN is the requester alone here: a follower, though OWN for request.view, never manages followers (FR-INT-013 AC3)
    if (!isAllowed(await loadPrincipal(tx, ctx), 'request.followers.manage', { ownerMemberIds: [request.requesterMemberId] })) {
      return fail('FORBIDDEN', 'missing capability request.followers.manage', { capability: 'request.followers.manage' })
    }
    if (input.memberId === request.requesterMemberId) return fail('VALIDATION_FAILED', 'the requester does not follow their own request', { field: 'memberId', reason: 'REQUESTER' })
    if (input.follow) {
      // OQ-39: the member must already see the request (the same scope as request.view, before they follow it)
      const principal = (await loadMemberPrincipals(tx, [input.memberId], ctx.now)).get(input.memberId)!
      if (!isAllowed(principal, 'request.view', request.scope)) return fail('VALIDATION_FAILED', 'the member cannot view this request', { field: 'memberId', reason: 'CANNOT_VIEW' })
      if (!(await roomForOneMore(tx, request.id))) return fail('VALIDATION_FAILED', 'the request has as many followers as it may', { reason: 'TOO_MANY', max: MAX_FOLLOWERS })
      if (!(await addRow(tx, ctx, request.id, input.memberId))) return fail('INVALID_STATE_TRANSITION', 'already following', { reason: 'ALREADY_FOLLOWING' })
    } else if (!(await removeRow(tx, request.id, input.memberId))) {
      return fail('INVALID_STATE_TRANSITION', 'not following', { reason: 'NOT_FOLLOWING' })
    }
    return {
      ok: true,
      result: { requestId: request.id, memberId: input.memberId, following: input.follow },
      events: [{ type: input.follow ? 'request.follower_added' : 'request.follower_removed', aggregateType: 'Request', aggregateId: request.id, data: { memberId: input.memberId, by: 'REQUESTER' } }],
      // §10.1 request.follower_added: the member added is told; one notice per time they are added
      notifications: input.follow
        ? [
            {
              recipientMemberId: input.memberId,
              templateKey: 'request.follower_added',
              data: { requestId: request.id, number: request.number, title: request.title },
              urgency: 'IMMEDIATE',
              dedupeKey: `request.follower_added:${request.id}:${input.memberId}:${ctx.now.toISOString()}`,
              subjectType: 'REQUEST',
              subjectId: request.id,
            },
          ]
        : [],
    }
  },
})

export function manageFollowers(ctx: Ctx, input: z.input<typeof ManageInput>, options: RunOptions) {
  return runCommand(ctx, manageFollowersCommand, input, options)
}

// ---------- who follows, for the request page ----------

export interface RequestFollowersDto {
  readonly followers: readonly MemberRefDto[]
  /** The viewer follows the request */
  readonly following: boolean
  /** The viewer may follow or stop following (request.follow): not the requester */
  readonly canFollow: boolean
  /** The viewer is the requester (request.followers.manage) */
  readonly canManage: boolean
  /** For the requester only: the active members who already see the request and do not follow it (OQ-39) */
  readonly candidates: readonly MemberRefDto[]
}

const byName = (a: MemberRefDto, b: MemberRefDto) => a.name.th.localeCompare(b.name.th, 'th')

/** The followers of a request and what the viewer may do about them; null when the viewer may not view it */
export async function getRequestFollowers(ctx: Ctx, requestId: string): Promise<RequestFollowersDto | null> {
  if (!z.uuid().safeParse(requestId).success) return null
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const me = memberOf(ctx)
    const request = await followedRequest(tx, requestId)
    if (!request || !me) return null
    const principal = await loadPrincipal(tx, ctx)
    if (!isAllowed(principal, 'request.view', request.scope)) return null
    const rows = await tx.requestFollower.findMany({
      where: { requestId },
      select: { member: { select: { id: true, displayNameTh: true, displayNameEn: true } } },
      orderBy: { createdAt: 'asc' },
    })
    const followers = rows.map((r) => memberRef(r.member))
    const canManage = isAllowed(principal, 'request.followers.manage', { ownerMemberIds: [request.requesterMemberId] })
    let candidates: MemberRefDto[] = []
    if (canManage) {
      const taken = new Set([request.requesterMemberId, ...followers.map((f) => f.id)])
      const active = await tx.member.findMany({ where: { status: 'ACTIVE', id: { notIn: [...taken] } }, select: { id: true, displayNameTh: true, displayNameEn: true } })
      const principals = await loadMemberPrincipals(tx, active.map((m) => m.id), ctx.now)
      candidates = active.filter((m) => isAllowed(principals.get(m.id)!, 'request.view', request.scope)).map(memberRef).sort(byName)
    }
    return {
      followers,
      following: followers.some((f) => f.id === me),
      canFollow: me !== request.requesterMemberId && isAllowed(principal, 'request.follow', request.scope),
      canManage,
      candidates,
    }
  })
}

import { z } from 'zod'
import { stepUpNeeded } from '@/core/pin'
import { err } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { approvePostbackHandler } from '@/server/line/postback-approve'
import { registerLinePostbackHandler } from '@/server/line/webhook'
import { defineCommand, runCommand, type CommandFailure, type CommandOutcome, type RunOptions } from '../_pipeline'
import { decideCommand } from './decide'
import { deciderDetails, lockForDecision, tokenRefusalOf } from './step-complete'
import { outsideChannels } from './subjects'

// Deciding from the approve button of a LINE card (spec §9.3, BR-TOK-02, BR-TOK-04, BR-TOK-05, INV-TOK-01, FR-LINE-002
// AC2 AC3) — the e-mail link's path (action-link.ts) for a postback. The actor is the member linked to the LINE user of
// the signed webhook (src/server/line/postback-approve.ts builds the ctx on channel LINE_CHAT); a LINE user linked to
// nobody acts as the system job line-postback, so the refusal is still recorded. In one transaction:
//  - the token must be a LINE token, issued to the actor: anyone else is refused FORBIDDEN, kept as
//    security.token_misuse although nothing else is written;
//  - a decision that needs a step-up (the amount the DOA counted at or above the version's stepUpThreshold, and every
//    subject of ALWAYS_STEP_UP_SUBJECTS) is refused STEP_UP_REQUIRED, and so is a task whose subject keeps the chat
//    closed (its adapter's channels, BR-DOA-25) — the card shows no approve button for either, and the server says no
//    again;
//  - the task is locked first, with the other open tasks of its step in one ascending-id lock (lockForDecision,
//    step-complete.ts, INV-PLT-03), then the token is used by one conditional update. Every deciding path takes that
//    lock first — the workspace's and LIFF's decisions and the e-mail link's — so a decision anywhere at the same
//    moment, on this task or on the other task of an escalated step, waits instead of deadlocking and then finds the
//    task decided or cancelled: still one decision (tested). When the conditional update does not take one row the
//    answer says why, as the e-mail link's does (tokenRefusalOf, step-complete.ts, ADR-050 item 4):
//    decided already (TOKEN_USED, with who decided and when — §9.3 "ดำเนินการแล้วโดย … เมื่อ …" — whether with this
//    button or anywhere else, and also when the other task of the step was decided first: the co-assignee of an
//    escalated step, BR-SLA-04, or the task moved to a delegate who decided it), revoked (TOKEN_INVALID: moved or
//    cancelled with nothing decided) or expired (TOKEN_EXPIRED);
//  - the decision itself is the workspace's command (decideCommand), so the event approval_task.decided names the
//    channel LINE_CHAT with the DOA version and rule (FR-DOA-005 AC1). A refusal of that command rolls the token use back.
// The module registers the `approve` action with the webhook's dispatcher when it is loaded; src/server/jobs/line-webhook.ts
// imports it, so the webhook route and the line-webhook job both know it.

const LinePostbackInput = z.strictObject({ tokenId: z.uuid() })

const refused = (code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED', message: string, taskId?: string): CommandFailure => ({
  ok: false,
  error: { code, message, ...(taskId ? { details: { taskId } } : {}) },
})

/** Why the token could not be used now, read again after the conditional update took no row (tokenRefusalOf) */
async function tokenRefusal(tx: TenantTx, tokenId: string, taskId: string): Promise<CommandFailure> {
  const why = await tokenRefusalOf(tx, tokenId)
  if (why.code === 'TOKEN_USED') return { ok: false, error: { code: 'TOKEN_USED', message: 'the task was decided already', details: { taskId, ...deciderDetails(why.decision) } } }
  if (why.code === 'TOKEN_INVALID') return refused('TOKEN_INVALID', 'the button was revoked: the task moved or was cancelled', taskId)
  return refused('TOKEN_EXPIRED', 'the button has expired', taskId)
}

export const decideByLinePostbackCommand = defineCommand({
  name: 'approval.decide_by_line',
  capability: 'approval.decide',
  input: LinePostbackInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ taskId: string; documentStatus: string }>> {
    const token = await tx.actionToken.findFirst({ where: { id: input.tokenId } })
    if (!token || token.channel !== 'LINE') return refused('TOKEN_INVALID', 'the button is not valid')
    // BR-TOK-02: the member linked to the LINE user who tapped must be the member the card was sent to
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (actor !== token.memberId) {
      return {
        ok: false,
        error: { code: 'FORBIDDEN', message: 'the button was sent to someone else' },
        auditEvents: [{ type: 'security.token_misuse', aggregateType: 'Security', aggregateId: token.id, data: { tokenId: token.id, channel: 'LINE', taskId: token.taskId, actorMemberId: actor } }],
      }
    }
    if (!token.allowedActions.includes('APPROVE')) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the button cannot approve', details: { field: 'action' } } }
    if (!(await lockForDecision(tx, ctx.organizationId, token.taskId))) return refused('TOKEN_INVALID', 'the task is gone')
    const task = await tx.approvalTask.findUniqueOrThrow({
      where: { id: token.taskId },
      select: { step: { select: { kind: true, route: { select: { subjectType: true, subjectId: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
    })
    const route = task.step.route
    // BR-TOK-05, BR-DOA-25: approved in LIFF with the PIN, never from the chat; a reviewer passes from the chat (BR-WF-09)
    const stepUp = stepUpNeeded({ subjectType: route.subjectType, amountSatang: route.amountSatang, stepUpThresholdSatang: route.doaVersion.stepUpThresholdSatang, stepKind: task.step.kind })
    if (stepUp || !(await outsideChannels(tx, route.subjectType, route.subjectId)).chatButton) {
      return { ok: false, error: { code: 'STEP_UP_REQUIRED', message: 'this task is approved with the PIN in LIFF', details: { taskId: token.taskId } } }
    }
    // BR-TOK-04: one conditional update uses the token; INV-TOK-01 follows, since a second use finds usedAt set
    const used = await tx.actionToken.updateMany({ where: { id: token.id, usedAt: null, revokedAt: null, expiresAt: { gt: ctx.now } }, data: { usedAt: ctx.now } })
    if (used.count !== 1) return tokenRefusal(tx, token.id, token.taskId)
    return decideCommand.execute(tx, { taskId: token.taskId, decision: 'APPROVE' }, ctx)
  },
})

/** The ctx must carry channel LINE_CHAT: the decision event records the channel (FR-LINE-002 AC2, FR-DOA-005 AC1) */
export function decideByLinePostback(ctx: Ctx, input: z.input<typeof LinePostbackInput>, options: RunOptions) {
  if (ctx.channel !== 'LINE_CHAT') return Promise.resolve(err('VALIDATION_FAILED', 'a LINE button decides on the LINE_CHAT channel', { field: 'channel' }))
  return runCommand(ctx, decideByLinePostbackCommand, input, options)
}

registerLinePostbackHandler('approve', approvePostbackHandler(decideByLinePostback))

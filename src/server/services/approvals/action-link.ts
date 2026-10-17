import { z } from 'zod'
import { formatSatang } from '@/core/money/format'
import { stepUpNeeded } from '@/core/pin'
import { err, ok, type ErrorCode, type Result } from '@/core/result'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { linkSecretMatches, parseEmailLink } from '@/server/tokens/action-tokens'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { decideCommand } from './decide'
import { deciderDetails, lockForDecision, tokenRefusalOf } from './step-complete'
import { outsideChannels } from './subjects'

// Deciding from an e-mail link (spec BR-TOK-03, BR-TOK-04, INV-TOK-01, FR-NOTI-002 AC2). Opening the link only shows
// the task — a GET changes nothing, because an e-mail scanner may open it. The decision is a POST by the member the
// link was sent to, signed in unless the organization turned email.actionLinksRequireLogin off. The token is used by
// one conditional update in the same transaction as the decision, so a link decides at most once; a link that is
// used, expired, revoked or someone else's is refused with its reason, and someone else's is kept as
// security.token_misuse before anything about the task is said. A link whose task was decided — with it or anywhere
// else, or by the other approver of its step — answers TOKEN_USED with who decided and when, as the LINE button does
// (§9.3, FR-DOA-004 AC2, ADR-050 item 4). Anything needing a step-up (stepUpNeeded: the subjects of
// ALWAYS_STEP_UP_SUBJECTS, or the amount at or above the version's stepUpThreshold) and any subject whose adapter keeps
// the e-mail closed (BR-DOA-25) is decided in the workspace, where the second factor is asked.

type LinkError = Extract<ErrorCode, 'TOKEN_INVALID' | 'TOKEN_USED' | 'TOKEN_EXPIRED'>
const tokenError = (code: LinkError, message: string) => ({ ok: false, error: { code, message } }) as const

/** A token found by its link: the secret must open it and it must be an e-mail token */
async function tokenOf(db: TenantTx | ReturnType<typeof forTenant>, link: string) {
  const parsed = parseEmailLink(link)
  if (!parsed) return null
  const token = await db.actionToken.findFirst({ where: { id: parsed.tokenId } })
  return token && token.channel === 'EMAIL' && linkSecretMatches(parsed.secret, token.secretHash) ? token : null
}

/** Why a token cannot be used now, or null when it can */
function unusable(token: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): LinkError | null {
  if (token.usedAt) return 'TOKEN_USED'
  if (token.revokedAt) return 'TOKEN_INVALID'
  return token.expiresAt.getTime() > now.getTime() ? null : 'TOKEN_EXPIRED'
}

// ---------- open the link (GET) ----------

export type ActionLinkView =
  | {
      readonly state: 'OPEN'
      readonly taskId: string
      readonly subjectType: string
      readonly subjectId: string
      /** The document's number, or its title before it has one */
      readonly label: string
      readonly title: string | null
      readonly requester: string | null
      /** Baht with two decimals, the amount the DOA counted */
      readonly amount: string | null
      readonly actions: readonly string[]
      /** Policy tasks and step-up decisions are made in the workspace */
      readonly inWorkspaceOnly: boolean
      readonly expiresAt: string
    }
  | { readonly state: 'CLOSED'; readonly taskId: string; readonly subjectType: string; readonly subjectId: string; readonly label: string }
  | { readonly state: LinkError | 'NOT_YOURS' }

type LinkRoute = { readonly subjectType: string; readonly subjectId: string; readonly amountSatang: bigint | null; readonly doaVersion: { readonly stepUpThresholdSatang: bigint | null } }

/**
 * Decided in the workspace only: a step-up is needed — never for a reviewer, whatever the amount (BR-WF-09, as
 * decideCommand) — or the subject keeps the e-mail link closed
 */
async function workspaceOnly(db: TenantTx | ReturnType<typeof forTenant>, step: { readonly kind: string; readonly route: LinkRoute }): Promise<boolean> {
  const route = step.route
  if (step.kind !== 'REVIEW' && stepUpNeeded({ subjectType: route.subjectType, amountSatang: route.amountSatang, stepUpThresholdSatang: route.doaVersion.stepUpThresholdSatang })) return true
  return !(await outsideChannels(db as TenantTx, route.subjectType, route.subjectId)).emailLink
}

/** What the link is about, for the member who opened it. Reads only. */
export async function viewActionLink(ctx: Ctx, link: string): Promise<Result<ActionLinkView>> {
  const db = forTenant(ctx.organizationId)
  const token = await tokenOf(db, link)
  if (!token) return ok({ state: 'TOKEN_INVALID' })
  const viewer = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (viewer !== token.memberId) return ok({ state: 'NOT_YOURS' })
  const task = await db.approvalTask.findUniqueOrThrow({
    where: { id: token.taskId },
    select: { id: true, status: true, step: { select: { kind: true, route: { select: { subjectType: true, subjectId: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
  })
  const route = task.step.route
  const subject = await subjectSummary(db, route.subjectType, route.subjectId)
  const why = unusable(token, ctx.now)
  if (task.status !== 'OPEN') return ok({ state: 'CLOSED', taskId: task.id, subjectType: route.subjectType, subjectId: route.subjectId, label: subject.label })
  if (why) return ok({ state: why })
  return ok({
    state: 'OPEN',
    taskId: task.id,
    subjectType: route.subjectType,
    subjectId: route.subjectId,
    ...subject,
    amount: route.amountSatang === null ? null : formatSatang(route.amountSatang),
    actions: token.allowedActions,
    inWorkspaceOnly: await workspaceOnly(db, task.step),
    expiresAt: token.expiresAt.toISOString(),
  })
}

async function subjectSummary(db: ReturnType<typeof forTenant>, subjectType: string, subjectId: string): Promise<{ label: string; title: string | null; requester: string | null }> {
  if (subjectType === 'REQUEST') {
    const r = await db.request.findUniqueOrThrow({ where: { id: subjectId }, select: { number: true, title: true, requester: { select: { displayNameTh: true } } } })
    return { label: r.number ?? r.title, title: r.title, requester: r.requester.displayNameTh }
  }
  if (subjectType === 'PURCHASE_ORDER') {
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: subjectId }, select: { number: true, supplier: { select: { nameTh: true } } } })
    return { label: po.number ?? '', title: po.supplier.nameTh, requester: null }
  }
  if (subjectType === 'VARIANCE') {
    const v = await db.variance.findUniqueOrThrow({ where: { id: subjectId }, select: { type: true, po: { select: { number: true } } } })
    return { label: v.po.number ?? '', title: v.type, requester: null }
  }
  return { label: subjectType, title: null, requester: null }
}

// ---------- decide (POST) ----------

const LinkDecideInput = z.strictObject({
  link: z.string().min(1).max(200),
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
})

export const decideByLinkCommand = defineCommand({
  name: 'approval.decide_by_link',
  capability: 'approval.decide',
  input: LinkDecideInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ taskId: string; documentStatus: string }>> {
    const token = await tokenOf(tx, input.link)
    if (!token) return tokenError('TOKEN_INVALID', 'the link is not valid')
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (actor !== token.memberId) {
      return {
        ok: false,
        error: { code: 'TOKEN_INVALID', message: 'the link was sent to someone else' },
        auditEvents: [{ type: 'security.token_misuse', aggregateType: 'Security', aggregateId: token.id, data: { tokenId: token.id, channel: 'EMAIL', taskId: token.taskId, actorMemberId: actor } }],
      }
    }
    if (!token.allowedActions.includes(input.decision)) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the link cannot make this decision', details: { field: 'decision' } } }
    // Every deciding path locks the task with the other open tasks of its step before anything else (lockForDecision,
    // INV-PLT-03; the LINE postback and decideTask do too), so an e-mail link, a chat button and the workspace pressed
    // together — on this task or on the other task of an escalated step — wait for each other instead of deadlocking
    if (!(await lockForDecision(tx, ctx.organizationId, token.taskId))) return tokenError('TOKEN_INVALID', 'the task is gone')
    const route = await tx.approvalTask.findUniqueOrThrow({
      where: { id: token.taskId },
      select: { step: { select: { kind: true, route: { select: { subjectType: true, subjectId: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
    })
    if (await workspaceOnly(tx, route.step)) {
      return { ok: false, error: { code: 'STEP_UP_REQUIRED', message: 'this task is decided in the workspace with a second factor', details: { taskId: token.taskId } } }
    }
    // BR-TOK-04: one conditional update uses the token; when it does not, the reason is read again (another POST may
    // have used it while this one waited). §14.2 TOKEN_USED says who decided and when whenever the task was decided —
    // with this link, on the web, in LIFF or from the chat — or closed by the decision of another task of its step (the
    // other approver of an escalated step decided first, BR-SLA-04, or a delegate decided the task it moved to), as the
    // LINE button answers (tokenRefusalOf, FR-DOA-004 AC2, §9.3); TOKEN_INVALID only when it was revoked with nothing
    // decided
    const used = await tx.actionToken.updateMany({ where: { id: token.id, usedAt: null, revokedAt: null, expiresAt: { gt: ctx.now } }, data: { usedAt: ctx.now } })
    if (used.count !== 1) {
      const why = await tokenRefusalOf(tx, token.id)
      if (why.code === 'TOKEN_USED') return { ok: false, error: { code: 'TOKEN_USED', message: 'the task was decided already', details: deciderDetails(why.decision) } }
      return why.code === 'TOKEN_EXPIRED' ? tokenError(why.code, 'the link has expired') : tokenError(why.code, 'the link was revoked')
    }
    return decideCommand.execute(tx, { taskId: token.taskId, decision: input.decision, ...(input.reason ? { reason: input.reason } : {}) }, ctx)
  },
})

/** The ctx must carry channel EMAIL: the decision event records the channel (FR-DOA-005 AC1) */
export function decideByActionLink(ctx: Ctx, input: z.input<typeof LinkDecideInput>, options: RunOptions) {
  if (ctx.channel !== 'EMAIL') return Promise.resolve(err('VALIDATION_FAILED', 'an e-mail link decides on the EMAIL channel', { field: 'channel' }))
  return runCommand(ctx, decideByLinkCommand, input, options)
}

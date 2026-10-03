'use server'

import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { actionLinkCsrfMatches, actionLinkOwner } from '@/server/auth/action-links'
import { decideByActionLink } from '@/server/services/approvals/action-link'
import type { ActionLinkOutcome } from '@/ui/approvals/action-link-form'
import { getSession } from '../../../_lib/session'

// The POST of an e-mail decision link (BR-TOK-03): the CSRF value must match the sign-in session (or the link, when the
// organization lets links decide without signing in), and the decision runs as the member the link was sent to on
// the EMAIL channel. Business time, like every command.
export async function decideByLinkAction(input: { link: string; csrf: string; decision: 'APPROVE' | 'REJECT'; reason: string; idempotencyKey: string }): Promise<ActionLinkOutcome> {
  const owner = await actionLinkOwner(input.link)
  if (!owner) return { ok: false, code: 'TOKEN_INVALID' }
  const session = await getSession()
  let memberId: string
  let binding: string
  if (session.kind === 'member') {
    memberId = session.member.id
    binding = session.sessionId
    if (session.member.organizationId !== owner.organizationId) return { ok: false, code: 'TOKEN_INVALID' }
  } else if (owner.requireLogin) {
    return { ok: false, code: 'UNAUTHENTICATED' }
  } else {
    memberId = owner.memberId
    binding = 'link'
  }
  if (!actionLinkCsrfMatches(binding, input.link, input.csrf)) return { ok: false, code: 'TOKEN_INVALID' }
  const ctx = makeCtx({ organizationId: owner.organizationId, actor: { type: 'USER', memberId }, channel: 'EMAIL', now: systemClock.now() })
  const result = await decideByActionLink(ctx, { link: input.link, decision: input.decision, ...(input.reason ? { reason: input.reason } : {}) }, { idempotencyKey: input.idempotencyKey })
  return result.ok ? { ok: true, decision: input.decision } : { ok: false, code: result.error.code }
}

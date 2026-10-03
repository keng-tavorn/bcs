import { createHmac, timingSafeEqual } from 'node:crypto'
import { getEnv } from '@/lib/env'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { systemDb } from '@/server/db/system'
import { linkSecretMatches, parseEmailLink } from '@/server/tokens/action-tokens'

// Whose e-mail action link this is, before anybody signs in (spec BR-TOK-03): the token's organization and member, and
// whether that organization wants the member signed in first (email.actionLinksRequireLogin, true unless turned
// off). Only a link whose secret opens its token gets an answer. The decision form carries a CSRF value bound to the
// sign-in session (or to the link when the organization lets links decide without one).

const CSRF_CONTEXT = 'bcs/action-link/csrf/v1/'

export interface ActionLinkOwner {
  readonly organizationId: string
  readonly memberId: string
  readonly requireLogin: boolean
}

export async function actionLinkOwner(link: string): Promise<ActionLinkOwner | null> {
  const parsed = parseEmailLink(link)
  if (!parsed) return null
  const token = await systemDb.actionToken.findUnique({
    where: { id: parsed.tokenId },
    select: { organizationId: true, memberId: true, channel: true, secretHash: true, organization: { select: { settings: true } } },
  })
  if (!token || token.channel !== 'EMAIL' || !linkSecretMatches(parsed.secret, token.secretHash)) return null
  const settings = OrgSettingsSchema.shape.email.safeParse((token.organization.settings as { email?: unknown } | null)?.email)
  return { organizationId: token.organizationId, memberId: token.memberId, requireLogin: settings.success ? settings.data.actionLinksRequireLogin : true }
}

/** binding: the session id, or "link" when the organization lets links decide without signing in */
export function actionLinkCsrf(binding: string, link: string): string {
  return createHmac('sha256', getEnv().BETTER_AUTH_SECRET).update(`${CSRF_CONTEXT}${binding}/${link}`).digest('base64url')
}

export function actionLinkCsrfMatches(binding: string, link: string, csrf: string): boolean {
  const expected = Buffer.from(actionLinkCsrf(binding, link))
  const given = Buffer.from(csrf)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

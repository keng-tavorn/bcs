import { isLineApiError } from '@/integrations/line'
import { logger } from '@/lib/logger'
import { forTenant } from '@/server/db/tenant'
import { openLineChannel } from '../line-channel'

// Which rich menu a LINE user sees (§9.5, FR-LINE-004 AC1 AC3): LINKED, linked to the user, while the user has a live
// link to an ACTIVE member under the channel's provider; otherwise nothing of their own, so LINE shows the account's
// default, UNLINKED. The switch runs:
//  - right after a link or an unlink commits (in the request), and again in job line-rich-menu for every line.linked
//    and line.unlinked event, which the outbox hands to Inngest at once (and the outbox-sweeper within a minute when
//    Inngest was away). Inngest retries a transient failure of LINE. So the menu changes within a minute of the link or
//    unlink, also when the unlink came with a deactivation (FR-AUTH-003 AC2), where nothing may call LINE inside the
//    transaction;
//  - when a linked member follows the account again (./follow.ts): LINE drops a user's own menu when they block and
//    unblock the account, and shows the default to someone who is not a friend yet;
//  - for every linked member when the menus are made again (./rich-menu-replace.ts).
// Every run reads the link and the stored menus as they are now, never as an event said: a late run cannot undo a later
// change. After LINE answered, both are read again, and the menu is set again when either changed meanwhile — the link
// (two runs racing for one user end with the menu of the last state) or the stored LINKED menu (a replace that stored a
// new pair while this run linked the old one, which the replace then takes down).

/** Reads of the link and calls to LINE one sync makes at most when the link keeps changing under it */
export const LINE_RICH_MENU_SYNC_ROUNDS = 3

export type LineRichMenuSyncOutcome =
  | { readonly status: 'APPLIED'; readonly menu: 'LINKED' | 'UNLINKED' }
  /**
   * NOT_CONFIGURED / SECRET_UNREADABLE: no channel, or its token does not open · NO_LINKED_MENU: `pnpm line:richmenu` has
   * not stored the menus yet · NO_IDENTITY: the link row does not exist · OTHER_PROVIDER: the link was made under a
   * provider the channel no longer uses, so this channel cannot address that LINE user
   */
  | { readonly status: 'SKIPPED'; readonly reason: 'NOT_CONFIGURED' | 'SECRET_UNREADABLE' | 'NO_LINKED_MENU' | 'NO_IDENTITY' | 'OTHER_PROVIDER' }
  /** LINE refused for good (e.g. a user id it does not know): trying again does not help */
  | { readonly status: 'FAILED'; readonly reason: string }

/** LINKED while this LINE user has a live link to an ACTIVE member of the organization under the provider */
async function wantedMenu(organizationId: string, providerId: string, lineUserId: string): Promise<'LINKED' | 'UNLINKED'> {
  const live = await forTenant(organizationId).channelIdentity.findFirst({
    where: { channel: 'LINE', providerKey: providerId, externalUserId: lineUserId, unlinkedAt: null, member: { status: 'ACTIVE' } },
    select: { id: true },
  })
  return live ? 'LINKED' : 'UNLINKED'
}

/** Not set yet in this run: the first round always calls LINE */
const NOTHING_YET = Symbol('nothing set yet')

/**
 * Sets the menu of one LINE user to what their link is now. Throws what LINE answered (LineApiError) when a call
 * failed; the caller decides whether to try again.
 */
export async function syncLineRichMenu(organizationId: string, lineUserId: string): Promise<LineRichMenuSyncOutcome> {
  // What this run set at LINE last: the id of the LINKED menu linked to the user, or null for none of their own
  let applied: string | null | typeof NOTHING_YET = NOTHING_YET
  let menu: 'LINKED' | 'UNLINKED' = 'UNLINKED'
  for (let round = 0; round < LINE_RICH_MENU_SYNC_ROUNDS; round++) {
    const opened = await openLineChannel(organizationId)
    if (!opened.ok) return { status: 'SKIPPED', reason: opened.reason }
    const { channel } = opened
    const want = await wantedMenu(organizationId, channel.providerId, lineUserId)
    if (want === 'LINKED' && !channel.richMenuLinkedId) return { status: 'SKIPPED', reason: 'NO_LINKED_MENU' }
    // The very menu, not only the kind: a replace may have stored a new LINKED menu since the last call
    const target = want === 'LINKED' ? channel.richMenuLinkedId : null
    if (target === applied) return { status: 'APPLIED', menu: want }
    // The default (UNLINKED) shows again once the user has no menu of their own
    if (target) await channel.api.linkRichMenuToUser(lineUserId, target)
    else await channel.api.unlinkRichMenuFromUser(lineUserId)
    applied = target
    menu = want
  }
  return { status: 'APPLIED', menu }
}

/** The LINE user of a link row (kept after it ends) and whether this channel can address them */
async function lineUserOfIdentity(organizationId: string, identityId: string): Promise<{ readonly lineUserId: string } | { readonly skipped: 'NO_IDENTITY' | 'OTHER_PROVIDER' | 'NOT_CONFIGURED' }> {
  const db = forTenant(organizationId)
  const [identity, channel] = await Promise.all([
    db.channelIdentity.findFirst({ where: { id: identityId, channel: 'LINE' }, select: { externalUserId: true, providerKey: true } }),
    db.lineChannelConfig.findFirst({ select: { providerId: true } }),
  ])
  if (!identity) return { skipped: 'NO_IDENTITY' }
  if (!channel) return { skipped: 'NOT_CONFIGURED' }
  if (identity.providerKey !== channel.providerId) return { skipped: 'OTHER_PROVIDER' }
  return { lineUserId: identity.externalUserId }
}

/**
 * The switch of job line-rich-menu for one link (the aggregate of line.linked / line.unlinked). A transient failure of
 * LINE is thrown so Inngest tries again; anything LINE refuses for good ends the run with FAILED.
 */
export async function runLineRichMenuSync(organizationId: string, identityId: string): Promise<LineRichMenuSyncOutcome> {
  const user = await lineUserOfIdentity(organizationId, identityId)
  if ('skipped' in user) return { status: 'SKIPPED', reason: user.skipped }
  try {
    return await syncLineRichMenu(organizationId, user.lineUserId)
  } catch (error) {
    if (isLineApiError(error) && error.permanent) {
      logger.warn({ organizationId, identityId, operation: error.operation, reason: error.reason, status: error.status }, 'LINE refused to switch the rich menu of a linked or unlinked user')
      return { status: 'FAILED', reason: error.reason }
    }
    throw error
  }
}

/**
 * The switch right after a link or an unlink committed, in the request: best effort. A failure is logged (without the
 * LINE user id) and left to job line-rich-menu, which the same command's event started.
 */
export async function switchLineRichMenuNow(organizationId: string, identityId: string): Promise<LineRichMenuSyncOutcome | null> {
  try {
    return await runLineRichMenuSync(organizationId, identityId)
  } catch (error) {
    logger.warn(
      { organizationId, identityId, ...(isLineApiError(error) ? { operation: error.operation, reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) },
      'the rich menu was not switched at once; job line-rich-menu tries again',
    )
    return null
  }
}

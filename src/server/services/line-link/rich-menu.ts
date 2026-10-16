import { selectRichMenu, type RichMenuChoice } from '@/core/line-menu'
import { isLineApiError, LINE_RICH_MENU_BULK_USERS_MAX } from '@/integrations/line'
import { systemClock } from '@/lib/clock'
import { logger } from '@/lib/logger'
import { forTenant } from '@/server/db/tenant'
import { openLineChannel } from '../line-channel'
import { richMenuInputsOf } from './menu-flags'

// Which rich menu a LINE user sees (§9.5, FR-LINE-004 AC1 AC3, FR-LINE-303 · BR-LINE-16): while the user has a live link
// to an ACTIVE member under the channel's provider, the menu of that member's set by role (selectRichMenu over the flags
// of ./menu-flags.ts: LINKED, LINKED:APPROVER, …) — the set's menu stored in LineRichMenuVariant, or the channel's LINKED
// menu while `pnpm line:richmenu` has not made the sets yet; otherwise nothing of their own, so LINE shows the account's
// default, UNLINKED. The switch runs:
//  - right after a link or an unlink commits (in the request), and again in job line-rich-menu for every line.linked
//    and line.unlinked event, which the outbox hands to Inngest at once (and the outbox-sweeper within a minute when
//    Inngest was away). Inngest retries a transient failure of LINE. So the menu changes within a minute of the link or
//    unlink, also when the unlink came with a deactivation (FR-AUTH-003 AC2), where nothing may call LINE inside the
//    transaction;
//  - when a linked member follows the account again (./follow.ts): LINE drops a user's own menu when they block and
//    unblock the account, and shows the default to someone who is not a friend yet;
//  - for every linked member when the menus are made again (./rich-menu-replace.ts);
//  - in job line-rich-menu when a member's roles, positions or delegations change, and for every linked member when a
//    DOA or workflow version takes effect or is withdrawn (BR-LINE-17): syncLineRichMenusOf, with LINE's bulk link.
// Every run reads the link and the stored menus as they are now, never as an event said: a late run cannot undo a later
// change. After LINE answered, both are read again, and the menu is set again when either changed meanwhile — the link
// (two runs racing for one user end with the menu of the last state) or the stored LINKED menu (a replace that stored a
// new pair while this run linked the old one, which the replace then takes down).

/** Reads of the link and calls to LINE one sync makes at most when the link keeps changing under it */
export const LINE_RICH_MENU_SYNC_ROUNDS = 3

export type LineRichMenuSyncOutcome =
  /** menu: whether the user has a menu of their own; variant: the set by role (UNLINKED for none) */
  | { readonly status: 'APPLIED'; readonly menu: 'LINKED' | 'UNLINKED'; readonly variant: string }
  /**
   * NOT_CONFIGURED / SECRET_UNREADABLE: no channel, or its token does not open · NO_LINKED_MENU: `pnpm line:richmenu` has
   * not stored the menus yet · NO_IDENTITY: the link row does not exist · OTHER_PROVIDER: the link was made under a
   * provider the channel no longer uses, so this channel cannot address that LINE user
   */
  | { readonly status: 'SKIPPED'; readonly reason: 'NOT_CONFIGURED' | 'SECRET_UNREADABLE' | 'NO_LINKED_MENU' | 'NO_IDENTITY' | 'OTHER_PROVIDER' }
  /** LINE refused for good (e.g. a user id it does not know): trying again does not help */
  | { readonly status: 'FAILED'; readonly reason: string }

const UNLINKED_CHOICE = selectRichMenu({ linked: false })

/** The set of this LINE user's menu: their member's by role while linked to an ACTIVE member under the provider, UNLINKED otherwise */
async function wantedMenu(organizationId: string, providerId: string, lineUserId: string): Promise<RichMenuChoice> {
  const db = forTenant(organizationId)
  const live = await db.channelIdentity.findFirst({
    where: { channel: 'LINE', providerKey: providerId, externalUserId: lineUserId, unlinkedAt: null, member: { status: 'ACTIVE' } },
    select: { memberId: true },
  })
  if (!live) return UNLINKED_CHOICE
  const inputs = await db.$transaction((tx) => richMenuInputsOf(tx, [live.memberId], systemClock.now()))
  return selectRichMenu(inputs.get(live.memberId) ?? { linked: false })
}

/**
 * The rich menu id of each set by role this channel has (LineRichMenuVariant, made by `pnpm line:richmenu`), and the
 * LINKED menu of the channel for a set not made yet. UNLINKED is no menu of the user's own (null): the default shows.
 */
async function menuIdsOf(organizationId: string): Promise<Map<string, string>> {
  const rows = await forTenant(organizationId).lineRichMenuVariant.findMany({ select: { variantKey: true, richMenuId: true } })
  return new Map(rows.map((r) => [r.variantKey, r.richMenuId]))
}

/** The menu to link for a set: its own when made, the channel's LINKED menu otherwise; null for UNLINKED; undefined when there is none */
function targetOf(choice: RichMenuChoice, variants: ReadonlyMap<string, string>, linkedMenuId: string | null): string | null | undefined {
  if (choice.variant === UNLINKED_CHOICE.variant) return null
  return variants.get(choice.variant) ?? linkedMenuId ?? undefined
}

const applyOutcome = (choice: RichMenuChoice): LineRichMenuSyncOutcome => ({ status: 'APPLIED', menu: choice.variant === UNLINKED_CHOICE.variant ? 'UNLINKED' : 'LINKED', variant: choice.variant })

/** Not set yet in this run: the first round always calls LINE */
const NOTHING_YET = Symbol('nothing set yet')

/**
 * Sets the menu of one LINE user to what their link is now. Throws what LINE answered (LineApiError) when a call
 * failed; the caller decides whether to try again.
 */
export async function syncLineRichMenu(organizationId: string, lineUserId: string): Promise<LineRichMenuSyncOutcome> {
  // What this run set at LINE last: the id of the LINKED menu linked to the user, or null for none of their own
  let applied: string | null | typeof NOTHING_YET = NOTHING_YET
  let choice: RichMenuChoice = UNLINKED_CHOICE
  for (let round = 0; round < LINE_RICH_MENU_SYNC_ROUNDS; round++) {
    const opened = await openLineChannel(organizationId)
    if (!opened.ok) return { status: 'SKIPPED', reason: opened.reason }
    const { channel } = opened
    const want = await wantedMenu(organizationId, channel.providerId, lineUserId)
    // The very menu, not only the set: a replace may have stored new menus since the last call
    const target = targetOf(want, await menuIdsOf(organizationId), channel.richMenuLinkedId)
    if (target === undefined) return { status: 'SKIPPED', reason: 'NO_LINKED_MENU' }
    if (target === applied) return applyOutcome(want)
    // The default (UNLINKED) shows again once the user has no menu of their own
    if (target) await channel.api.linkRichMenuToUser(lineUserId, target)
    else await channel.api.unlinkRichMenuFromUser(lineUserId)
    applied = target
    choice = want
  }
  return applyOutcome(choice)
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

export type LineRichMenuGroupOutcome =
  | {
      readonly status: 'APPLIED'
      /** LINE users whose menu was set */
      readonly users: number
      /** LINE users switched one by one after a bulk call because their link changed meanwhile */
      readonly resynced: number
      /** LINE users LINE refused for good (e.g. unknown to the account); the others are set */
      readonly refused: number
    }
  | { readonly status: 'SKIPPED'; readonly reason: 'NOT_CONFIGURED' | 'SECRET_UNREADABLE' | 'NO_LINKED_MENU' }

/** A live LINE link of the organization under the channel's provider: its LINE user and member */
async function liveLinks(organizationId: string, providerId: string, memberIds: readonly string[] | 'ALL') {
  return forTenant(organizationId).channelIdentity.findMany({
    where: { channel: 'LINE', providerKey: providerId, unlinkedAt: null, ...(memberIds === 'ALL' ? {} : { memberId: { in: [...memberIds] } }) },
    select: { id: true, memberId: true, externalUserId: true },
    orderBy: { id: 'asc' },
  })
}

/**
 * Job line-rich-menu for a change of who approves or what role someone holds (BR-LINE-17): sets the menu of every LINE
 * user linked to these members to their set by role now. One member's change (a role, a position, a delegation) switches
 * their links one by one with syncLineRichMenu, which reads again until LINE holds the menu of the last state. A DOA or
 * workflow version that takes effect or is withdrawn ('ALL') may change anyone's menu: the menus are worked out for every
 * linked member in one read and set with LINE's bulk link, one call per menu and at most LINE_RICH_MENU_BULK_USERS_MAX
 * users; then the links are read again and a user whose link ended or moved meanwhile gets the one-user switch, so a
 * bulk call that lands late never leaves the menu of an old link. A failure LINE may get over is thrown for Inngest to
 * try again (the whole run is safe to repeat); a refusal for good of one user is counted and logged without the user id.
 */
export async function syncLineRichMenusOf(organizationId: string, memberIds: readonly string[] | 'ALL'): Promise<LineRichMenuGroupOutcome> {
  if (memberIds !== 'ALL' && memberIds.length === 0) return { status: 'APPLIED', users: 0, resynced: 0, refused: 0 }
  const opened = await openLineChannel(organizationId)
  if (!opened.ok) return { status: 'SKIPPED', reason: opened.reason }
  const { channel } = opened
  const links = await liveLinks(organizationId, channel.providerId, memberIds)
  let refused = 0
  const oneByOne = async (lineUserId: string) => {
    try {
      const outcome = await syncLineRichMenu(organizationId, lineUserId)
      if (outcome.status === 'SKIPPED' && outcome.reason === 'NO_LINKED_MENU') return 'NO_LINKED_MENU' as const
    } catch (error) {
      if (!(isLineApiError(error) && error.permanent)) throw error
      refused++
      logger.warn({ organizationId, operation: error.operation, reason: error.reason, status: error.status }, 'LINE refused to switch the rich menu of one linked user')
    }
    return null
  }
  if (memberIds !== 'ALL') {
    for (const link of links) if ((await oneByOne(link.externalUserId)) === 'NO_LINKED_MENU') return { status: 'SKIPPED', reason: 'NO_LINKED_MENU' }
    return { status: 'APPLIED', users: links.length, resynced: 0, refused }
  }

  const inputs = await forTenant(organizationId).$transaction((tx) => richMenuInputsOf(tx, links.map((l) => l.memberId), systemClock.now()))
  const variants = await menuIdsOf(organizationId)
  const groups = new Map<string | null, string[]>()
  for (const link of links) {
    const target = targetOf(selectRichMenu(inputs.get(link.memberId) ?? { linked: false }), variants, channel.richMenuLinkedId)
    if (target === undefined) return { status: 'SKIPPED', reason: 'NO_LINKED_MENU' }
    groups.set(target, [...(groups.get(target) ?? []), link.externalUserId])
  }
  for (const [target, users] of groups) {
    for (let at = 0; at < users.length; at += LINE_RICH_MENU_BULK_USERS_MAX) {
      const chunk = users.slice(at, at + LINE_RICH_MENU_BULK_USERS_MAX)
      try {
        if (target) await channel.api.bulkLinkRichMenu(target, chunk)
        else await channel.api.bulkUnlinkRichMenus(chunk)
      } catch (error) {
        // LINE refused the call for good (one user it does not know refuses the whole call): one by one instead
        if (!(isLineApiError(error) && error.permanent)) throw error
        for (const user of chunk) await oneByOne(user)
      }
    }
  }
  // A link that ended or moved to another member while the menus were worked out and sent: its user gets the menu of now
  const now = new Map((await liveLinks(organizationId, channel.providerId, 'ALL')).map((l) => [l.externalUserId, l.memberId]))
  const moved = links.filter((l) => now.get(l.externalUserId) !== l.memberId)
  for (const link of moved) await oneByOne(link.externalUserId)
  return { status: 'APPLIED', users: links.length, resynced: moved.length, refused }
}

/**
 * The members whose menu a change may move (BR-LINE-17), read now: a member's own (a role), the holder of a position
 * assignment, the delegate of a delegation, or every member ('ALL', a DOA or workflow version). Gone rows move nobody.
 */
export async function membersOfMenuSubject(organizationId: string, subject: 'MEMBER' | 'POSITION_ASSIGNMENT' | 'DELEGATION' | 'ALL', id: string): Promise<readonly string[] | 'ALL'> {
  const db = forTenant(organizationId)
  if (subject === 'ALL') return 'ALL'
  if (subject === 'MEMBER') return [id]
  if (subject === 'POSITION_ASSIGNMENT') {
    const held = await db.positionAssignment.findFirst({ where: { id }, select: { memberId: true } })
    return held ? [held.memberId] : []
  }
  const delegation = await db.delegation.findFirst({ where: { id }, select: { delegateMemberId: true } })
  return delegation ? [delegation.delegateMemberId] : []
}

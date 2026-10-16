import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { isLineApiError, LINE_RICH_MENU_ID_IN_PATH, type LineChannelApi } from '@/integrations/line'
import { logger } from '@/lib/logger'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant } from '@/server/db/tenant'
import { systemClock } from '@/lib/clock'
import {
  LINE_RICH_MENU_IMAGE_FILES,
  LINE_RICH_MENU_KINDS,
  lineRichMenuDefinition,
  lineRichMenuMadeAt,
  richMenuImageInfo,
  richMenuImageProblem,
  type LineRichMenuKind,
} from '@/server/line/link-rich-menus'
import { readLineChannelStored } from '@/server/queries/line-channel'
import { openLineChannel } from '../line-channel'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { syncLineRichMenu } from './rich-menu'

// The rich menus of the organization's LINE account (§9.5, FR-LINE-004 AC1, FR-LINE-303 AC4, D-02 `pnpm line:richmenu`):
// UNLINKED and every set by role (LINE_RICH_MENU_KINDS), made or made again, as ORG_ADMIN (admin.channels), from the
// pictures in assets/line. In this order, so nobody sees a menu without its picture or a member loses their menu:
//  1. allowed? (before anything is made at LINE) · pictures right (PNG or JPEG, 2500 × 843, ≤ 1 MB) · channel saved
//     with its LIFF ID (the buttons open its pages) and its token readable
//  2. every menu made at LINE with its picture; when anything fails, what was made is taken down again
//  3. command organization.store_line_rich_menus: under the Organization row lock, only if the channel settings are
//     still the version read in 1 (a save in between changed the token or the LIFF ID: CONFLICT_VERSION, and the new
//     menus are taken down), UNLINKED and LINKED stored on the channel and every LINKED set in LineRichMenuVariant
//     (the rows of the sets made before replaced in the same transaction), the version raised — an open settings
//     screen reloads before it saves. Event organization.settings_updated { section: lineRichMenu }
//  4. UNLINKED becomes the account's default; every member linked now gets the menu of their set through the same sync
//     a link uses (./rich-menu.ts): it reads that member's link and the stored menus just before it calls LINE and again
//     after, so a link or an unlink that lands meanwhile ends with the right menu, and a member linked while this run
//     goes is moved by their own link's sync (one call each — the demo has a handful; LINE's bulk link can replace it
//     for large organizations)
//  5. the menus BCS made for this organization before this run are taken down: the sets stored until now and any a run
//     that broke off left (their names carry the channel key and when they were made, lineRichMenuName) — never a menu
//     made after this run started, which belongs to a run that may store it next. Unless LINE failed for a while to
//     move a member to the new LINKED menu: then the old ones stay so nobody falls back to UNLINKED, and running it
//     again finishes the job. A member LINE refuses for good (e.g. one who blocked the account: LINE shows such a user
//     the default once they unblock it, and the follow sets their menu again) does not hold the clean-up back.
// Steps 4 and 5 are reported, not refused: the new menus are stored already and a second run repairs what LINE missed.

export type LineRichMenuImages = Readonly<Record<LineRichMenuKind, Uint8Array>>

/** The pictures in assets/line, read from the working directory (on Vercel next.config ships them with the route) */
export async function readLineRichMenuImages(dir: string = path.join(process.cwd(), 'assets', 'line')): Promise<LineRichMenuImages> {
  const files = await Promise.all(LINE_RICH_MENU_KINDS.map((kind) => readFile(path.join(dir, LINE_RICH_MENU_IMAGE_FILES[kind]!))))
  return Object.fromEntries(LINE_RICH_MENU_KINDS.map((kind, i) => [kind, new Uint8Array(files[i]!)]))
}

const richMenuId = z.string().regex(LINE_RICH_MENU_ID_IN_PATH)
const StoreRichMenusInput = z.strictObject({
  linkedId: richMenuId,
  unlinkedId: richMenuId,
  /** Every LINKED set by its key (LINKED included), as made in this run */
  sets: z.record(z.string().regex(/^LINKED(?::[A-Z]+)*$/), richMenuId),
  expectedVersion: z.number().int().nonnegative(),
})

export interface StoredLineRichMenus {
  readonly linkedId: string
  readonly unlinkedId: string
  readonly previousLinkedId: string | null
  readonly previousUnlinkedId: string | null
  /** The menus of the sets stored until now */
  readonly previousSetIds: readonly string[]
  readonly version: number
}

export const storeLineRichMenusCommand = defineCommand({
  name: 'organization.store_line_rich_menus',
  capability: 'admin.channels',
  input: StoreRichMenusInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<StoredLineRichMenus>> {
    const allowed = await authorize(tx, ctx, 'admin.channels')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    // The same lock as the settings save and the link: a save in between is seen here, never lost
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const existing = await tx.lineChannelConfig.findFirst({ select: { id: true, version: true, richMenuLinkedId: true, richMenuUnlinkedId: true } })
    if (!existing) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the LINE channel is not saved', details: { field: 'channel', reason: 'NOT_CONFIGURED' } } }
    if (existing.version !== input.expectedVersion) {
      return { ok: false, error: { code: 'CONFLICT_VERSION', message: 'the LINE channel settings changed while the menus were made', details: { current: existing.version } } }
    }
    const row = await tx.lineChannelConfig.update({
      where: { organizationId: ctx.organizationId },
      data: { richMenuLinkedId: input.linkedId, richMenuUnlinkedId: input.unlinkedId, version: { increment: 1 } },
      select: { version: true },
    })
    // The sets of this run replace those stored before (FR-LINE-303 AC4): a set never points at a menu taken down
    const previousSets = await tx.lineRichMenuVariant.findMany({ select: { richMenuId: true } })
    await tx.lineRichMenuVariant.deleteMany({})
    await tx.lineRichMenuVariant.createMany({
      data: Object.entries(input.sets).map(([variantKey, menuId]) => ({ organizationId: ctx.organizationId, channelConfigId: existing.id, variantKey, richMenuId: menuId, madeAt: ctx.now })),
    })
    return {
      ok: true,
      result: {
        linkedId: input.linkedId,
        unlinkedId: input.unlinkedId,
        previousLinkedId: existing.richMenuLinkedId,
        previousUnlinkedId: existing.richMenuUnlinkedId,
        previousSetIds: previousSets.map((v) => v.richMenuId),
        version: row.version,
      },
      events: [
        {
          type: 'organization.settings_updated',
          aggregateType: 'Organization',
          aggregateId: ctx.organizationId,
          data: { section: 'lineRichMenu', replaced: existing.richMenuLinkedId !== null || existing.richMenuUnlinkedId !== null },
        },
      ],
    }
  },
})

export interface LineRichMenusReplaced {
  readonly linkedId: string
  readonly unlinkedId: string
  /** Menus made and stored in this run: UNLINKED and every LINKED set */
  readonly sets: number
  /** Menus were stored before and are taken down (step 5) */
  readonly replaced: boolean
  /** UNLINKED is the account's default now */
  readonly defaultSet: boolean
  /** Members linked now and moved to the new LINKED menu */
  readonly relinked: number
  /** Members LINE refused for good (e.g. they blocked the account): they get the menu when they follow it again */
  readonly relinkRefused: number
  /** Members LINE could not move for a while: the old menus are kept for them, and a second run moves them */
  readonly relinkFailed: number
  /** Menus of earlier runs taken down, and those LINE did not take down (kept on purpose when a relink failed) */
  readonly removed: number
  readonly removeFailed: number
}

function lineFailure(error: unknown): Result<never> {
  if (!isLineApiError(error)) throw error
  return err('EXTERNAL_SERVICE_ERROR', `LINE refused ${error.operation}`, { service: 'LINE', operation: error.operation, reason: error.reason, status: error.status })
}

/** Takes menus down, best effort; returns how many LINE did not take down */
async function takeDown(api: LineChannelApi, organizationId: string, ids: Iterable<string>): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  for (const id of ids) {
    try {
      await api.deleteRichMenu(id)
      removed++
    } catch (error) {
      failed++
      logger.warn({ organizationId, ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) }, 'LINE did not take a rich menu down')
    }
  }
  return { removed, failed }
}

/**
 * Makes both rich menus at LINE and stores them (see the steps above). ORG_ADMIN only: FORBIDDEN before anything is
 * made. VALIDATION_FAILED { field: images.<kind>, reason: FORMAT | SIZE | TOO_LARGE }, { field: channel, reason:
 * NOT_CONFIGURED }, { field: liffId, reason: REQUIRED } or { field: channelAccessToken, reason: SECRET_UNREADABLE };
 * EXTERNAL_SERVICE_ERROR { service: LINE, operation, reason, status } when LINE refused to make them; CONFLICT_VERSION.
 */
export async function replaceLineRichMenus(ctx: Ctx, images: LineRichMenuImages, options: RunOptions): Promise<Result<LineRichMenusReplaced>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.channels'))
  if (!allowed.ok) return { ok: false, error: allowed.error }
  for (const kind of LINE_RICH_MENU_KINDS) {
    const image = images[kind]
    if (!image) return err('VALIDATION_FAILED', `the ${kind} picture is missing`, { field: `images.${kind}`, reason: 'FORMAT' })
    const problem = richMenuImageProblem(image)
    if (problem) return err('VALIDATION_FAILED', `the ${kind} picture cannot be a rich menu: ${problem}`, { field: `images.${kind}`, reason: problem })
  }
  const stored = await readLineChannelStored(ctx.organizationId)
  if (!stored) return err('VALIDATION_FAILED', 'the LINE channel is not saved', { field: 'channel', reason: 'NOT_CONFIGURED' })
  if (!stored.liffId) return err('VALIDATION_FAILED', 'the buttons open LIFF pages: save the LIFF ID first', { field: 'liffId', reason: 'REQUIRED' })
  const opened = await openLineChannel(ctx.organizationId)
  if (!opened.ok) return err('VALIDATION_FAILED', 'the LINE channel cannot be used', opened.reason === 'NOT_CONFIGURED' ? { field: 'channel', reason: 'NOT_CONFIGURED' } : { field: 'channelAccessToken', reason: opened.reason })
  const { api, providerId } = opened.channel
  // Real time, after the settings were read: a run that reads them later makes later menus (step 5 keeps those)
  const madeAt = systemClock.now()

  // 2. Every menu with its picture
  const made: string[] = []
  const ids: Partial<Record<LineRichMenuKind, string>> = {}
  try {
    for (const kind of LINE_RICH_MENU_KINDS) {
      const id = await api.createRichMenu(lineRichMenuDefinition(kind, { liffId: stored.liffId, channelKey: stored.channelKey }, madeAt))
      made.push(id)
      await api.uploadRichMenuImage(id, images[kind]!, richMenuImageInfo(images[kind]!)!.contentType)
      ids[kind] = id
    }
  } catch (error) {
    await takeDown(api, ctx.organizationId, made)
    return lineFailure(error)
  }
  const linkedId = ids.LINKED!
  const unlinkedId = ids.UNLINKED!
  const sets = Object.fromEntries(Object.entries(ids).filter(([kind]) => kind !== 'UNLINKED')) as Record<string, string>

  // 3. Stored, if the channel is still what the menus were made for
  const saved = await runCommand(ctx, storeLineRichMenusCommand, { linkedId, unlinkedId, sets, expectedVersion: stored.version }, options)
  if (!saved.ok || saved.data.linkedId !== linkedId) {
    // Refused, or a repeat of a request already handled (its own menus are stored): these new ones are not needed
    await takeDown(api, ctx.organizationId, made)
    if (!saved.ok) return saved
    return err('IDEMPOTENCY_CONFLICT', 'this request was handled before; use a new idempotency key to make the menus again', { idempotencyKey: options.idempotencyKey })
  }

  // 4. The default, and every member linked now
  let defaultSet = true
  try {
    await api.setDefaultRichMenu(unlinkedId)
  } catch (error) {
    defaultSet = false
    logger.warn({ organizationId: ctx.organizationId, ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) }, 'LINE did not take the UNLINKED rich menu as the default')
  }
  const linked = await forTenant(ctx.organizationId).channelIdentity.findMany({
    where: { channel: 'LINE', providerKey: providerId, unlinkedAt: null, member: { status: 'ACTIVE' } },
    select: { externalUserId: true },
    orderBy: { id: 'asc' },
  })
  let relinked = 0
  let relinkRefused = 0
  let relinkFailed = 0
  for (const { externalUserId } of linked) {
    try {
      const outcome = await syncLineRichMenu(ctx.organizationId, externalUserId)
      // APPLIED UNLINKED: the member unlinked meanwhile, and has the default now; LINKED: the menu of their set
      if (outcome.status === 'APPLIED' && outcome.menu === 'LINKED') relinked++
      // The channel could not be opened meanwhile: as a failure for a while, so the old menus stay
      else if (outcome.status === 'SKIPPED') relinkFailed++
    } catch (error) {
      const permanent = isLineApiError(error) && error.permanent
      if (permanent) relinkRefused++
      else relinkFailed++
      logger.warn(
        { organizationId: ctx.organizationId, ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) },
        permanent ? 'LINE refused for good to move a linked member to the new LINKED rich menu' : 'LINE did not move a linked member to the new LINKED rich menu',
      )
    }
  }

  // 5. What BCS made for this organization before this run (the stored pair and any left by a run that broke off)
  let removed = 0
  let removeFailed = 0
  if (relinkFailed === 0 && defaultSet) {
    const earlier = new Set([saved.data.previousLinkedId, saved.data.previousUnlinkedId, ...saved.data.previousSetIds].filter((id): id is string => id !== null))
    try {
      for (const menu of await api.listRichMenus()) {
        const at = lineRichMenuMadeAt(menu.name, stored.channelKey)
        if (at !== null && at < madeAt.getTime()) earlier.add(menu.richMenuId)
      }
    } catch (error) {
      logger.warn({ organizationId: ctx.organizationId, ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) }, 'LINE did not list the rich menus; only the stored ones are taken down')
    }
    // Never what is stored now: a later run may have stored its sets since
    const now = await readLineChannelStored(ctx.organizationId)
    const setsNow = await forTenant(ctx.organizationId).lineRichMenuVariant.findMany({ select: { richMenuId: true } })
    for (const id of [linkedId, unlinkedId, ...Object.values(sets), now?.richMenuLinkedId, now?.richMenuUnlinkedId, ...setsNow.map((v) => v.richMenuId)]) if (id) earlier.delete(id)
    const down = await takeDown(api, ctx.organizationId, earlier)
    removed = down.removed
    removeFailed = down.failed
  }
  return ok({
    linkedId,
    unlinkedId,
    sets: Object.keys(ids).length,
    replaced: saved.data.previousLinkedId !== null || saved.data.previousUnlinkedId !== null,
    defaultSet,
    relinked,
    relinkRefused,
    relinkFailed,
    removed,
    removeFailed,
  })
}

import { z } from 'zod'
import { expiredIntakeIds } from '@/core/chat-intake'
import type { Result } from '@/core/result'
import { deleteObject } from '@/integrations/storage'
import { MS_PER_DAY, MS_PER_HOUR } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { chatIntakeSettingsOf } from '@/lib/s17-settings'
import { systemCtx } from '@/server/context'
import { listOrganizationsForPlatform } from '@/server/db/lookups'
import type { TenantTx } from '@/server/db/tenant'
import { deleteStaleLineInboundTexts } from '@/server/line/webhook'
import type { EventDraft } from '@/server/events/append'
import { describeError } from '@/server/errors/describe'
import { defineCommand, runCommand, type CommandFailure, type CommandOutcome } from '../_pipeline'
import { purgeChatIntakeAiContent } from '../ai'
import { giveUpChatImages } from './images'

// The hourly sweep of asking through the chat (S17-06 · BR-LINE-10, BR-LINE-11 · OQ-161 OQ-162 · FR-LINE-301 AC7), job
// chat-intake-sweep, for every organization — also one that stopped asking through the chat, whose drafts still expire
// and are still cleared:
//  - chat_intake.expire: an OPEN draft nobody used for expireHours becomes EXPIRED (expiredIntakeIds, golden chat-intake);
//  - chat_intake.purge: a closed draft (DRAFTED, DISMISSED, EXPIRED) opened textRetentionDays ago or more loses its typed
//    text, and its images that no document took (no FileLink) are removed: the object leaves the bucket after the commit
//    and its FileObject is REJECTED, so nothing can read it again. The draft row and its counts stay. TODO(OQ-162)
//  - images still PENDING after CHAT_IMAGE_GIVE_UP_MS become FAILED (TIMEOUT), so LIFF asks for them again;
//  - LineInboundMessage rows older than 24 hours go: text nobody processed (BR-LINE-11; not a document, no event).
// The hour is the idempotency key of each command, so a retry of the hour repeats nothing. Every organization is swept,
// a suspended one too: what members typed is kept no longer than its retention whatever the organization's status.

/** Every organization, whatever its status: the retention of chat text and photos holds for all (BR-LINE-11) */
export async function chatSweepOrganizationIds(): Promise<string[]> {
  return (await listOrganizationsForPlatform()).map((o) => o.id)
}

export const CHAT_SWEEP_JOB = 'chat-intake-sweep'
/** BR-LINE-11: the longest the text of a message waits for its processing */
export const LINE_INBOUND_TEXT_MAX_AGE_MS = 24 * MS_PER_HOUR
const SWEEP_BATCH = 500

const fail = (code: 'FORBIDDEN' | 'NOT_FOUND', message: string): CommandFailure => ({ ok: false, error: { code, message } })

async function settingsOf(tx: TenantTx, organizationId: string) {
  return chatIntakeSettingsOf((await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })).settings)
}

export const expireChatIntakesCommand = defineCommand({
  name: 'chat_intake.expire',
  capability: 'request.create',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ expired: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'drafts expire by the system only')
    const { expireHours } = await settingsOf(tx, ctx.organizationId)
    const candidates = await tx.chatIntake.findMany({
      where: { status: 'OPEN', lastMessageAt: { lte: new Date(ctx.now.getTime() - expireHours * MS_PER_HOUR) } },
      select: { id: true, status: true, lastMessageAt: true },
      orderBy: { id: 'asc' },
      take: SWEEP_BATCH,
    })
    // Each one by a conditional update: Postgres re-reads the row under its lock, so a draft its owner dismissed or drafted,
    // or that took a message, since the read above is left alone - and gets no event
    const cutoff = new Date(ctx.now.getTime() - expireHours * MS_PER_HOUR)
    const expired: string[] = []
    for (const id of expiredIntakeIds(ctx.now, expireHours, candidates)) {
      const changed = await tx.chatIntake.updateMany({ where: { id, status: 'OPEN', lastMessageAt: { lte: cutoff } }, data: { status: 'EXPIRED', closedAt: ctx.now, version: { increment: 1 } } })
      if (changed.count === 1) expired.push(id)
    }
    if (expired.length === 0) return fail('NOT_FOUND', 'nothing to expire')
    return { ok: true, result: { expired: expired.length }, events: expired.map((id) => ({ type: 'chat_intake.expired', aggregateType: 'ChatIntake', aggregateId: id, data: { reason: 'IDLE' } })) }
  },
})

export const purgeChatIntakesCommand = defineCommand({
  name: 'chat_intake.purge',
  capability: 'request.create',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ purged: number; storageKeys: string[] }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'drafts are cleared by the system only')
    const { textRetentionDays } = await settingsOf(tx, ctx.organizationId)
    const due = await tx.chatIntake.findMany({
      where: { status: { in: ['DRAFTED', 'DISMISSED', 'EXPIRED'] }, purgedAt: null, openedAt: { lte: new Date(ctx.now.getTime() - textRetentionDays * MS_PER_DAY) } },
      select: { id: true, text: true, items: { where: { fileId: { not: null } }, select: { file: { select: { id: true, storageKey: true, status: true, links: { select: { id: true }, take: 1 } } } } } },
      orderBy: { id: 'asc' },
      take: SWEEP_BATCH,
    })
    if (due.length === 0) return fail('NOT_FOUND', 'nothing to clear')
    const events: EventDraft[] = []
    const storageKeys: string[] = []
    for (const intake of due) {
      // Images a request took are the request's files now (FileLink); the others go
      const unused = intake.items.flatMap((i) => (i.file && i.file.links.length === 0 && i.file.status === 'AVAILABLE' ? [i.file] : []))
      if (unused.length > 0) await tx.fileObject.updateMany({ where: { id: { in: unused.map((f) => f.id) } }, data: { status: 'REJECTED' } })
      storageKeys.push(...unused.map((f) => f.storageKey))
      await tx.chatIntake.update({ where: { id: intake.id }, data: { text: null, purgedAt: ctx.now, version: { increment: 1 } } })
      events.push({ type: 'chat_intake.purged', aggregateType: 'ChatIntake', aggregateId: intake.id, data: { textRemoved: intake.text !== null, filesRemoved: unused.length, fileIds: unused.map((f) => f.id) } })
    }
    // BR-LINE-11: what the AI read of these drafts goes with their text
    events.push(...(await purgeChatIntakeAiContent(tx, ctx, due.map((d) => d.id))))
    return { ok: true, result: { purged: due.length, storageKeys }, events }
  },
})

export interface ChatIntakeSweepResult {
  readonly expired: number
  readonly purged: number
  readonly imagesGivenUp: number
  readonly textsDeleted: number
}

/** What job chat-intake-sweep runs for one organization each hour */
export async function runChatIntakeSweep(organizationId: string, now: Date): Promise<ChatIntakeSweepResult> {
  const hour = now.toISOString().slice(0, 13)
  const ctx = systemCtx(organizationId, now, CHAT_SWEEP_JOB)
  // Nothing to do is NOT_FOUND; anything else throws, and the job's step runs again with the same `now` (the job takes it
  // once), so the same keys replay what was done - the storage keys of a purge included
  const done = <T,>(result: Result<T>, what: string): T | null => {
    if (result.ok) return result.data
    if (result.error.code === 'NOT_FOUND') return null
    throw new Error(`the chat sweep's ${what} did not finish (${result.error.code})`)
  }
  const expired = done(await runCommand(ctx, expireChatIntakesCommand, {}, { idempotencyKey: `${CHAT_SWEEP_JOB}:expire:${hour}` }), 'expiry')
  const purged = done(await runCommand(ctx, purgeChatIntakesCommand, {}, { idempotencyKey: `${CHAT_SWEEP_JOB}:purge:${hour}` }), 'purge')
  for (const key of purged?.storageKeys ?? []) {
    try {
      await deleteObject(key)
    } catch (error) {
      // The FileObject is REJECTED already, so nothing reads the object; the step's next try deletes it
      logger.warn({ organizationId, error: describeError(error) }, 'a cleared chat image is still in the bucket')
      throw error
    }
  }
  const imagesGivenUp = await giveUpChatImages(organizationId, now)
  const textsDeleted = await deleteStaleLineInboundTexts(organizationId, new Date(now.getTime() - LINE_INBOUND_TEXT_MAX_AGE_MS))
  return { expired: expired?.expired ?? 0, purged: purged?.purged ?? 0, imagesGivenUp, textsDeleted }
}

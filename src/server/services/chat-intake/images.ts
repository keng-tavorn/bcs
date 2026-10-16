import { createHash } from 'node:crypto'
import { z } from 'zod'
import { transition, CHAT_INTAKE_MACHINE } from '@/core/state-machines'
import { isLineApiError } from '@/integrations/line'
import { deleteObject, putObject } from '@/integrations/storage'
import { MAX_UPLOAD_BYTES, MS_PER_HOUR } from '@/lib/constants'
import { SNIFF_BYTES, sniffMimeType } from '@/lib/file-types'
import { newId } from '@/lib/ids'
import { logger } from '@/lib/logger'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandFailure, type CommandOutcome } from '../_pipeline'
import { openLineChannel } from '../line-channel'

// The images of a chat draft (S17-06 · BR-LINE-14 · FR-LINE-301 AC3): fetched from LINE in job chat-intake-image, never in
// the webhook. An image must be a JPEG or a PNG by its first bytes and at most 20 MB (NFR-SEC-08); it is kept in the
// private bucket under the draft and recorded as a FileObject uploaded by the draft's owner, so only they see it until it
// is attached to their request. One that cannot be fetched for good — LINE no longer has it (404, 410), refused it, or it
// is too large or of another type — is FAILED with a code, and LIFF asks for it again; the rest of the draft stays usable.
// LINE's 5xx, 429 and the network throw, and the job tries again (Inngest's retries). The object key is fixed per item,
// so a retry overwrites rather than leaves a copy behind.

export const CHAT_IMAGE_JOB = 'chat-intake-image'
export const chatImagePrefix = (organizationId: string, intakeId: string): string => `org/${organizationId}/chat-intake/${intakeId}/`

export type ChatImageFailure = 'GONE' | 'LINE_REFUSED' | 'TOO_LARGE' | 'TYPE_NOT_ALLOWED' | 'EMPTY' | 'NO_CHANNEL' | 'TIMEOUT'
const FAILURES = ['GONE', 'LINE_REFUSED', 'TOO_LARGE', 'TYPE_NOT_ALLOWED', 'EMPTY', 'NO_CHANNEL', 'TIMEOUT'] as const satisfies readonly ChatImageFailure[]
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' } as const
type ImageType = keyof typeof IMAGE_TYPES

const StoreImageInput = z.discriminatedUnion('status', [
  z.strictObject({
    itemId: z.uuid(),
    status: z.literal('STORED'),
    key: z.string().min(1),
    mimeType: z.enum(['image/jpeg', 'image/png']),
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({ itemId: z.uuid(), status: z.literal('FAILED'), code: z.enum(FAILURES) }),
])

const fail = (code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'VALIDATION_FAILED', message: string): CommandFailure => ({ ok: false, error: { code, message } })

/** One key per item and result, so a retry replays and a different result of the same item is refused by state, not by key */
const storeKey = (input: z.input<typeof StoreImageInput>): string => `${CHAT_IMAGE_JOB}:${input.itemId}:${input.status === 'FAILED' ? input.code : 'STORED'}`

/** chat_intake.store_image: what the job got for one PENDING image of an OPEN or DRAFTED draft; the system only */
export const storeChatImageCommand = defineCommand({
  name: 'chat_intake.store_image',
  capability: 'request.create',
  input: StoreImageInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ fileId: string | null }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'images are fetched by the system only')
    const item = await tx.chatIntakeItem.findFirst({
      where: { id: input.itemId },
      select: { id: true, seq: true, kind: true, fetchStatus: true, intake: { select: { id: true, status: true, memberId: true } } },
    })
    if (!item || item.kind !== 'IMAGE') return fail('NOT_FOUND', 'no such image')
    if (item.fetchStatus !== 'PENDING' || !transition(CHAT_INTAKE_MACHINE, item.intake.status, 'chat_intake.store_image').ok) {
      return fail('INVALID_STATE_TRANSITION', `the image is ${item.fetchStatus} in a draft that is ${item.intake.status}`)
    }
    const intakeId = item.intake.id
    if (input.status === 'FAILED') {
      await tx.chatIntakeItem.update({ where: { id: item.id }, data: { fetchStatus: 'FAILED', fetchError: input.code } })
      return { ok: true, result: { fileId: null }, events: [{ type: 'chat_intake.image_fetched', aggregateType: 'ChatIntake', aggregateId: intakeId, data: { seq: item.seq, status: 'FAILED' } }] }
    }
    if (!input.key.startsWith(chatImagePrefix(ctx.organizationId, intakeId))) return fail('VALIDATION_FAILED', 'the file key is not of this draft')
    const fileId = newId()
    await tx.fileObject.create({
      data: {
        id: fileId,
        organizationId: ctx.organizationId,
        storageKey: input.key,
        fileName: `chat-${item.seq}.${IMAGE_TYPES[input.mimeType]}`,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        status: 'AVAILABLE',
        uploadedById: item.intake.memberId,
        // A member's own photo, as an upload of theirs (NFR-SEC-08: files from outside are scanned, members' are not)
        scanStatus: 'NOT_REQUIRED',
      },
    })
    await tx.chatIntakeItem.update({ where: { id: item.id }, data: { fetchStatus: 'STORED', fetchError: null, fileId } })
    return {
      ok: true,
      result: { fileId },
      events: [
        { type: 'file.uploaded', aggregateType: 'File', aggregateId: fileId, data: { fileId, mimeType: input.mimeType, sizeBytes: input.sizeBytes } },
        { type: 'chat_intake.image_fetched', aggregateType: 'ChatIntake', aggregateId: intakeId, data: { seq: item.seq, status: 'STORED', fileId } },
      ],
    }
  },
})

/** The images of a draft still waiting to be fetched (job chat-intake-image) */
export async function pendingChatImages(organizationId: string, intakeId: string): Promise<string[]> {
  const items = await forTenant(organizationId).chatIntakeItem.findMany({
    where: { intakeId, kind: 'IMAGE', fetchStatus: 'PENDING', intake: { status: { in: ['OPEN', 'DRAFTED'] } } },
    select: { id: true },
    orderBy: { seq: 'asc' },
  })
  return items.map((i) => i.id)
}

/** Why LINE's content cannot be fetched for good, or null when another try may work (then the caller throws) */
function permanentFailure(error: unknown): ChatImageFailure | null {
  if (!isLineApiError(error) || !error.permanent) return null
  if (error.reason === 'LIMIT_EXCEEDED') return 'TOO_LARGE'
  return error.status === 404 || error.status === 410 ? 'GONE' : 'LINE_REFUSED'
}

export type ChatImageOutcome = { readonly itemId: string; readonly status: 'STORED' | 'FAILED' | 'SKIPPED'; readonly code?: string }

/**
 * Fetches and keeps one image (one step of the job): throws when LINE or the bucket may work on another try. Logs carry
 * the organization, the item and codes only (NFR-SEC-09).
 */
export async function fetchChatImage(organizationId: string, itemId: string, now: Date): Promise<ChatImageOutcome> {
  const db = forTenant(organizationId)
  const item = await db.chatIntakeItem.findFirst({ where: { id: itemId, kind: 'IMAGE', fetchStatus: 'PENDING' }, select: { id: true, intakeId: true, lineMessageId: true, intake: { select: { status: true } } } })
  if (!item || !transition(CHAT_INTAKE_MACHINE, item.intake.status, 'chat_intake.store_image').ok) return { itemId, status: 'SKIPPED' }
  const ctx = systemCtx(organizationId, now, CHAT_IMAGE_JOB)
  const record = (input: z.input<typeof StoreImageInput>) => runCommand(ctx, storeChatImageCommand, input, { idempotencyKey: storeKey(input) })
  const failed = async (code: ChatImageFailure): Promise<ChatImageOutcome> => {
    const result = await record({ itemId: item.id, status: 'FAILED', code })
    if (!result.ok && result.error.code !== 'INVALID_STATE_TRANSITION') throw new Error(`recording a chat image that failed did not finish (${result.error.code})`)
    return { itemId, status: 'FAILED', code }
  }

  const opened = await openLineChannel(organizationId)
  if (!opened.ok) return failed('NO_CHANNEL')
  let bytes: Uint8Array
  try {
    bytes = (await opened.channel.api.getMessageContent(item.lineMessageId)).bytes
  } catch (error) {
    const code = permanentFailure(error)
    if (!code) throw error
    logger.warn({ organizationId, itemId, reason: isLineApiError(error) ? error.reason : 'UNEXPECTED' }, 'LINE does not give the image of a chat draft')
    return failed(code)
  }
  if (bytes.length === 0) return failed('EMPTY')
  if (bytes.length > MAX_UPLOAD_BYTES) return failed('TOO_LARGE')
  const sniffed = sniffMimeType(bytes.subarray(0, SNIFF_BYTES))
  if (sniffed !== 'image/jpeg' && sniffed !== 'image/png') return failed('TYPE_NOT_ALLOWED')
  const mimeType: ImageType = sniffed
  const key = `${chatImagePrefix(organizationId, item.intakeId)}${item.id}`
  await putObject(key, bytes, mimeType)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const result = await record({ itemId: item.id, status: 'STORED', key, mimeType, sizeBytes: bytes.length, sha256 })
  if (result.ok) return { itemId, status: 'STORED' }
  // The draft closed meanwhile, or another run stored it: the object goes unless a file of this item names it
  const after = await db.chatIntakeItem.findFirst({ where: { id: item.id }, select: { fetchStatus: true } })
  if (after?.fetchStatus !== 'STORED') await deleteObject(key)
  if (result.error.code === 'INVALID_STATE_TRANSITION') return { itemId, status: 'SKIPPED' }
  throw new Error(`recording a chat image did not finish (${result.error.code})`)
}

/** Images still PENDING after this long are given up (TIMEOUT) by the hourly sweep: the job's retries are over by then */
export const CHAT_IMAGE_GIVE_UP_MS = 6 * MS_PER_HOUR

/** The sweep's part: images nobody fetched (the job gave up) become FAILED, so LIFF asks for them again */
export async function giveUpChatImages(organizationId: string, now: Date): Promise<number> {
  const stale = await forTenant(organizationId).chatIntakeItem.findMany({
    where: { kind: 'IMAGE', fetchStatus: 'PENDING', receivedAt: { lt: new Date(now.getTime() - CHAT_IMAGE_GIVE_UP_MS) }, intake: { status: { in: ['OPEN', 'DRAFTED'] } } },
    select: { id: true },
    take: 500,
  })
  const ctx = systemCtx(organizationId, now, CHAT_IMAGE_JOB)
  let given = 0
  for (const { id } of stale) {
    const input = { itemId: id, status: 'FAILED', code: 'TIMEOUT' } as const
    const result = await runCommand(ctx, storeChatImageCommand, input, { idempotencyKey: storeKey(input) })
    if (result.ok) given++
  }
  return given
}

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { numberPatternRegex } from '@/core/numbering'
import { err, ok, type Result } from '@/core/result'
import { getEmailInbox, InboxReadError, messageIdOf, type EmailInbox, type InboundMessage } from '@/integrations/email-inbound'
import { putObject } from '@/integrations/storage'
import { MAX_UPLOAD_BYTES } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { organizationsWithInvoiceInbox } from '@/server/db/sql/invoice-inbox'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { readEtaxContent } from '../invoices/etax'
import { requireModule } from '../modules'
import { fail, guard, type Fail } from './common'
import { inboxFilePrefix, invoiceFileType, readStoredInvoiceFile } from './files'
import { draftOnPo, lockPoForDraft } from './index'

// The invoice inbox (ADR-123, BR-AP-02, BR-IVC-07, FR-AP-101 AC2 AC4): mail to the organization's inbox address
// (settings.ap.inboxAddress, OQ-124) is read by the job invoice-inbox-poll every 5 minutes or when FINANCE presses "fetch
// now". Each message is kept once by its Message-ID (InboundEmail) without its body; each attachment that is a PDF, XML,
// JPEG or PNG (by its bytes, at most 10 per message) goes to private storage, the others are skipped with a reason. The
// supplier is proposed from the e-Tax seller (tax id and branch, read by the BR-IVC-05 reader), else from the sender
// matching Supplier.email; the PO from a number of the numbering.PO pattern in the subject or the file name. An
// attachment with a PO proposed becomes a draft (channel EMAIL) that FINANCE checks and submits — nothing is matched on
// its own; the others wait in the inbox for FINANCE to choose the PO (invoice.createFromInbox). AI plays no part.

const MAX_FILES_PER_MESSAGE = 10
/** A message the inbox could not read is tried again by the job this many times, then FINANCE skips it */
export const INBOX_MAX_ATTEMPTS = 3

const SkipReason = z.enum(['TYPE_NOT_ALLOWED', 'TOO_LARGE', 'EMPTY', 'OVER_LIMIT'])
type SkipReason = z.infer<typeof SkipReason>

const ReceiveInput = z.strictObject({
  provider: z.string().min(1).max(40),
  messageId: z.string().min(1).max(998),
  fromAddress: z.string().max(320),
  toAddress: z.string().max(320),
  subject: z.string().max(300),
  receivedAt: z.iso.datetime(),
  poRefsFound: z.array(z.string().min(1).max(60)).max(50),
  files: z
    .array(
      z.strictObject({
        key: z.string().min(1),
        fileName: z.string().min(1).max(200),
        mimeType: z.enum(['application/pdf', 'application/xml', 'image/jpeg', 'image/png']),
        sizeBytes: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        poId: z.uuid().nullable(),
      }),
    )
    .max(MAX_FILES_PER_MESSAGE),
  skipped: z.array(z.strictObject({ fileName: z.string().max(200), reason: SkipReason })).max(100),
})

export interface ReceivedEmail {
  readonly inboundEmailId: string
  readonly draftIds: string[]
  readonly pendingFiles: number
}

/** Who may run the inbox: FINANCE (invoice.inbox.manage), or the job; PAY must be on (BR-AP-13) */
async function inboxGuard(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; memberId: string | null } | Fail> {
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  if (ctx.actor.type === 'SYSTEM') return { ok: true, memberId: null }
  const allowed = await authorize(tx, ctx, 'invoice.inbox.manage')
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
  return { ok: true, memberId: allowed.data.memberId }
}

async function financeHolders(tx: TenantTx): Promise<string[]> {
  const rows = await tx.roleAssignment.findMany({ where: { role: 'FINANCE', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true }, distinct: ['memberId'] })
  return rows.map((r) => r.memberId)
}

export const receiveInboundEmailCommand = defineCommand({
  name: 'invoice.inbox.receive',
  capability: 'invoice.inbox.manage',
  input: ReceiveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<ReceivedEmail>> {
    const who = await inboxGuard(tx, ctx)
    if (!who.ok) return who
    const prefix = inboxFilePrefix(ctx.organizationId)
    if (input.files.some((f) => !f.key.startsWith(prefix))) return fail('VALIDATION_FAILED', 'an inbox file is kept under the inbox prefix', { field: 'files' })
    // BR-AP-02: the same Message-ID is the same mail; only one the inbox could not read is taken again
    const known = await tx.inboundEmail.findFirst({ where: { messageId: input.messageId }, select: { id: true, status: true } })
    if (known && known.status !== 'FAILED') return fail('CONFLICT_VERSION', 'the message is kept already', { reason: 'ALREADY_RECEIVED', inboundEmailId: known.id })
    const header = { provider: input.provider, fromAddress: input.fromAddress, toAddress: input.toAddress, subject: input.subject.slice(0, 300), receivedAt: new Date(input.receivedAt), attachmentCount: input.files.length, poRefsFound: input.poRefsFound }
    const emailId = known?.id ?? newId()
    if (known) await tx.inboundEmail.update({ where: { id: emailId }, data: { ...header, status: 'RECEIVED' } })
    else await tx.inboundEmail.create({ data: { id: emailId, organizationId: ctx.organizationId, messageId: input.messageId, ...header } })

    const events: EventDraft[] = [{ type: 'inbound_email.received', aggregateType: 'InboundEmail', aggregateId: emailId, data: { provider: input.provider, attachmentCount: input.files.length, skippedCount: input.skipped.length } }]
    const draftIds: string[] = []
    let pending = 0
    for (const f of input.files) {
      // received, not uploaded: no member is its uploader, so the upload path (invoice.create) never takes it
      const fileId = newId()
      await tx.fileObject.create({
        data: { id: fileId, organizationId: ctx.organizationId, storageKey: f.key, fileName: f.fileName, mimeType: f.mimeType, sizeBytes: f.sizeBytes, sha256: f.sha256, status: 'AVAILABLE', uploadedById: null, scanStatus: 'NOT_REQUIRED' },
      })
      await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'InboundEmail', subjectId: emailId, kind: 'INVOICE' } })
      events.push({ type: 'file.uploaded', aggregateType: 'File', aggregateId: fileId, data: { fileId, mimeType: f.mimeType, sizeBytes: f.sizeBytes } })
      const draft = f.poId ? await draftFromInboxFile(tx, ctx, { emailId, fileId, poId: f.poId, createdById: who.memberId }) : null
      if (draft?.ok) {
        draftIds.push(draft.invoiceId)
        events.push(draft.event)
      } else pending++
    }
    const ignored = input.files.length === 0
    await tx.inboundEmail.update({ where: { id: emailId }, data: { status: ignored ? 'IGNORED' : 'PROCESSED', ignoreReason: ignored ? 'NO_INVOICE_FILE' : null, processedAt: ctx.now } })
    events.push(
      ignored
        ? { type: 'inbound_email.ignored', aggregateType: 'InboundEmail', aggregateId: emailId, data: { reason: 'NO_INVOICE_FILE', skipped: input.skipped } }
        : { type: 'inbound_email.processed', aggregateType: 'InboundEmail', aggregateId: emailId, data: { draftCount: draftIds.length, pendingCount: pending, skipped: input.skipped } },
    )
    // FINANCE hears of new drafts and files waiting for a PO in the digest (spec §10.1)
    const notifications: NotificationDraft[] = ignored
      ? []
      : (await financeHolders(tx)).map((memberId) => ({
          recipientMemberId: memberId,
          templateKey: 'invoice.inbox_digest',
          data: { inboundEmailId: emailId, draftCount: draftIds.length, pendingCount: pending },
          urgency: 'DIGEST' as const,
          dedupeKey: `invoice.inbox_digest:${emailId}:${memberId}`,
        }))
    return { ok: true, result: { inboundEmailId: emailId, draftIds, pendingFiles: pending }, events, notifications }
  },
})

/**
 * A draft of an inbox file on a PO, under the PO's lock: refused (and the file left waiting) when the PO cannot take a
 * tier-2 invoice, or the file is already another invoice's paper
 */
async function draftFromInboxFile(tx: TenantTx, ctx: Ctx, input: { emailId: string; fileId: string; poId: string; createdById: string | null }) {
  const locked = await lockPoForDraft(tx, ctx, input.poId, 'invoice.create')
  if (!locked.ok) return locked
  const file = await readStoredInvoiceFile(tx, { organizationId: ctx.organizationId, memberId: null, fileId: input.fileId, poId: input.poId })
  if (!file.ok) return fail('VALIDATION_FAILED', 'the inbox file could not be read again', { field: 'fileId', reason: file.reason })
  const draft = await draftOnPo(tx, ctx, locked.po, { channel: 'EMAIL', file: file.file, inboundEmailId: input.emailId, createdById: input.createdById })
  if (!draft.ok) return draft
  return { ok: true as const, invoiceId: draft.invoiceId, event: draft.event }
}

const MessageInput = z.strictObject({ messageId: z.string().min(1).max(998), provider: z.string().min(1).max(40), fromAddress: z.string().max(320), toAddress: z.string().max(320), subject: z.string().max(300), receivedAt: z.iso.datetime(), code: z.string().min(1).max(40) })

/** A message the inbox could not read: FAILED with one more attempt; the job tries it again until INBOX_MAX_ATTEMPTS */
export const failInboundEmailCommand = defineCommand({
  name: 'invoice.inbox.fail',
  capability: 'invoice.inbox.manage',
  input: MessageInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ inboundEmailId: string; attempts: number }>> {
    const who = await inboxGuard(tx, ctx)
    if (!who.ok) return who
    const known = await tx.inboundEmail.findFirst({ where: { messageId: input.messageId }, select: { id: true, status: true, attempts: true } })
    if (known && known.status !== 'FAILED') return fail('CONFLICT_VERSION', 'the message is kept already', { reason: 'ALREADY_RECEIVED', inboundEmailId: known.id })
    const id = known?.id ?? newId()
    const attempts = (known?.attempts ?? 0) + 1
    const header = { provider: input.provider, fromAddress: input.fromAddress, toAddress: input.toAddress, subject: input.subject.slice(0, 300), receivedAt: new Date(input.receivedAt), status: 'FAILED' as const, attempts }
    if (known) await tx.inboundEmail.update({ where: { id }, data: header })
    else await tx.inboundEmail.create({ data: { id, organizationId: ctx.organizationId, messageId: input.messageId, poRefsFound: [], ...header } })
    return { ok: true, result: { inboundEmailId: id, attempts }, events: [{ type: 'inbound_email.failed', aggregateType: 'InboundEmail', aggregateId: id, data: { code: input.code, attempts } }] }
  },
})

const IgnoreInput = z.strictObject({ inboundEmailId: z.uuid(), reason: z.string().trim().min(1).max(500) })

/** FINANCE skips a message with a reason (one the inbox could not read, or one that carries no invoice) */
export const ignoreInboundEmailCommand = defineCommand({
  name: 'invoice.inbox.ignore',
  capability: 'invoice.inbox.manage',
  input: IgnoreInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ inboundEmailId: string }>> {
    const who = await inboxGuard(tx, ctx)
    if (!who.ok) return who
    if (!who.memberId) return fail('FORBIDDEN', 'a member skips a message')
    const email = await tx.inboundEmail.findFirst({ where: { id: input.inboundEmailId }, select: { id: true, status: true, _count: { select: { invoices: { where: { status: { notIn: ['CANCELLED', 'REJECTED'] } } } } } } })
    if (!email) return fail('NOT_FOUND', 'message not found')
    if (email.status === 'IGNORED' || email._count.invoices > 0) return fail('INVALID_STATE_TRANSITION', 'the message is skipped already or has invoices', { from: email.status, command: 'invoice.inbox.ignore' })
    await tx.inboundEmail.update({ where: { id: email.id }, data: { status: 'IGNORED', ignoreReason: input.reason, processedAt: ctx.now } })
    return { ok: true, result: { inboundEmailId: email.id }, events: [{ type: 'inbound_email.ignored', aggregateType: 'InboundEmail', aggregateId: email.id, data: { reason: input.reason, skipped: [] } }] }
  },
})

const FromInboxInput = z.strictObject({ inboundEmailId: z.uuid(), fileId: z.uuid(), poId: z.uuid() })

/** FINANCE chooses the PO of an inbox file no PO was proposed for (or another one): a draft as from the job */
export const createFromInboxCommand = defineCommand({
  name: 'invoice.createFromInbox',
  capability: 'invoice.record',
  input: FromInboxInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string }>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    const link = await tx.fileLink.findFirst({ where: { fileId: input.fileId, subjectType: 'InboundEmail', subjectId: input.inboundEmailId }, select: { id: true } })
    if (!link) return fail('NOT_FOUND', 'the file is not an attachment of this message')
    const draft = await draftFromInboxFile(tx, ctx, { emailId: input.inboundEmailId, fileId: input.fileId, poId: input.poId, createdById: who.memberId })
    if (!draft.ok) return draft
    return { ok: true, result: { invoiceId: draft.invoiceId }, events: [draft.event] }
  },
})

// ---------- reading the inbox (the job and the "fetch now" button) ----------

export interface InboxPoll {
  readonly provider: EmailInbox['name']
  readonly address: string | null
  readonly received: number
  readonly drafts: number
  readonly failed: number
}

/** Another run kept the message first (the job and the button at the same time) */
const alreadyKept = (error: { code: string; details?: Record<string, unknown> }) => error.code === 'CONFLICT_VERSION' && error.details?.reason === 'ALREADY_RECEIVED'

/** The PO numbers of the organization's pattern in a text (BR-AP-02) */
function poRefs(pattern: string, ...texts: string[]): string[] {
  const re = numberPatternRegex(pattern)
  return [...new Set(texts.flatMap((t) => [...t.matchAll(re)].map((m) => m[0])))]
}

interface Proposal {
  readonly supplierId: string | null
  readonly poId: string | null
}

/** BR-AP-02: the supplier from the e-Tax seller, else from the sender; the PO from a number that is the supplier's */
async function propose(ctx: Ctx, input: { content: Uint8Array; from: string; refs: string[] }): Promise<Proposal> {
  const db = forTenant(ctx.organizationId)
  const reading = readEtaxContent(input.content)?.reading
  let supplierId: string | null = null
  if (reading && 'prefill' in reading) {
    const bySeller = await db.supplier.findMany({ where: { taxId: reading.prefill.sellerTaxId, ...(reading.prefill.sellerBranch ? { branchCode: reading.prefill.sellerBranch } : {}) }, select: { id: true }, take: 2 })
    if (bySeller.length === 1) supplierId = bySeller[0]!.id
  }
  if (!supplierId && input.from) {
    const bySender = await db.supplier.findMany({ where: { email: { equals: input.from, mode: 'insensitive' } }, select: { id: true }, take: 2 })
    if (bySender.length === 1) supplierId = bySender[0]!.id
  }
  const pos = input.refs.length ? await db.purchaseOrder.findMany({ where: { number: { in: input.refs }, ...(supplierId ? { supplierId } : {}) }, select: { id: true, supplierId: true }, take: 2 }) : []
  const po = pos.length === 1 ? pos[0]! : null
  return { supplierId: supplierId ?? po?.supplierId ?? null, poId: po?.id ?? null }
}

async function storeMessage(ctx: Ctx, inbox: EmailInbox, message: InboundMessage, poPattern: string): Promise<z.input<typeof ReceiveInput>> {
  const refsOfSubject = poRefs(poPattern, message.subject)
  const files: z.input<typeof ReceiveInput>['files'] = []
  const skipped: Array<{ fileName: string; reason: SkipReason }> = []
  const allRefs = new Set(refsOfSubject)
  for (const a of message.attachments) {
    const fileName = a.fileName.replace(/[\\/\u0000-\u001f]/g, ' ').trim().slice(0, 200) || 'attachment'
    if (files.length >= MAX_FILES_PER_MESSAGE) {
      skipped.push({ fileName, reason: 'OVER_LIMIT' })
      continue
    }
    if (a.size > MAX_UPLOAD_BYTES) {
      skipped.push({ fileName, reason: 'TOO_LARGE' })
      continue
    }
    const content = await inbox.attachment(message, a.partId)
    if (content.length === 0 || content.length > MAX_UPLOAD_BYTES) {
      skipped.push({ fileName, reason: content.length ? 'TOO_LARGE' : 'EMPTY' })
      continue
    }
    const mimeType = invoiceFileType(content)
    if (!mimeType) {
      skipped.push({ fileName, reason: 'TYPE_NOT_ALLOWED' })
      continue
    }
    const refs = [...new Set([...poRefs(poPattern, fileName), ...refsOfSubject])]
    refs.forEach((r) => allRefs.add(r))
    const proposal = await propose(ctx, { content, from: message.from, refs })
    const key = `${inboxFilePrefix(ctx.organizationId)}${newId()}`
    await putObject(key, content, mimeType)
    files.push({ key, fileName, mimeType: mimeType as (typeof files)[number]['mimeType'], sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), poId: proposal.poId })
  }
  return {
    provider: inbox.name,
    messageId: message.messageId,
    fromAddress: message.from,
    toAddress: message.to,
    subject: message.subject,
    receivedAt: message.receivedAt.toISOString(),
    poRefsFound: [...allRefs].slice(0, 50),
    files,
    skipped,
  }
}

/**
 * Reads the organization's inbox once: every message not kept yet (and every FAILED one still under its attempts) is
 * stored and handed to invoice.inbox.receive; a message that cannot be read is FAILED. The commands run as `ctx`.
 */
export async function pollInvoiceInbox(ctx: Ctx, options: { inbox?: EmailInbox } = {}): Promise<Result<InboxPoll>> {
  const db = forTenant(ctx.organizationId)
  const allowed = await db.$transaction((tx) => inboxGuard(tx, ctx))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const settings = (org.settings ?? {}) as { ap?: unknown; numbering?: unknown }
  const address = OrgSettingsSchema.shape.ap.parse(settings.ap)?.inboxAddress ?? null
  const inbox = options.inbox ?? getEmailInbox()
  const summary = { provider: inbox.name, address, received: 0, drafts: 0, failed: 0 }
  if (!address || inbox.name === 'disabled') return ok(summary)
  const poPattern = OrgSettingsSchema.shape.numbering.parse(settings.numbering).PO.pattern

  const messages = (await inbox.list(address)).map((m) => ({ ...m, messageId: messageIdOf(m.messageId) }))
  const known = new Map((await db.inboundEmail.findMany({ where: { messageId: { in: messages.map((m) => m.messageId) } }, select: { messageId: true, status: true, attempts: true } })).map((k) => [k.messageId, k]))
  const seen = new Set<string>()
  for (const message of messages) {
    // the same mail sent twice is in the list twice: the first one is the message
    if (seen.has(message.messageId)) continue
    seen.add(message.messageId)
    const k = known.get(message.messageId)
    if (k && (k.status !== 'FAILED' || k.attempts >= INBOX_MAX_ATTEMPTS)) continue
    const attempt = (k?.attempts ?? 0) + 1
    const header = { messageId: message.messageId, provider: inbox.name, fromAddress: message.from, toAddress: message.to, subject: message.subject.slice(0, 300), receivedAt: message.receivedAt.toISOString() }
    let input: z.input<typeof ReceiveInput>
    try {
      input = await storeMessage(ctx, inbox, message, poPattern)
    } catch (error) {
      if (!(error instanceof InboxReadError)) throw error
      const failed = await runCommand(ctx, failInboundEmailCommand, { ...header, code: error.code }, { idempotencyKey: `inbox-fail:${message.messageId}:${attempt}` })
      if (!failed.ok && !alreadyKept(failed.error)) return failed
      summary.failed++
      continue
    }
    const received = await runCommand(ctx, receiveInboundEmailCommand, input, { idempotencyKey: `inbox:${message.messageId}:${attempt}` })
    if (!received.ok) {
      if (alreadyKept(received.error)) continue
      return received
    }
    summary.received++
    summary.drafts += received.data.draftIds.length
  }
  return ok(summary)
}

/** Job invoice-inbox-poll: every organization with PAY on and an inbox address, as SYSTEM */
export async function pollAllInvoiceInboxes(now: Date, options: { inbox?: EmailInbox } = {}): Promise<Array<{ organizationId: string; ok: boolean }>> {
  const results = []
  for (const organizationId of await organizationsWithInvoiceInbox()) {
    const polled = await pollInvoiceInbox(systemCtx(organizationId, now, 'invoice-inbox-poll'), options)
    results.push({ organizationId, ok: polled.ok })
  }
  return results
}

export function receiveInboundEmail(ctx: Ctx, input: z.input<typeof ReceiveInput>, options: RunOptions) {
  return runCommand(ctx, receiveInboundEmailCommand, input, options)
}
export function ignoreInboundEmail(ctx: Ctx, input: z.input<typeof IgnoreInput>, options: RunOptions) {
  return runCommand(ctx, ignoreInboundEmailCommand, input, options)
}
export function createInvoiceFromInbox(ctx: Ctx, input: z.input<typeof FromInboxInput>, options: RunOptions) {
  return runCommand(ctx, createFromInboxCommand, input, options)
}

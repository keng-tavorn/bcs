import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ok, type Result } from '@/core/result'
import { buildNeutralFile, NEUTRAL_TEMPLATE_CODE, precheckRun, readNeutralFile, type PrecheckFailure, type PrecheckItem } from '@/core/bankfile'
import { PAYMENT_RUN_MACHINE, transition, type PaymentRunCommand, type PaymentRunState } from '@/core/state-machines'
import { presignDownload, PRESIGN_TTL_SECONDS, putObject } from '@/integrations/storage'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { utf8WithBom } from '@/lib/encoding'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { fail, type Fail } from '../ap/common'
import { recordSensitiveAccess } from '../audit/sensitive-access'
import { requireModule } from '../modules'
import { releaseAll } from './runs'

// The bank file of an approved payment run, and the run's way to the bank (S9-07, FR-PAY-102 AC1 to AC6, FR-PAY-101
// AC11, FR-PAY-103 AC5, BR-BANK-03 to BR-BANK-08, BR-PAY-10, BR-PAY-11, ADR-129, ADR-130, ADR-133, OQ-136). FINANCE
// (paymentRun.file) makes the file of the payer account's template — in the demo layer the neutral template, which
// says on its H row and in its name that no bank takes it — after the check of BR-BANK-06 passes; the bytes are UTF-8
// with a BOM, their sha256 kept, and the file read back so that its D rows, its T row and the run's total agree. A file
// is never changed (the trigger of PaymentFile): a new version needs a reason, and when the version in use was
// downloaded, the word that it was not sent to the bank (EXPORT_CONFIRMATION_REQUIRED) and a notice to the approvers.
// The file is downloaded only through requestPaymentFileDownload, a POST that writes file.downloaded and a
// SensitiveAccessLog row and marks the first download of the version, then answers a link of at most five minutes made
// afresh for each answer (never kept in CommandLog); no other way opens it: it belongs to no member (nothing attaches it
// elsewhere as "a file you uploaded") and its FileLink "PaymentFile" has a policy that always refuses (file-policy.ts).
// FINANCE marks the run sent to the bank once the version in use was downloaded — the system sends nothing (NG-2) — and
// takes that back while no result is recorded. A run approved, or with its file made, is cancelled by FINANCE with a reason and,
// when a file was downloaded, the same word: its documents go back to S8 marked as released after an export, so a
// later run flags them PREVIOUSLY_EXPORTED (BR-PAY-06). Account numbers stay in the file and the snapshot: events carry
// ids, versions, counts, totals and sha256 only (BR-BANK-08).

const MIN_REASON_LENGTH = 3
const CSV = 'text/csv'
const day = (d: Date) => d.toISOString().slice(0, 10)

type RunRow = NonNullable<Awaited<ReturnType<typeof readRun>>>

function readRun(tx: TenantTx, id: string) {
  return tx.paymentRun.findFirst({ where: { id }, include: { payer: { select: { status: true, fileTemplateCode: true, bankCode: true, accountNo: true } } } })
}

/** FINANCE with this capability, of an organization with PAY on */
async function finance(tx: TenantTx, ctx: Ctx, capability: 'paymentRun.file' | 'paymentRun.cancel'): Promise<{ ok: true; memberId: string } | Fail> {
  const allowed = await authorize(tx, ctx, capability)
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'only a member acts on a payment run')
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  return { ok: true, memberId: allowed.data.memberId }
}

async function lockedRun(tx: TenantTx, ctx: Ctx, id: string, command: PaymentRunCommand, version?: number): Promise<{ ok: true; run: RunRow; to: PaymentRunState } | Fail> {
  const [locked] = await lockRowsForUpdate(tx, 'PaymentRun', ctx.organizationId, [id])
  const run = locked ? await readRun(tx, id) : null
  if (!run) return fail('NOT_FOUND', 'payment run not found')
  const moved = transition(PAYMENT_RUN_MACHINE, run.status as PaymentRunState, command)
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${run.status}`, { from: run.status, command })
  if (version !== undefined && run.version !== version) return fail('CONFLICT_VERSION', 'the run changed since it was read', { version: run.version })
  return { ok: true, run, to: moved.to }
}

/** A failure of BR-BANK-06 in words for the message {checks}: the check, and the item's sequence when it is an item's */
function describe(f: PrecheckFailure): string {
  return 'seq' in f ? `${f.check}#${f.seq}${'field' in f ? `:${f.field}` : ''}` : f.check
}

/** Who approved the run: the members who approved its tasks on the route that approved it (they hear of a file made again or a cancellation) */
async function approversOf(tx: TenantTx, run: RunRow): Promise<string[]> {
  const route = run.currentRouteId ? { id: run.currentRouteId } : { subjectType: 'PAYMENT_RUN' as const, subjectId: run.id }
  const tasks = await tx.approvalTask.findMany({ where: { decision: 'APPROVE', step: { route } }, select: { decidedByMemberId: true } })
  return [...new Set(tasks.map((t) => t.decidedByMemberId).filter((m): m is string => !!m))]
}

/**
 * BR-BANK-04 to BR-BANK-06: the check of the run and its items against the register, then the file of the template,
 * stored and read back. Version `version`; `reason` for every version after the first. Nothing is stored when the
 * check fails (BANK_FILE_CHECK_FAILED with every failure).
 */
async function makeFile(tx: TenantTx, ctx: Ctx, run: RunRow, memberId: string, version: number, reason: string | null): Promise<{ ok: true; fileId: string; paymentFileId: string; sha256: string; byteSize: number } | Fail> {
  const items = await tx.paymentRunItem.findMany({
    where: { paymentRunId: run.id, seq: { not: null } },
    orderBy: { seq: 'asc' },
    select: { id: true, seq: true, transferSatang: true, payeeBankCode: true, payeeAccountNo: true, payeeAccountName: true, supplier: { select: { code: true } }, bankAccount: { select: { status: true, bankCode: true, accountNo: true, accountName: true } } },
  })
  // every link of the run, a RELEASED one too: a document let go is DOCUMENT_NOT_HELD like a paid one (BR-BANK-06)
  const links = await tx.paymentRunDocument.findMany({
    where: { paymentRunId: run.id },
    select: { paymentRunItemId: true, invoiceId: true, retentionId: true, status: true, invoice: { select: { status: true } }, retention: { select: { status: true } } },
  })
  // what each item's documents are now: held by this run — its link HELD and S8 still holding the document for a
  // payment run — or no longer (paid, or let go, by this run or by S8)
  const held = (l: (typeof links)[number]) => l.status === 'HELD' && (l.invoice ?? l.retention)?.status === 'IN_PAYMENT_RUN'
  const checked: PrecheckItem[] = items.map((i) => ({
    seq: i.seq!,
    supplierCode: i.supplier.code,
    transferSatang: i.transferSatang,
    snapshot: { bankCode: i.payeeBankCode ?? '', accountNo: i.payeeAccountNo ?? '', accountName: i.payeeAccountName ?? '' },
    register: i.bankAccount ? { status: i.bankAccount.status, bankCode: i.bankAccount.bankCode, accountNo: i.bankAccount.accountNo, accountName: i.bankAccount.accountName } : null,
    documents: links.filter((l) => l.paymentRunItemId === i.id).map((l) => ({ id: l.invoiceId ?? l.retentionId!, heldByThisRun: held(l) })),
  }))
  const pre = precheckRun({ totalTransferSatang: run.totalTransferSatang, itemCount: run.itemCount, payerStatus: run.payer.status, payerTemplateCode: run.payer.fileTemplateCode ?? '', runTemplateCode: run.fileTemplateCode }, checked)
  if (!pre.ok) return fail('BANK_FILE_CHECK_FAILED', 'the check before the file failed', { checks: pre.failures.map(describe).join(', '), failures: pre.failures.map((f) => ({ ...f, ...('expectedSatang' in f ? { expectedSatang: f.expectedSatang.toString(), actualSatang: f.actualSatang.toString() } : {}) })) })
  // ADR-129: one builder per template; the demo layer has the neutral one only (a bank's own comes with P0-03)
  if (run.fileTemplateCode !== NEUTRAL_TEMPLATE_CODE) return fail('VALIDATION_FAILED', `no builder for template ${run.fileTemplateCode} yet`, { reason: 'TEMPLATE_NOT_BUILT', templateCode: run.fileTemplateCode })
  const built = buildNeutralFile({
    run: { number: run.number!, fileVersion: version, valueDate: day(run.payDate), payer: { bankCode: run.payer.bankCode, accountNo: run.payer.accountNo } },
    items: checked.map((c) => ({ seq: c.seq, bankCode: c.snapshot.bankCode, accountNo: c.snapshot.accountNo, accountName: c.snapshot.accountName, amountSatang: c.transferSatang, supplierCode: c.supplierCode })),
  })
  const bytes = utf8WithBom(built.text)
  // INV-PAY-02: the file read back from its bytes states what the run transfers, row by row and in total
  const back = readNeutralFile(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes))
  const agrees = [back.header, back.details, back.trailer].every((t) => t.count === run.itemCount && t.totalSatang === run.totalTransferSatang)
  if (!agrees) return fail('BANK_FILE_CHECK_FAILED', 'the file read back does not state the run', { checks: 'FILE_READBACK_MISMATCH', failures: [{ check: 'FILE_READBACK_MISMATCH' }] })
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const fileId = newId()
  const paymentFileId = newId()
  const key = `org/${ctx.organizationId}/payment-files/${run.id}/v${version}-${fileId}.csv`
  await putObject(key, bytes, CSV)
  // no member's upload (uploadedById null): the services that attach "a file you uploaded" never take it; who made it
  // is PaymentFile.generatedById. Its link is the PaymentFile's, whose policy refuses every general download.
  await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey: key, fileName: built.fileName, mimeType: CSV, sizeBytes: bytes.length, sha256, status: 'AVAILABLE', uploadedById: null, scanStatus: 'NOT_REQUIRED' } })
  await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'PaymentFile', subjectId: paymentFileId, kind: 'OTHER' } })
  await tx.paymentFile.create({
    data: { id: paymentFileId, organizationId: ctx.organizationId, paymentRunId: run.id, version, templateCode: run.fileTemplateCode, fileId, fileName: built.fileName, sha256, byteSize: bytes.length, itemCount: run.itemCount, totalSatang: run.totalTransferSatang, reason, generatedById: memberId, generatedAt: ctx.now },
  })
  return { ok: true, fileId, paymentFileId, sha256, byteSize: bytes.length }
}

const fileEvent = (run: RunRow, version: number, made: { paymentFileId: string; sha256: string }, afterExport: boolean): EventDraft => ({
  type: 'payment_run.file_generated',
  aggregateType: 'PaymentRun',
  aggregateId: run.id,
  data: { paymentFileId: made.paymentFileId, version, templateCode: run.fileTemplateCode, sha256: made.sha256, itemCount: run.itemCount, totalTransferSatang: run.totalTransferSatang.toString(), afterExport },
})

// ---------- paymentRun.generateFile ----------

const GenerateInput = z.strictObject({ paymentRunId: z.uuid(), version: z.number().int().min(0) })

export const generatePaymentFileCommand = defineCommand({
  name: 'paymentRun.generateFile',
  capability: 'paymentRun.file',
  input: GenerateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; paymentFileId: string; version: number; sha256: string }>> {
    const who = await finance(tx, ctx, 'paymentRun.file')
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.generateFile', input.version)
    if (!found.ok) return found
    const { run, to } = found
    const made = await makeFile(tx, ctx, run, who.memberId, 1, null)
    if (!made.ok) return made
    await tx.paymentRun.update({ where: { id: run.id }, data: { status: to, version: { increment: 1 } } })
    return { ok: true, result: { paymentRunId: run.id, paymentFileId: made.paymentFileId, version: 1, sha256: made.sha256 }, events: [fileEvent(run, 1, made, false)] }
  },
})

export function generatePaymentFile(ctx: Ctx, input: z.input<typeof GenerateInput>, options: RunOptions) {
  return runCommand(ctx, generatePaymentFileCommand, input, options)
}

// ---------- paymentRun.regenerateFile ----------

const RegenerateInput = z.strictObject({
  paymentRunId: z.uuid(),
  version: z.number().int().min(0),
  reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH),
  /** BR-BANK-07, OQ-136: the version in use was downloaded and was not sent to the bank */
  confirmNotSentToBank: z.boolean().optional(),
})

export const regeneratePaymentFileCommand = defineCommand({
  name: 'paymentRun.regenerateFile',
  capability: 'paymentRun.file',
  input: RegenerateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; paymentFileId: string; version: number; sha256: string }>> {
    const who = await finance(tx, ctx, 'paymentRun.file')
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.regenerateFile', input.version)
    if (!found.ok) return found
    const { run } = found
    const current = await tx.paymentFile.findFirstOrThrow({ where: { paymentRunId: run.id, status: 'CURRENT' } })
    const afterExport = current.firstDownloadedAt !== null
    if (afterExport && input.confirmNotSentToBank !== true) return fail('VALIDATION_FAILED', 'the file in use was downloaded: confirm it was not sent to the bank', { field: 'confirmNotSentToBank', reason: 'EXPORT_CONFIRMATION_REQUIRED' })
    await tx.paymentFile.update({ where: { id: current.id }, data: { status: 'SUPERSEDED' } })
    const version = current.version + 1
    const made = await makeFile(tx, ctx, run, who.memberId, version, input.reason)
    if (!made.ok) return made
    await tx.paymentRun.update({ where: { id: run.id }, data: { version: { increment: 1 } } })
    // BR-BANK-07: the approvers hear of a file made again after one was downloaded
    const notifications: NotificationDraft[] = afterExport
      ? (await approversOf(tx, run)).map((m) => ({ recipientMemberId: m, templateKey: 'payment_run.file_regenerated', data: { paymentRunId: run.id, number: run.number, version }, urgency: 'IMMEDIATE' as const, dedupeKey: `payment_run.file_regenerated:${run.id}:${version}:${m}`, subjectType: 'PAYMENT_RUN', subjectId: run.id }))
      : []
    return { ok: true, result: { paymentRunId: run.id, paymentFileId: made.paymentFileId, version, sha256: made.sha256 }, events: [fileEvent(run, version, made, afterExport)], notifications }
  },
})

export function regeneratePaymentFile(ctx: Ctx, input: z.input<typeof RegenerateInput>, options: RunOptions) {
  return runCommand(ctx, regeneratePaymentFileCommand, input, options)
}

// ---------- paymentRun.requestFileDownload (POST) ----------

const DownloadInput = z.strictObject({ paymentRunId: z.uuid(), paymentFileId: z.uuid() })

export const requestPaymentFileDownloadCommand = defineCommand({
  name: 'paymentRun.requestFileDownload',
  capability: 'paymentRun.file',
  input: DownloadInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentFileId: string; fileName: string; firstDownload: boolean }>> {
    const who = await finance(tx, ctx, 'paymentRun.file')
    if (!who.ok) return who
    const [locked] = await lockRowsForUpdate(tx, 'PaymentRun', ctx.organizationId, [input.paymentRunId])
    const run = locked ? await tx.paymentRun.findFirst({ where: { id: input.paymentRunId }, select: { id: true, status: true } }) : null
    if (!run) return fail('NOT_FOUND', 'payment run not found')
    const file = await tx.paymentFile.findFirst({ where: { id: input.paymentFileId, paymentRunId: run.id } })
    if (!file) return fail('NOT_FOUND', 'file not found')
    // BR-BANK-08: the version in use of a run on its way to the bank; an older version or a closed run's file is only
    // looked at through its sha256, count and total on the run's page, so the same file never reaches the bank twice
    if (file.status !== 'CURRENT' || (run.status !== 'FILE_READY' && run.status !== 'SENT_TO_BANK')) return fail('VALIDATION_FAILED', 'only the file in use of a run not finished is downloaded', { reason: 'FILE_NOT_CURRENT' })
    const firstDownload = file.firstDownloadedAt === null
    if (firstDownload) await tx.paymentFile.update({ where: { id: file.id }, data: { firstDownloadedAt: ctx.now } })
    // every payee's account number whole (NFR-PRIV-03): each download is a reveal on record
    await recordSensitiveAccess(tx, ctx, { subjectType: 'PaymentFile', subjectId: file.id, fields: ['accountNo'], purpose: 'download' })
    return { ok: true, result: { paymentFileId: file.id, fileName: file.fileName, firstDownload }, events: [{ type: 'file.downloaded', aggregateType: 'File', aggregateId: file.fileId, data: { fileId: file.fileId } }] }
  },
})

/**
 * The command, then a link made now: a replay of the same request gets a fresh link, never one kept in CommandLog. A
 * replay answers from CommandLog without running the command again, so the link is made only after the same checks
 * pass now — FINANCE with PAY on, the version in use of a run on its way to the bank (BR-BANK-08) — whatever changed
 * since the first answer.
 */
export async function requestPaymentFileDownload(ctx: Ctx, input: z.input<typeof DownloadInput>, options: RunOptions): Promise<Result<{ url: string; expiresInSeconds: number; fileName: string; firstDownload: boolean }>> {
  const done = await runCommand(ctx, requestPaymentFileDownloadCommand, input, options)
  if (!done.ok) return done
  const now = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await finance(tx, ctx, 'paymentRun.file')
    if (!who.ok) return who
    const file = await tx.paymentFile.findUniqueOrThrow({ where: { id: done.data.paymentFileId }, select: { status: true, run: { select: { status: true } }, file: { select: { storageKey: true } } } })
    if (file.status !== 'CURRENT' || (file.run.status !== 'FILE_READY' && file.run.status !== 'SENT_TO_BANK')) return fail('VALIDATION_FAILED', 'only the file in use of a run not finished is downloaded', { reason: 'FILE_NOT_CURRENT' })
    return { ok: true as const, storageKey: file.file.storageKey }
  })
  if (!now.ok) return now
  const url = await presignDownload(now.storageKey, { fileName: done.data.fileName, contentType: CSV, inline: false }, PRESIGN_TTL_SECONDS)
  return ok({ url, expiresInSeconds: PRESIGN_TTL_SECONDS, fileName: done.data.fileName, firstDownload: done.data.firstDownload })
}

// ---------- paymentRun.markSentToBank · paymentRun.revertSent ----------

const SentInput = z.strictObject({ paymentRunId: z.uuid(), version: z.number().int().min(0) })

export const markSentToBankCommand = defineCommand({
  name: 'paymentRun.markSentToBank',
  capability: 'paymentRun.file',
  input: SentInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string }>> {
    const who = await finance(tx, ctx, 'paymentRun.file')
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.markSentToBank', input.version)
    if (!found.ok) return found
    const current = await tx.paymentFile.findFirstOrThrow({ where: { paymentRunId: found.run.id, status: 'CURRENT' }, select: { id: true, version: true, firstDownloadedAt: true } })
    // BR-PAY-11: what reaches the bank is the version in use, so it was downloaded first (an older one is superseded)
    if (!current.firstDownloadedAt) return fail('VALIDATION_FAILED', 'the file in use was never downloaded', { reason: 'FILE_NOT_DOWNLOADED', version: current.version })
    await tx.paymentRun.update({ where: { id: found.run.id }, data: { status: found.to, sentToBankAt: ctx.now, version: { increment: 1 } } })
    return { ok: true, result: { paymentRunId: found.run.id }, events: [{ type: 'payment_run.sent_to_bank', aggregateType: 'PaymentRun', aggregateId: found.run.id, data: { paymentFileId: current.id, fileVersion: current.version } }] }
  },
})

export function markPaymentRunSentToBank(ctx: Ctx, input: z.input<typeof SentInput>, options: RunOptions) {
  return runCommand(ctx, markSentToBankCommand, input, options)
}

const RevertInput = SentInput.extend({ reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH) })

export const revertSentCommand = defineCommand({
  name: 'paymentRun.revertSent',
  capability: 'paymentRun.file',
  input: RevertInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string }>> {
    const who = await finance(tx, ctx, 'paymentRun.file')
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.revertSent', input.version)
    if (!found.ok) return found
    // BR-PAY-11, FR-PAY-103 AC5: only while no item has its result
    if ((await tx.paymentRunItem.count({ where: { paymentRunId: found.run.id, status: { not: 'INCLUDED' } } })) > 0) return fail('INVALID_STATE_TRANSITION', 'a result is recorded already', { from: found.run.status, command: 'paymentRun.revertSent', reason: 'RESULTS_RECORDED' })
    await tx.paymentRun.update({ where: { id: found.run.id }, data: { status: found.to, sentToBankAt: null, version: { increment: 1 } } })
    // the reason is free text: kept as a Comment of the run, never in Event.data
    const comment = await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'PaymentRun', subjectId: found.run.id, authorMemberId: who.memberId, body: input.reason }, select: { id: true } })
    return { ok: true, result: { paymentRunId: found.run.id }, events: [{ type: 'payment_run.sent_reverted', aggregateType: 'PaymentRun', aggregateId: found.run.id, data: { reasonCommentId: comment.id } }] }
  },
})

export function revertPaymentRunSent(ctx: Ctx, input: z.input<typeof RevertInput>, options: RunOptions) {
  return runCommand(ctx, revertSentCommand, input, options)
}

// ---------- paymentRun.cancel after approval (FINANCE) ----------

const CancelInput = z.strictObject({
  paymentRunId: z.uuid(),
  version: z.number().int().min(0),
  reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH),
  /** BR-PAY-10, OQ-136: a file of the run was downloaded and was not sent to the bank */
  confirmNotSentToBank: z.boolean().optional(),
})

export const cancelApprovedRunCommand = defineCommand({
  name: 'paymentRun.cancelApproved',
  capability: 'paymentRun.cancel',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; afterExport: boolean }>> {
    const who = await finance(tx, ctx, 'paymentRun.cancel')
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.cancel', input.version)
    if (!found.ok) return found
    const { run, to } = found
    // a draft or a run waiting for approval is its preparer's to cancel (paymentRun.cancel of runs.ts)
    if (run.status !== 'APPROVED' && run.status !== 'FILE_READY') return fail('INVALID_STATE_TRANSITION', 'a run not approved yet is cancelled by its preparer', { from: run.status, command: 'paymentRun.cancel' })
    const afterExport = (await tx.paymentFile.count({ where: { paymentRunId: run.id, firstDownloadedAt: { not: null } } })) > 0
    if (afterExport && input.confirmNotSentToBank !== true) return fail('VALIDATION_FAILED', 'a file of the run was downloaded: confirm it was not sent to the bank', { field: 'confirmNotSentToBank', reason: 'EXPORT_CONFIRMATION_REQUIRED' })
    const released = await releaseAll(tx, ctx, run.id, input.reason, afterExport)
    if (!released.ok) return released
    await tx.paymentFile.updateMany({ where: { paymentRunId: run.id, status: 'CURRENT' }, data: { status: 'SUPERSEDED' } })
    await tx.paymentRun.update({ where: { id: run.id }, data: { status: to, cancelledAt: ctx.now, cancelReason: input.reason, version: { increment: 1 } } })
    // §10.1: the approvers and the preparer hear of it, with whether a file had been downloaded
    const recipients = [...new Set([...(await approversOf(tx, run)), run.preparedById])].filter((m) => m !== who.memberId)
    const notifications: NotificationDraft[] = recipients.map((m) => ({ recipientMemberId: m, templateKey: 'payment_run.cancelled', data: { paymentRunId: run.id, number: run.number, afterExport }, urgency: 'IMMEDIATE' as const, dedupeKey: `payment_run.cancelled:${run.id}:${m}`, subjectType: 'PAYMENT_RUN', subjectId: run.id }))
    return {
      ok: true,
      result: { paymentRunId: run.id, afterExport },
      events: [{ type: 'payment_run.cancelled', aggregateType: 'PaymentRun', aggregateId: run.id, data: { from: run.status as 'APPROVED' | 'FILE_READY', afterExport, documentCount: released.count } }, ...released.events],
      notifications,
    }
  },
})

export function cancelApprovedPaymentRun(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelApprovedRunCommand, input, options)
}

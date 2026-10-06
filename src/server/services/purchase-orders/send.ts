import { createHash } from 'node:crypto'
import { z } from 'zod'
import { formatSatang } from '@/core/money/format'
import { PO_MACHINE, transition, type PoState } from '@/core/state-machines'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { EmailSendError, getEmailProvider } from '@/integrations/email-provider'
import { putObject } from '@/integrations/storage'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { NotificationDraft } from '@/server/notifications/create'
import { poEmail } from '@/server/notifications/templates/po-email'
import { printablePurchaseOrder } from '@/server/pdf/printable'
import { renderPdf } from '@/server/pdf/render'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { departmentReceivers } from '../receiving/receivers'

// Sending a PO to its supplier (spec §6.4 APPROVED → po.send → SENT, FR-P2P-005): PROCUREMENT e-mails the approved PO
// with its PDF (FR-PLT-009), reply-to the sender, and the PO becomes SENT with sentAt and sentToEmail. The e-mail goes
// out inside the command once the PO row is locked, so two people pressing "send" together send it once, and the
// transaction is never retried, so a retry never sends twice. A mail server that refuses the message is a bounce
// (AC2): the PO keeps its status, the bounce is kept on the PO and PROCUREMENT is told. A provider that cannot be
// reached changes nothing and says so. Sending again — after a bounce, or when the supplier asks for the PO again
// while goods are still to come — needs a reason, and each send is an event (AC3).

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'EXTERNAL_SERVICE_ERROR'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** First sends go from APPROVED; a PO is sent again while goods are still to come */
const SENDABLE: readonly string[] = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED']
const MIN_REASON_LENGTH = 3
const PDF_MIME = 'application/pdf'

const SendInput = z.strictObject({
  poId: z.uuid(),
  /** Required on every send after the first, the one after a bounce included (AC3) */
  reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH).optional(),
})

export interface SendPoResult {
  readonly poId: string
  readonly status: string
  readonly sent: boolean
  /** The refusal's code when the e-mail bounced ("SMTP_550"), else null */
  readonly bounce: string | null
  readonly pdfFileId: string
}

/** Who hears that a PO went out (§10.1 po.sent): the requesters of its PRs and the RECEIVERs of their departments */
async function sentRecipients(tx: TenantTx, ctx: Ctx, poId: string): Promise<Array<{ memberId: string; forReceiver: boolean }>> {
  const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId } } } } } }, select: { requesterMemberId: true, requesterDepartmentId: true } })
  const receivers = await departmentReceivers(tx, ctx.organizationId, [...new Set(requests.map((r) => r.requesterDepartmentId))], ctx.now)
  const out = new Map<string, boolean>()
  for (const r of requests) out.set(r.requesterMemberId, false)
  for (const memberId of receivers) out.set(memberId, true)
  return [...out].map(([memberId, forReceiver]) => ({ memberId, forReceiver }))
}

export const sendPoCommand = defineCommand({
  name: 'po.send',
  capability: 'po.send',
  input: SendInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<SendPoResult>> {
    const allowed = await authorize(tx, ctx, 'po.send')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const actor = allowed.data.memberId
    const [locked] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [input.poId])
    if (!locked) return fail('NOT_FOUND', 'purchase order not found')
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: input.poId }, include: { supplier: { select: { nameTh: true, email: true } } } })
    if (!SENDABLE.includes(po.status)) return fail('INVALID_STATE_TRANSITION', `po.send is not allowed from ${po.status}`, { from: po.status, command: 'po.send' })
    const resend = po.sentAt !== null || po.sendBouncedAt !== null
    if (resend && !input.reason) return fail('VALIDATION_FAILED', 'a reason is needed to send the purchase order again', { field: 'reason', reason: 'REQUIRED' })
    // §6.4 guard: the supplier has an e-mail address
    const to = po.supplier.email?.trim()
    if (!to) return fail('VALIDATION_FAILED', 'the supplier has no e-mail address', { field: 'supplierEmail', reason: 'MISSING' })
    const moved = po.status === 'APPROVED' ? transition(PO_MACHINE, po.status as PoState, 'po.send') : null
    if (moved && !moved.ok) return fail('INVALID_STATE_TRANSITION', `po.send is not allowed from ${po.status}`, { from: po.status, command: 'po.send' })

    // The PDF (FR-PLT-009), kept and linked to the PO as PO_PDF
    const document = await printablePurchaseOrder(tx, ctx.organizationId, po.id, ctx.now)
    const pdf = await renderPdf(document)
    const pdfFileId = newId()
    const storageKey = `org/${ctx.organizationId}/${pdfFileId}`
    await putObject(storageKey, pdf, PDF_MIME)
    const fileName = `${document.number}.pdf`
    await tx.fileObject.create({
      data: { id: pdfFileId, organizationId: ctx.organizationId, storageKey, fileName, mimeType: PDF_MIME, sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), status: 'AVAILABLE', uploadedById: actor, scanStatus: 'NOT_REQUIRED' },
    })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: pdfFileId, subjectType: 'PurchaseOrder', subjectId: po.id, kind: 'PO_PDF' } })
    const reasonCommentId = input.reason ? newId() : null
    if (reasonCommentId) await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: 'PurchaseOrder', subjectId: po.id, authorMemberId: actor, body: input.reason! } })

    const sender = await tx.member.findUniqueOrThrow({ where: { id: actor }, select: { displayNameTh: true, email: true } })
    const mail = poEmail({ supplierName: po.supplier.nameTh, organizationName: document.organization.name, poNumber: document.number, gross: formatSatang(po.grossSatang), senderName: sender.displayNameTh, resend })
    let bounce: string | null = null
    try {
      await getEmailProvider().send({ to, replyTo: sender.email, ...mail, attachments: [{ filename: fileName, content: pdf, contentType: PDF_MIME }] })
    } catch (error) {
      if (!(error instanceof EmailSendError) || !error.permanent) {
        return fail('EXTERNAL_SERVICE_ERROR', 'the e-mail service could not be reached; nothing was sent', { service: 'email', code: error instanceof EmailSendError ? error.code : 'UNKNOWN' })
      }
      bounce = error.code
    }

    if (bounce !== null) {
      // AC2: the PO keeps its status; the bounce is kept and procurement is told
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { pdfFileId, sendBouncedAt: ctx.now, sendBounceReason: bounce, version: { increment: 1 } } })
      const procurement = await tx.roleAssignment.findMany({ where: { role: 'PROCUREMENT', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
      const notifications: NotificationDraft[] = [...new Set(procurement.map((p) => p.memberId))].map((memberId) => ({
        recipientMemberId: memberId,
        templateKey: 'po.send_bounced',
        data: { poId: po.id, number: document.number },
        urgency: 'IMMEDIATE',
        dedupeKey: `po.send_bounced:${pdfFileId}:${memberId}`,
        subjectType: 'PURCHASE_ORDER',
        subjectId: po.id,
      }))
      return {
        ok: true,
        result: { poId: po.id, status: po.status, sent: false, bounce, pdfFileId },
        events: [{ type: 'po.send_bounced', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { status: po.status, code: bounce, resend, reasonCommentId, pdfFileId } }],
        notifications,
      }
    }

    const status = moved?.ok ? moved.to : po.status
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { status, pdfFileId, sentAt: ctx.now, sentToEmail: to, sendBouncedAt: null, sendBounceReason: null, version: { increment: 1 } } })
    const notifications: NotificationDraft[] = (await sentRecipients(tx, ctx, po.id)).map((r) => ({
      recipientMemberId: r.memberId,
      templateKey: 'po.sent',
      data: { poId: po.id, number: document.number, forReceiver: r.forReceiver },
      urgency: 'DIGEST',
      dedupeKey: `po.sent:${pdfFileId}:${r.memberId}`,
      subjectType: 'PURCHASE_ORDER',
      subjectId: po.id,
    }))
    return {
      ok: true,
      result: { poId: po.id, status, sent: true, bounce: null, pdfFileId },
      events: [{ type: 'po.sent', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { from: po.status, resend, reasonCommentId, pdfFileId } }],
      notifications,
    }
  },
})

/** The command never retries its transaction: the e-mail inside it must not go out twice */
export function sendPurchaseOrder(ctx: Ctx, input: z.input<typeof SendInput>, options: RunOptions) {
  return runCommand(ctx, sendPoCommand, input, { ...options, maxRetries: 0 })
}

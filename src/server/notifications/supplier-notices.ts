import { formatSatang } from '@/core/money/format'
import { getEmailProvider, EmailSendError } from '@/integrations/email-provider'
import { MS_PER_MINUTE } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { logger } from '@/lib/logger'
import { systemCtx, type Ctx } from '@/server/context'
import { pendingSupplierNotices } from '@/server/db/sql/supplier-notices'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from './create'

// E-mails to a supplier (ADR-126, BR-AP-08, FR-AP-103 AC3): a command that tells the supplier something calls
// enqueueSupplierNotice inside its own transaction; the row (SupplierNotice) carries what the template shows and a
// dedupeKey, so the same reason for the same document never makes a second row however often the command is sent. The
// job supplier-notice-send sends it after commit: SENT once, FAILED when the provider refuses for good, and a supplier
// without an e-mail address is NO_EMAIL: nothing is sent and FINANCE is told in the app. Every result is an event (supplier_notice.sent,
// supplier_notice.failed) naming the template and the document. S9 registers its own templates (payment.advice,
// bank_account.notice) with registerSupplierTemplate. No approver's name, no unit price, no account number.

export interface SupplierEmail {
  readonly subject: string
  readonly text: string
  readonly html: string
}

export type SupplierTemplate = (data: Readonly<Record<string, unknown>>, context: { readonly organizationName: string; readonly supplierName: string }) => SupplierEmail

const templates = new Map<string, SupplierTemplate>()

/** The template keys of S8 (BR-AP-08) */
export const SUPPLIER_TEMPLATES = { invoiceReceived: 'supplier.invoice_received', invoiceRejected: 'supplier.invoice_rejected', invoiceReady: 'supplier.invoice_ready' } as const

/** Each lane adds its own templates (S8 invoices here, S9 payments in its files) */
export function registerSupplierTemplate(key: string, template: SupplierTemplate): void {
  templates.set(key, template)
}

export interface SupplierNoticeInput {
  readonly templateKey: string
  readonly supplierId: string
  readonly subjectType: string
  readonly subjectId: string
  /** Unique per organization: the same key never makes a second notice (e.g. `invoice_ready:<invoiceId>`) */
  readonly dedupeKey: string
  readonly data: Readonly<Record<string, unknown>>
}

export const SUPPLIER_NOTICE_EVENT = 'bcs/supplier_notice.requested'

/**
 * Writes the notice in the caller's transaction and returns the outbox draft that sends it (none when the dedupeKey was
 * used before, or when the supplier has no e-mail address: that one is stored NO_EMAIL with its supplier_notice.failed
 * event and an in-app notice to FINANCE, which the caller returns with its own).
 */
export interface SupplierNoticeEffects {
  readonly outbox: OutboxDraft[]
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
}

export async function enqueueSupplierNotice(tx: TenantTx, ctx: Ctx, input: SupplierNoticeInput): Promise<SupplierNoticeEffects & { noticeId: string | null }> {
  if (!templates.has(input.templateKey)) throw new Error(`no supplier template ${input.templateKey}`)
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: input.supplierId }, select: { email: true } })
  const id = newId()
  const inserted = await tx.supplierNotice.createManyAndReturn({
    data: [
      {
        id,
        organizationId: ctx.organizationId,
        supplierId: input.supplierId,
        templateKey: input.templateKey,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        toEmail: supplier.email,
        data: input.data as object,
        status: supplier.email ? 'PENDING' : 'NO_EMAIL',
        dedupeKey: input.dedupeKey,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  })
  if (inserted.length === 0) return { outbox: [], events: [], notifications: [], noticeId: null }
  if (!supplier.email) {
    const finance = await tx.roleAssignment.findMany({ where: { role: 'FINANCE', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true }, distinct: ['memberId'] })
    return {
      outbox: [],
      events: [{ type: 'supplier_notice.failed', aggregateType: 'SupplierNotice', aggregateId: id, data: { noticeId: id, templateKey: input.templateKey, subjectType: input.subjectType, subjectId: input.subjectId, reason: 'NO_EMAIL' } }],
      notifications: finance.map((f) => ({
        recipientMemberId: f.memberId,
        templateKey: 'supplier.no_email',
        data: { supplierId: input.supplierId, subjectType: input.subjectType, subjectId: input.subjectId, number: input.data.number ?? null },
        urgency: 'IMMEDIATE' as const,
        dedupeKey: `supplier.no_email:${id}:${f.memberId}`,
      })),
      noticeId: id,
    }
  }
  return { outbox: [{ eventName: SUPPLIER_NOTICE_EVENT, payload: { organizationId: ctx.organizationId, noticeId: id } }], events: [], notifications: [], noticeId: id }
}

export type SupplierNoticeOutcome = 'SENT' | 'FAILED' | 'SKIPPED'

/** Sends one notice once (the job, and tests directly): a notice that is not PENDING any more is left alone */
export async function sendSupplierNotice(organizationId: string, noticeId: string, now: Date): Promise<SupplierNoticeOutcome> {
  const db = forTenant(organizationId)
  const notice = await db.supplierNotice.findUnique({ where: { id: noticeId }, include: { supplier: { select: { nameTh: true } } } })
  if (!notice || notice.status !== 'PENDING' || !notice.toEmail) return 'SKIPPED'
  // Claim it first, so two runs never send it twice
  const claimed = await db.supplierNotice.updateMany({ where: { id: noticeId, status: 'PENDING', attempts: notice.attempts }, data: { attempts: { increment: 1 } } })
  if (claimed.count === 0) return 'SKIPPED'
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { legalNameTh: true, displayName: true } })
  const template = templates.get(notice.templateKey)
  const ctx = systemCtx(organizationId, now, 'supplier-notice-send')
  const eventData = { noticeId, templateKey: notice.templateKey, subjectType: notice.subjectType, subjectId: notice.subjectId }
  if (!template) {
    await db.$transaction(async (tx) => {
      await tx.supplierNotice.update({ where: { id: noticeId }, data: { status: 'FAILED', error: 'TEMPLATE_UNKNOWN' } })
      await appendEvents(tx, ctx, [{ type: 'supplier_notice.failed', aggregateType: 'SupplierNotice', aggregateId: noticeId, data: { ...eventData, reason: 'TEMPLATE_UNKNOWN' } }])
    })
    return 'FAILED'
  }
  const email = template(notice.data as Record<string, unknown>, { organizationName: org.displayName ?? org.legalNameTh, supplierName: notice.supplier.nameTh })
  try {
    await getEmailProvider().send({ to: notice.toEmail, subject: email.subject, text: email.text, html: email.html })
  } catch (error) {
    const permanent = error instanceof EmailSendError && error.permanent
    logger.warn({ noticeId, templateKey: notice.templateKey, permanent }, 'supplier notice not sent')
    if (!permanent) throw error
    await db.$transaction(async (tx) => {
      await tx.supplierNotice.update({ where: { id: noticeId }, data: { status: 'FAILED', error: 'PROVIDER_REFUSED' } })
      await appendEvents(tx, ctx, [{ type: 'supplier_notice.failed', aggregateType: 'SupplierNotice', aggregateId: noticeId, data: { ...eventData, reason: 'PROVIDER_REFUSED' } }])
    })
    return 'FAILED'
  }
  await db.$transaction(async (tx) => {
    await tx.supplierNotice.update({ where: { id: noticeId }, data: { status: 'SENT', sentAt: now } })
    await appendEvents(tx, ctx, [{ type: 'supplier_notice.sent', aggregateType: 'SupplierNotice', aggregateId: noticeId, data: eventData }])
  })
  return 'SENT'
}

// ---------- the S8 templates (BR-AP-08) ----------

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const money = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? formatSatang(BigInt(v)) : '')

function mail(subject: string, thai: string[], english: string[]): SupplierEmail {
  const text = [...thai, '', ...english, ''].join('\n')
  const html = [
    '<div style="font-family: sans-serif; font-size: 15px; line-height: 1.6">',
    ...thai.map((l) => `<p>${escapeHtml(l)}</p>`),
    '<hr style="border: none; border-top: 1px solid #ddd">',
    ...english.map((l) => `<p style="color: #555">${escapeHtml(l)}</p>`),
    '</div>',
  ].join('\n')
  return { subject, text, html }
}

registerSupplierTemplate(SUPPLIER_TEMPLATES.invoiceReceived, (d, c) =>
  mail(
    `${c.organizationName} ได้รับใบแจ้งหนี้ ${str(d.supplierInvoiceNo)} แล้ว / Invoice received`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ได้รับใบแจ้งหนี้เลขที่ ${str(d.supplierInvoiceNo)} ของท่านแล้ว เลขอ้างอิงของเราคือ ${str(d.number)}`, 'เราจะแจ้งให้ทราบอีกครั้งเมื่อใบแจ้งหนี้พร้อมจ่าย'],
    [`${c.organizationName} has received your invoice ${str(d.supplierInvoiceNo)}. Our reference is ${str(d.number)}.`, 'We will write again when it is ready for payment.'],
  ),
)
registerSupplierTemplate(SUPPLIER_TEMPLATES.invoiceRejected, (d, c) =>
  mail(
    `ใบแจ้งหนี้ ${str(d.supplierInvoiceNo)} ไม่ได้รับการยอมรับ / Invoice not accepted`,
    [`เรียน ${c.supplierName}`, `${c.organizationName} ไม่สามารถรับใบแจ้งหนี้เลขที่ ${str(d.supplierInvoiceNo)} ได้ ด้วยเหตุผล: ${str(d.reason)}`, 'โปรดส่งใบแจ้งหนี้ที่แก้ไขแล้วมาอีกครั้ง'],
    [`${c.organizationName} could not accept your invoice ${str(d.supplierInvoiceNo)}. Reason: ${str(d.reason)}`, 'Please send a corrected invoice.'],
  ),
)
registerSupplierTemplate(SUPPLIER_TEMPLATES.invoiceReady, (d, c) => {
  const wht = money(d.expectedWhtSatang)
  const withholding = wht && d.expectedWhtSatang !== '0'
  return mail(
    `ใบแจ้งหนี้ ${str(d.supplierInvoiceNo)} พร้อมจ่าย / Invoice ready for payment`,
    [
      `เรียน ${c.supplierName}`,
      `ใบแจ้งหนี้เลขที่ ${str(d.supplierInvoiceNo)} (อ้างอิง ${str(d.number)}) ผ่านการตรวจแล้ว ครบกำหนดชำระวันที่ ${str(d.dueDate)} ยอดที่ต้องจ่าย ${money(d.payableSatang)} บาท`,
      ...(withholding ? [`ภาษีหัก ณ ที่จ่ายคาดการณ์ ${wht} บาท จะหักตอนจ่ายพร้อมหนังสือรับรอง`] : []),
    ],
    [
      `Your invoice ${str(d.supplierInvoiceNo)} (our reference ${str(d.number)}) is approved, due on ${str(d.dueDate)}, amount THB ${money(d.payableSatang)}.`,
      ...(withholding ? [`Expected withholding tax of THB ${wht} is deducted at payment with its certificate.`] : []),
    ],
  )
})

/** Notices waiting longer than this are picked up by the sweep of supplier-notice-send */
export const SUPPLIER_NOTICE_SWEEP_AFTER_MS = MS_PER_MINUTE
const SWEEP_BATCH = 50

/** The sweep: PENDING notices older than a minute, oldest first; returns how many it sent */
export async function sweepSupplierNotices(now: Date): Promise<number> {
  const due = await pendingSupplierNotices(new Date(now.getTime() - SUPPLIER_NOTICE_SWEEP_AFTER_MS), SWEEP_BATCH)
  let sent = 0
  for (const n of due) if ((await sendSupplierNotice(n.organizationId, n.id, now)) === 'SENT') sent++
  return sent
}

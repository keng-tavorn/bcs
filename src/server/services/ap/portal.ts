import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { presignDownload } from '@/integrations/storage'
import { supplierSettingsOf } from '@/lib/org-settings'
import { MS_PER_DAY, MS_PER_HOUR } from '@/lib/constants'
import { PORTAL_INVOICE_DRAFTS_PER_DAY, PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import type { Ctx } from '@/server/context'
import { countPortalScopeHit } from '@/server/db/portal'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { invoiceFilePrefix } from '../invoices/etax'
import { requireModule } from '../modules'
import { fail, INVOICEABLE_PO_STATUSES, type Fail } from './common'

// The portal's channel of a tier-2 invoice (S7-12 · BR-SUP ข้อ 15 · FR-AP-101 AC7 · FR-AP-103 AC5 · FR-PAY-103 AC8 ·
// ADR-188): S8's own commands invoice.store_file, invoice.create and invoice.update take a supplier contact as their
// actor, checked here instead of FINANCE's guard — the contact of an ACTIVE supplier, on its own supplier, with SUPPLIER
// and PAY on and supplier.portalInvoice true (the rule of portalAuthorize 'portal.invoice.submit', asked again here). A file from the portal is kept
// under a key of its PO and its contact, PENDING until the central scan calls it clean (BR-PORTAL ข้อ 07); FINANCE opens
// it only then (files/getDownloadUrl). The match never reads the channel. The supplier reads its 50 ทวิ here too.

/** Where a contact's invoice files of a PO are kept: the PO's own prefix, then the contact (nobody else's file is taken) */
export const portalInvoiceFilePrefix = (organizationId: string, poId: string, contactId: string): string => `${invoiceFilePrefix(organizationId, poId)}portal/${contactId}/`

/** Whether the organization lets suppliers send invoices on the portal: PAY on and supplier.portalInvoice (OQ-187) */
export async function portalInvoicesOn(ctx: Ctx, tx?: TenantTx): Promise<boolean> {
  const db = tx ?? forTenant(ctx.organizationId)
  if (!(await requireModule(ctx, 'PAY', tx)).ok) return false
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  return supplierSettingsOf(org.settings).portalInvoice
}

export interface PortalInvoiceContact {
  readonly ok: true
  readonly contactId: string
  readonly supplierId: string
}

/**
 * The contact who sends an invoice on the portal (BR-SUP ข้อ 15 · BR-SUP ข้อ 16): a portal request of an ACTIVE contact of
 * an ACTIVE supplier, with SUPPLIER and PAY on and supplier.portalInvoice true (MODULE_DISABLED otherwise), the current
 * privacy notice accepted (BR-PORTAL ข้อ 08). The portal's rule is asked again here because a service never trusts its caller.
 */
export async function portalInvoiceContact(tx: TenantTx, ctx: Ctx): Promise<PortalInvoiceContact | Fail> {
  if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL') return fail('FORBIDDEN', 'not a portal request')
  const supplierOn = await requireModule(ctx, 'SUPPLIER', tx)
  if (!supplierOn.ok) return { ok: false, error: supplierOn.error }
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  if (!(await portalInvoicesOn(ctx, tx))) return fail('MODULE_DISABLED', 'invoices are not taken on the portal', { module: 'PAY', setting: 'supplier.portalInvoice' })
  const refused = fail('FORBIDDEN', 'a contact sends the invoices of its own supplier only', { action: 'portal.invoice.submit' })
  const supplierId = ctx.actor.supplierId
  if (!supplierId) return refused
  const contact = await tx.supplierContact.findUnique({ where: { id: ctx.actor.supplierContactId }, select: { status: true, portalEnabled: true, supplierId: true, privacyNoticeVersion: true, supplier: { select: { status: true } } } })
  if (!contact || contact.status !== 'ACTIVE' || !contact.portalEnabled || contact.supplierId !== supplierId) return refused
  // portal.invoice.submit: the contact's supplier is ACTIVE (PAY and portalInvoice were checked above)
  if (contact.supplier?.status !== 'ACTIVE') return refused
  if (contact.privacyNoticeVersion !== PORTAL_PRIVACY_NOTICE_VERSION) return fail('PRIVACY_NOTICE_OUTDATED', 'the current privacy notice is not accepted yet', { version: PORTAL_PRIVACY_NOTICE_VERSION })
  return { ok: true, contactId: ctx.actor.supplierContactId, supplierId }
}

/** A PO of the contact's own supplier that takes an invoice (BR-MATCH-05); another supplier's is not found (INV-SUP-01) */
export async function ownInvoiceablePo(tx: TenantTx, supplierId: string, poId: string): Promise<boolean> {
  // and on the track of tier-2 invoices, or on none yet (BR-IVC-06 · the list of /portal/<org>/invoices/new says the same)
  return (await tx.purchaseOrder.count({ where: { id: poId, supplierId, status: { in: [...INVOICEABLE_PO_STATUSES] }, OR: [{ invoiceTrack: 'MATCHING' }, { invoiceTrack: null }] } })) > 0
}

/** Counts one draft of the supplier today (Bangkok); true while within PORTAL_INVOICE_DRAFTS_PER_DAY (BR-PORTAL ข้อ 04) */
export async function withinInvoiceDraftLimit(organizationId: string, supplierId: string, now: Date): Promise<boolean> {
  // the day of Asia/Bangkok (UTC+7 all year): midnight there is 17:00 UTC the day before
  const offset = 7 * MS_PER_HOUR
  const windowStart = new Date(Math.floor((now.getTime() + offset) / MS_PER_DAY) * MS_PER_DAY - offset)
  return (await countPortalScopeHit(organizationId, { kind: 'SUPPLIER', key: supplierId }, 'INVOICE', windowStart)) <= PORTAL_INVOICE_DRAFTS_PER_DAY
}

/** The DIGEST notice to FINANCE of a draft from the portal waiting to be checked (invoice.portal_drafted · §10.1) */
export async function financeOfPortalDraft(tx: TenantTx, invoiceId: string, supplierId: string, poNumber: string | null): Promise<NotificationDraft[]> {
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { code: true } })
  const finance = await tx.roleAssignment.findMany({ where: { role: 'FINANCE', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true }, distinct: ['memberId'], orderBy: { memberId: 'asc' } })
  return finance.map((f) => ({
    recipientMemberId: f.memberId,
    templateKey: 'invoice.portal_drafted',
    data: { invoiceId, code: supplier?.code ?? '', poNumber: poNumber ?? '' },
    urgency: 'DIGEST' as const,
    dedupeKey: `invoice.portal_drafted:${invoiceId}:${f.memberId}`,
    subjectType: 'Invoice',
    subjectId: invoiceId,
  }))
}

// ---------- the 50 ทวิ of a payment, for the supplier (FR-PAY-103 AC8) ----------

const WHT_TTL_SECONDS = 300

const whtDownloadCommand = defineCommand({
  name: 'portal.whtCertificate.download',
  capability: 'portal.invoice.view',
  input: z.strictObject({ certificateId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ storageKey: string; fileName: string }>> {
    if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL' || !ctx.actor.supplierId) return fail('FORBIDDEN', 'not a portal request')
    const supplierOn = await requireModule(ctx, 'SUPPLIER', tx)
    if (!supplierOn.ok) return { ok: false, error: supplierOn.error }
    if (!(await portalInvoicesOn(ctx, tx))) return fail('MODULE_DISABLED', 'payments are not shown on the portal', { module: 'PAY', setting: 'supplier.portalInvoice' })
    const contact = await tx.supplierContact.findUnique({ where: { id: ctx.actor.supplierContactId }, select: { status: true, portalEnabled: true, supplierId: true, supplier: { select: { status: true } } } })
    // portal.invoice.view: an ACTIVE contact of its own ACTIVE supplier (PAY and portalInvoice were checked above)
    if (!contact || contact.status !== 'ACTIVE' || !contact.portalEnabled || contact.supplierId !== ctx.actor.supplierId || contact.supplier?.status !== 'ACTIVE') return fail('FORBIDDEN', 'a contact reads its own supplier’s certificates only', { action: 'portal.invoice.view' })
    // another supplier's certificate is not found, as one that does not exist (INV-SUP-01)
    const cert = await tx.whtCertificate.findFirst({ where: { id: input.certificateId, supplierId: ctx.actor.supplierId }, select: { fileId: true, file: { select: { storageKey: true, fileName: true, status: true } } } })
    if (!cert?.fileId || !cert.file || cert.file.status !== 'AVAILABLE') return fail('NOT_FOUND', 'certificate not found')
    return { ok: true, result: { storageKey: cert.file.storageKey, fileName: cert.file.fileName }, events: [{ type: 'file.downloaded', aggregateType: 'File', aggregateId: cert.fileId, data: { fileId: cert.fileId } }] }
  },
})

/** The 50 ทวิ of the contact's own supplier as an address of five minutes, logged as file.downloaded (a POST, never a GET) */
export async function whtCertificateUrlForContact(ctx: Ctx, input: { certificateId: string }, options: RunOptions): Promise<Result<{ url: string; expiresInSeconds: number }>> {
  const r = await runCommand(ctx, whtDownloadCommand, input, options)
  if (!r.ok) return err(r.error.code, r.error.message, r.error.details)
  return ok({ url: await presignDownload(r.data.storageKey, { fileName: r.data.fileName, contentType: 'application/pdf', inline: true }, WHT_TTL_SECONDS), expiresInSeconds: WHT_TTL_SECONDS })
}

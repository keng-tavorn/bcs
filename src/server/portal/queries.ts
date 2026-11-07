import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { portalWhere } from './db'
import { PORTAL_PRIVACY_NOTICE_VERSION } from './privacy'

// Queries of the portal (BR-PORTAL ข้อ 05 · INV-SUP-01): each reads through portalWhere, so a contact sees only its own
// supplier or application. tests/generated/portal-isolation.test.ts calls every export of this file (and of
// queries-<step>.ts of S10 S11) as two suppliers and two applications and fails on a row of the other one.

export interface PortalHomeView {
  readonly contact: { readonly nameTh: string; readonly locale: string }
  /** The privacy notice to accept before anything else, or null when the current one is accepted (BR-PORTAL ข้อ 08) */
  readonly privacyNoticeDue: string | null
  readonly supplier: { readonly id: string; readonly nameTh: string; readonly code: string } | null
  readonly application: { readonly id: string; readonly number: string | null; readonly status: string; readonly nameTh: string } | null
}

/** The portal's home: who is signed in, for whom, and what waits for them */
export async function getPortalHome(ctx: Ctx): Promise<PortalHomeView> {
  if (ctx.actor.type !== 'SUPPLIER') throw new Error('a portal query needs a portal context')
  const db = forTenant(ctx.organizationId)
  const contact = await db.supplierContact.findFirstOrThrow({
    where: { AND: [portalWhere(ctx, 'supplierContact'), { id: ctx.actor.supplierContactId }] },
    select: { nameTh: true, locale: true, privacyNoticeVersion: true, supplier: { select: { id: true, nameTh: true, code: true } } },
  })
  const application = await db.supplierApplication.findFirst({
    where: portalWhere(ctx, 'supplierApplication'),
    orderBy: [{ invitedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, number: true, status: true, nameTh: true },
  })
  return {
    contact: { nameTh: contact.nameTh, locale: contact.locale },
    privacyNoticeDue: contact.privacyNoticeVersion === PORTAL_PRIVACY_NOTICE_VERSION ? null : PORTAL_PRIVACY_NOTICE_VERSION,
    supplier: contact.supplier,
    application,
  }
}

export interface PortalContactRow {
  readonly id: string
  readonly nameTh: string
  readonly roleLabel: string | null
  readonly isPrimary: boolean
}

/** The other contacts of the same supplier or application (names and roles only, never their e-mails) */
export async function listPortalContacts(ctx: Ctx): Promise<PortalContactRow[]> {
  return forTenant(ctx.organizationId).supplierContact.findMany({
    where: { AND: [portalWhere(ctx, 'supplierContact'), { status: 'ACTIVE' }] },
    orderBy: [{ isPrimary: 'desc' }, { nameTh: 'asc' }, { id: 'asc' }],
    select: { id: true, nameTh: true, roleLabel: true, isPrimary: true },
  })
}

export interface PortalDocumentTypeRow {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string
  readonly required: boolean
}

/** The document types the contact's supplier or application may send: active, for its payee type (BR-SDOC ข้อ 01) */
export async function listPortalDocumentTypes(ctx: Ctx): Promise<PortalDocumentTypeRow[]> {
  if (ctx.actor.type !== 'SUPPLIER') throw new Error('a portal query needs a portal context')
  const db = forTenant(ctx.organizationId)
  const payee = ctx.actor.supplierId
    ? (await db.supplier.findFirst({ where: portalWhere(ctx, 'supplier'), select: { payeeType: true } }))?.payeeType
    : (await db.supplierApplication.findFirst({ where: portalWhere(ctx, 'supplierApplication'), select: { payeeType: true } }))?.payeeType
  if (!payee) return []
  return db.supplierDocumentType.findMany({
    where: { AND: [portalWhere(ctx, 'supplierDocumentType'), { appliesTo: { has: payee } }] },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: { code: true, nameTh: true, nameEn: true, required: true },
  })
}

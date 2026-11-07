import { z } from 'zod'
import { err, ok, type AppError, type Result } from '@/core/result'
import { getEnv } from '@/lib/env'
import { isAllowed, loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { requireModule } from '../modules'
import { supplierAccess } from './access'
import { supplierDocumentStatus, type DocumentState } from './documents'

// The portal tabs of /suppliers/[id] as the screen shows them (S7-09 · docs/sub-specs/S7.md "หน้าจอ" · FR-SUP-101 AC6):
// the supplier's contacts, the POs sent to it with their acknowledgement, whether it may use the portal, and the state
// of its documents by type (BR-SDOC ข้อ 06). Read only: every change goes through the commands of ./contacts.ts.
// Each read needs module SUPPLIER and supplier.view in full (§2.4: PROCUREMENT FINANCE AUDITOR — the contacts are not
// a basic detail). A contact's e-mail and phone leave the server only for supplier.contact.manage (PROCUREMENT), who
// adds and changes contacts; the others read who the contacts are, not how to reach them (least personal data). The POs
// need po.view over the organization, as the register's prices do (FR-VIS-006 AC1).

const SupplierId = z.uuid()
/** The newest POs the tab lists; older ones stay on /procurement/pos */
export const SUPPLIER_PO_ACK_LIMIT = 50

type Fail = { readonly ok: false; readonly error: AppError }

interface Reader {
  readonly principal: Principal
  readonly canManage: boolean
  readonly portalEnabled: boolean
  readonly supplierStatus: 'ACTIVE' | 'INACTIVE'
}

/** Module SUPPLIER, supplier.view in full, and the supplier itself; a refusal otherwise */
async function readerOf(tx: TenantTx, ctx: Ctx, supplierId: string): Promise<Reader | Fail> {
  const on = await requireModule(ctx, 'SUPPLIER', tx)
  if (!on.ok) return on as Fail
  const principal = await loadPrincipal(tx, ctx)
  const access = supplierAccess(principal)
  if (!access) return err('FORBIDDEN', 'missing capability supplier.view', { capability: 'supplier.view' }) as Fail
  if (access.level !== 'FULL') return err('FORBIDDEN', 'the contacts of a supplier are not a basic detail', { capability: 'supplier.view', reason: 'BASIC_FIELDS_ONLY' }) as Fail
  if (!SupplierId.safeParse(supplierId).success) return err('NOT_FOUND', 'supplier not found') as Fail
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { portalEnabled: true, status: true } })
  if (!supplier) return err('NOT_FOUND', 'supplier not found') as Fail
  return { principal, canManage: isAllowed(principal, 'supplier.contact.manage'), portalEnabled: supplier.portalEnabled, supplierStatus: supplier.status }
}

const refused = (r: Reader | Fail): r is Fail => 'ok' in r

// ---------- contacts ----------

export interface SupplierContactRowDto {
  readonly id: string
  readonly version: number
  readonly nameTh: string
  readonly nameEn: string | null
  readonly roleLabel: string | null
  /** supplier.contact.manage only; null for everyone else */
  readonly email: string | null
  readonly phone: string | null
  readonly isPrimary: boolean
  readonly locale: string
  readonly portalEnabled: boolean
  readonly status: 'ACTIVE' | 'DEACTIVATED'
  /** ISO 8601 UTC: the first sign-in on the portal (BR-SUP ข้อ 17), and the latest moment a session was used */
  readonly firstSignedInAt: string | null
  readonly lastSeenAt: string | null
  /** Sessions not revoked and not past their end, as of ctx.now */
  readonly liveSessions: number
  readonly deactivatedAt: string | null
}

export interface SupplierContactsDto {
  readonly canManage: boolean
  /** Whether the reader is shown e-mails and phones */
  readonly seesAddresses: boolean
  /** The active contacts first, the primary one at the top; then the closed ones */
  readonly rows: readonly SupplierContactRowDto[]
}

async function contactsIn(tx: TenantTx, ctx: Ctx, supplierId: string, seesAddresses: boolean): Promise<SupplierContactRowDto[]> {
  const contacts = await tx.supplierContact.findMany({
    where: { supplierId },
    select: { id: true, version: true, nameTh: true, nameEn: true, roleLabel: true, email: true, phone: true, isPrimary: true, locale: true, portalEnabled: true, status: true, firstSignedInAt: true, deactivatedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const sessions = contacts.length
    ? await tx.portalSession.findMany({ where: { contactId: { in: contacts.map((c) => c.id) } }, select: { contactId: true, lastSeenAt: true, revokedAt: true, expiresAt: true } })
    : []
  const rank = (c: (typeof contacts)[number]) => (c.status === 'ACTIVE' ? (c.isPrimary ? 0 : 1) : 2)
  return [...contacts]
    .sort((a, b) => rank(a) - rank(b))
    .map((c) => {
      const mine = sessions.filter((s) => s.contactId === c.id)
      const last = mine.reduce<Date | null>((max, s) => (!max || s.lastSeenAt > max ? s.lastSeenAt : max), null)
      return {
        id: c.id,
        version: c.version,
        nameTh: c.nameTh,
        nameEn: c.nameEn,
        roleLabel: c.roleLabel,
        email: seesAddresses ? c.email : null,
        phone: seesAddresses ? c.phone : null,
        isPrimary: c.isPrimary,
        locale: c.locale,
        portalEnabled: c.portalEnabled,
        status: c.status,
        firstSignedInAt: c.firstSignedInAt?.toISOString() ?? null,
        lastSeenAt: last?.toISOString() ?? null,
        liveSessions: mine.filter((s) => s.revokedAt === null && s.expiresAt > ctx.now).length,
        deactivatedAt: c.deactivatedAt?.toISOString() ?? null,
      }
    })
}

/** The "ผู้ติดต่อ" tab: who may act for the supplier on the portal, with the actions of supplier.contact.manage */
export async function listSupplierContactsForScreen(ctx: Ctx, supplierId: string): Promise<Result<SupplierContactsDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const reader = await readerOf(tx, ctx, supplierId)
    if (refused(reader)) return reader
    return ok({ canManage: reader.canManage, seesAddresses: reader.canManage, rows: await contactsIn(tx, ctx, supplierId, reader.canManage) })
  })
}

// ---------- the POs sent and their acknowledgement ----------

export interface SupplierPoAckRowDto {
  readonly poId: string
  readonly number: string | null
  readonly status: string
  readonly revisionNo: number
  /** ISO 8601 UTC */
  readonly sentAt: string
  readonly ackStatus: 'NOT_ACKNOWLEDGED' | 'ACKNOWLEDGED' | 'DELIVERY_UPDATED'
  readonly acknowledgedAt: string | null
  /** YYYY-MM-DD: the delivery the supplier promised */
  readonly promisedDeliveryOn: string | null
  /** The contact who acknowledged this revision, as they are named in the register */
  readonly acknowledgedBy: { readonly nameTh: string; readonly nameEn: string | null } | null
}

export interface SupplierPoAcksDto {
  readonly rows: readonly SupplierPoAckRowDto[]
  /** Every PO ever sent to the supplier; the rows stop at SUPPLIER_PO_ACK_LIMIT */
  readonly total: number
  readonly limit: number
}

/** The "การรับทราบ PO" tab: the POs sent to the supplier, newest first, with the projection of BR-SUP ข้อ 14 (ADR-188) */
export async function listSupplierPoAcknowledgementsForScreen(ctx: Ctx, supplierId: string): Promise<Result<SupplierPoAcksDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const reader = await readerOf(tx, ctx, supplierId)
    if (refused(reader)) return reader
    if (!scopesFor(reader.principal, 'po.view').has('ORG')) return err('FORBIDDEN', 'missing capability po.view', { capability: 'po.view' })
    const where = { supplierId, sentAt: { not: null } }
    const [pos, total] = await Promise.all([
      tx.purchaseOrder.findMany({
        where,
        select: { id: true, number: true, status: true, revisionNo: true, sentAt: true, supplierAckStatus: true, supplierAcknowledgedAt: true, supplierPromisedDeliveryOn: true },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        take: SUPPLIER_PO_ACK_LIMIT,
      }),
      tx.purchaseOrder.count({ where }),
    ])
    const acks = pos.length
      ? await tx.poAcknowledgement.findMany({
          where: { poId: { in: pos.map((p) => p.id) } },
          select: { poId: true, revisionNo: true, contact: { select: { nameTh: true, nameEn: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : []
    return ok({
      total,
      limit: SUPPLIER_PO_ACK_LIMIT,
      rows: pos.map((p) => {
        const latest = acks.find((a) => a.poId === p.id && a.revisionNo === p.revisionNo)
        return {
          poId: p.id,
          number: p.number,
          status: p.status,
          revisionNo: p.revisionNo,
          sentAt: p.sentAt!.toISOString(),
          ackStatus: p.supplierAckStatus,
          acknowledgedAt: p.supplierAcknowledgedAt?.toISOString() ?? null,
          promisedDeliveryOn: p.supplierPromisedDeliveryOn ? p.supplierPromisedDeliveryOn.toISOString().slice(0, 10) : null,
          acknowledgedBy: latest ? { nameTh: latest.contact.nameTh, nameEn: latest.contact.nameEn } : null,
        }
      }),
    })
  })
}

// ---------- the portal ----------

export interface SupplierPortalDto {
  /** Supplier.portalEnabled: set when its application was approved (S7-05); no command changes it from this screen yet */
  readonly portalEnabled: boolean
  readonly supplierStatus: 'ACTIVE' | 'INACTIVE'
  /** The sign-in page of the organization's portal, whole (BR-PORTAL ข้อ 01: APP_URL/portal/<org code in lower case>/login) */
  readonly loginUrl: string
  readonly canManage: boolean
  /** The active contacts, each with whether they may sign in (switched with supplierContact.update · portalEnabled) */
  readonly contacts: readonly SupplierContactRowDto[]
}

/** The "พอร์ทัล" tab: whether the supplier and each of its active contacts may use the portal, and where it is */
export async function getSupplierPortalForScreen(ctx: Ctx, supplierId: string): Promise<Result<SupplierPortalDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const reader = await readerOf(tx, ctx, supplierId)
    if (refused(reader)) return reader
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { code: true } })
    const contacts = (await contactsIn(tx, ctx, supplierId, reader.canManage)).filter((c) => c.status === 'ACTIVE')
    return ok({
      portalEnabled: reader.portalEnabled,
      supplierStatus: reader.supplierStatus,
      loginUrl: `${getEnv().APP_URL.replace(/\/$/, '')}/portal/${org.code.toLowerCase()}/login`,
      canManage: reader.canManage,
      contacts,
    })
  })
}

// ---------- the documents by type (BR-SDOC ข้อ 06) ----------

export interface SupplierDocumentSummaryRowDto {
  readonly documentTypeCode: string
  readonly nameTh: string
  readonly nameEn: string
  readonly required: boolean
  readonly scope: string | null
  readonly state: DocumentState
  /** YYYY-MM-DD */
  readonly expiresOn: string | null
}

export interface SupplierDocumentSummaryDto {
  readonly requiredDocumentsOk: boolean
  readonly rows: readonly SupplierDocumentSummaryRowDto[]
}

/**
 * The overall state above the documents (supplierDocumentStatus checks supplier.document.view and the module), with the
 * name of each type so a missing one reads as words, not a code
 */
export async function getSupplierDocumentSummaryForScreen(ctx: Ctx, supplierId: string): Promise<Result<SupplierDocumentSummaryDto>> {
  if (!SupplierId.safeParse(supplierId).success) return err('NOT_FOUND', 'supplier not found')
  const db = forTenant(ctx.organizationId)
  if (!(await db.supplier.findUnique({ where: { id: supplierId }, select: { id: true } }))) return err('NOT_FOUND', 'supplier not found')
  const status = await supplierDocumentStatus(ctx, supplierId)
  if (!status.ok) return status
  const codes = [...new Set(status.data.rows.map((r) => r.documentTypeCode))]
  const types = codes.length ? await db.supplierDocumentType.findMany({ where: { code: { in: codes } }, select: { code: true, nameTh: true, nameEn: true } }) : []
  const nameOf = new Map(types.map((t) => [t.code, t]))
  return ok({
    requiredDocumentsOk: status.data.requiredDocumentsOk,
    rows: status.data.rows.map((r) => ({ ...r, nameTh: nameOf.get(r.documentTypeCode)?.nameTh ?? r.documentTypeCode, nameEn: nameOf.get(r.documentTypeCode)?.nameEn ?? r.documentTypeCode })),
  })
}

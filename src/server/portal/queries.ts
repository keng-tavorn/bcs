import { bankOf, BANKS } from '@/core/bankfile/banks'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { supplierDocumentStatusInTx } from '@/server/services/suppliers/documents'
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

// ---------- S7-08: the application form, the home's to-do list, the profile and help ----------

export const PORTAL_APPLY_STEPS = ['company', 'tax', 'contact', 'bank', 'documents', 'review'] as const
export type PortalApplyStep = (typeof PORTAL_APPLY_STEPS)[number]

/** What a document type shows on the form: its latest copy's state, as the contact may know it */
export type PortalDocumentState = 'NONE' | 'SCANNING' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'INFECTED'

export interface PortalApplicationView {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly kind: string
  readonly version: number
  readonly returnReason: string | null
  readonly editable: boolean
  readonly fields: {
    readonly nameTh: string
    readonly nameEn: string | null
    readonly payeeType: string
    readonly address: string | null
    readonly phone: string | null
    readonly email: string | null
    readonly category: string | null
    readonly taxId: string | null
    readonly branchCode: string
    readonly isVatRegistered: boolean
    readonly bankCode: string | null
    /** The last four digits only: the whole number never comes back to a page (BR-SUP ข้อ 07) */
    readonly accountNoLast4: string | null
    readonly accountName: string | null
    readonly bankBranch: string | null
  }
  /** expiresRequired: the type has no validity of its own, so a copy needs the expiry date it states (BR-SDOC ข้อ 02) */
  readonly documents: readonly { readonly code: string; readonly nameTh: string; readonly nameEn: string; readonly required: boolean; readonly expiresRequired: boolean; readonly state: PortalDocumentState; readonly reason: string | null }[]
  /** What a submit still needs: field names, `document:<code>` and `contact` (as supplierApplication.submit answers) */
  readonly missing: readonly string[]
  /** The duplicate warnings by code and the reason given — never the suppliers they resemble (INV-SUP-01) */
  readonly warnings: readonly { readonly code: string; readonly reason: string | null }[]
  readonly banks: readonly { readonly code: string; readonly nameTh: string; readonly shortName: string }[]
}

const EDITABLE_STATUSES = new Set(['INVITED', 'DRAFT', 'RETURNED'])

function documentStateOf(doc: { status: string; rejectReason: string | null; file: { scanStatus: string } | null } | undefined): { state: PortalDocumentState; reason: string | null } {
  if (!doc) return { state: 'NONE', reason: null }
  if (doc.status === 'REJECTED') return doc.rejectReason === 'FILE_INFECTED' ? { state: 'INFECTED', reason: null } : { state: 'REJECTED', reason: doc.rejectReason }
  if (doc.status === 'VERIFIED') return { state: 'VERIFIED', reason: null }
  if (doc.status === 'PENDING') return { state: doc.file?.scanStatus === 'PENDING' ? 'SCANNING' : 'PENDING', reason: null }
  return { state: 'NONE', reason: null }
}

/** The contact's application as the form shows it, or null for a contact of a registered supplier */
export async function getPortalApplication(ctx: Ctx): Promise<PortalApplicationView | null> {
  if (ctx.actor.type !== 'SUPPLIER') throw new Error('a portal query needs a portal context')
  if (!ctx.actor.applicationId || ctx.actor.supplierId) return null
  const db = forTenant(ctx.organizationId)
  const app = await db.supplierApplication.findFirst({ where: portalWhere(ctx, 'supplierApplication') })
  if (!app) return null
  const [types, docs, contacts] = await Promise.all([
    db.supplierDocumentType.findMany({ where: { AND: [portalWhere(ctx, 'supplierDocumentType'), { appliesTo: { has: app.payeeType } }] }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { code: true, nameTh: true, nameEn: true, required: true, validityDays: true } }),
    db.supplierDocument.findMany({ where: portalWhere(ctx, 'supplierDocument'), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { documentTypeCode: true, status: true, rejectReason: true, file: { select: { scanStatus: true } } } }),
    db.supplierContact.count({ where: { AND: [portalWhere(ctx, 'supplierContact'), { status: 'ACTIVE' }] } }),
  ])
  const latest = new Map<string, (typeof docs)[number]>()
  for (const d of docs) if (!latest.has(d.documentTypeCode)) latest.set(d.documentTypeCode, d)
  const documents = types.map((t) => ({ code: t.code, nameTh: t.nameTh, nameEn: t.nameEn, required: t.required, expiresRequired: t.validityDays === null, ...documentStateOf(latest.get(t.code)) }))
  const missing: string[] = []
  if (!app.nameTh) missing.push('nameTh')
  if (app.payeeType !== 'FOREIGN' && !app.taxId) missing.push('taxId')
  if (!/^\d{5}$/.test(app.branchCode)) missing.push('branchCode')
  if (!app.address) missing.push('address')
  const sent = new Set(docs.filter((d) => d.status === 'PENDING' || d.status === 'VERIFIED').map((d) => d.documentTypeCode))
  for (const t of types) if (t.required && !sent.has(t.code)) missing.push(`document:${t.code}`)
  if (contacts === 0) missing.push('contact')
  const warnings = (app.duplicateWarnings as unknown as { code: string; reason: string | null }[]).map((w) => ({ code: w.code, reason: w.reason ?? null }))
  return {
    id: app.id,
    number: app.number,
    status: app.status,
    kind: app.kind,
    version: app.version,
    returnReason: app.status === 'RETURNED' ? app.returnReason : null,
    editable: EDITABLE_STATUSES.has(app.status) && app.kind === 'NEW',
    fields: {
      nameTh: app.nameTh,
      nameEn: app.nameEn,
      payeeType: app.payeeType,
      address: app.address,
      phone: app.phone,
      email: app.email,
      category: app.category,
      taxId: app.taxId,
      branchCode: app.branchCode,
      isVatRegistered: app.isVatRegistered,
      bankCode: app.bankCode,
      accountNoLast4: app.accountNoLast4,
      accountName: app.accountName,
      bankBranch: app.bankBranch,
    },
    documents,
    missing,
    warnings,
    banks: BANKS.map((b) => ({ code: b.code, nameTh: b.nameTh, shortName: b.shortName })),
  }
}

export interface PortalTodo {
  readonly kind: string
  /** The page of the portal to go to (under /portal/<org>) */
  readonly page: string
  readonly values: Readonly<Record<string, string>>
}

/**
 * What waits for the contact of a registered supplier, by provider (docs/sub-specs/S7.md "/portal/home"): a registry —
 * S7-11 adds POs to acknowledge, S7-12 rejected invoices, S10 S11 their own lines, one entry each in their own file,
 * never by changing the page. Each provider reads through portalWhere.
 */
export const PORTAL_HOME_PROVIDERS: Array<{ readonly key: string; readonly load: (ctx: Ctx) => Promise<PortalTodo[]> }> = [
  {
    // S7: the documents of the supplier by their state on today's date (BR-SDOC ข้อ 06)
    key: 'documents',
    load: async (ctx) => {
      if (ctx.actor.type !== 'SUPPLIER' || !ctx.actor.supplierId) return []
      const supplierId = ctx.actor.supplierId
      const db = forTenant(ctx.organizationId)
      const owned = await db.supplier.findFirst({ where: portalWhere(ctx, 'supplier'), select: { id: true } })
      if (!owned) return []
      const [status, types] = await Promise.all([
        db.$transaction((tx) => supplierDocumentStatusInTx(tx, ctx.organizationId, supplierId, ctx.now)),
        db.supplierDocumentType.findMany({ where: portalWhere(ctx, 'supplierDocumentType'), select: { code: true, nameTh: true, nameEn: true } }),
      ])
      const names = new Map(types.map((t) => [t.code, t]))
      return status.rows.flatMap((row): PortalTodo[] => {
        const type = names.get(row.documentTypeCode)
        const values = { typeTh: type?.nameTh ?? row.documentTypeCode, typeEn: type?.nameEn ?? row.documentTypeCode }
        if (row.state === 'EXPIRING') return [{ kind: 'DOCUMENT_EXPIRING', page: '/documents', values: { ...values, date: row.expiresOn ?? '' } }]
        if (row.state === 'EXPIRED') return [{ kind: 'DOCUMENT_EXPIRED', page: '/documents', values }]
        if (row.state === 'MISSING') return [{ kind: 'DOCUMENT_MISSING', page: '/documents', values }]
        return []
      })
    },
  },
]

/** The home's to-do list of a registered supplier's contact, every provider in order */
export async function listPortalTodos(ctx: Ctx): Promise<PortalTodo[]> {
  const lists = await Promise.all(PORTAL_HOME_PROVIDERS.map((p) => p.load(ctx)))
  return lists.flat()
}

export interface PortalHelpView {
  readonly inviter: { readonly name: string; readonly email: string } | null
}

/** Who to ask: the member who invited the application's contact (a registered supplier's contact asks procurement) */
export async function getPortalHelp(ctx: Ctx): Promise<PortalHelpView> {
  if (ctx.actor.type !== 'SUPPLIER') throw new Error('a portal query needs a portal context')
  const app = await forTenant(ctx.organizationId).supplierApplication.findFirst({ where: portalWhere(ctx, 'supplierApplication'), orderBy: [{ invitedAt: 'desc' }, { id: 'desc' }], select: { invitedBy: { select: { displayNameTh: true, email: true, status: true } } } })
  const by = app?.invitedBy
  return { inviter: by && by.status === 'ACTIVE' ? { name: by.displayNameTh, email: by.email } : null }
}

// ---------- S7-10: the supplier's bank account (FR-SUP-103 AC1 AC4) ----------

/** Where the supplier's latest request stands, in its words: waiting for FINANCE to claim or check it, for approval, in force */
export type PortalBankStage = 'AWAITING_CLAIM' | 'CHECKING' | 'APPROVING' | 'IN_FORCE' | 'REJECTED' | 'CANCELLED'

export interface PortalBankView {
  /** The account in force, masked: the bank, the last four digits and the name only */
  readonly current: { readonly bankName: string; readonly last4: string; readonly accountName: string } | null
  readonly latest: { readonly stage: PortalBankStage; readonly bankName: string | null; readonly last4: string | null; readonly createdAt: string } | null
  /** The primary contact may propose while no request is open (the service checks it again, and the hold of a new contact) */
  readonly mayPropose: boolean
  readonly isPrimary: boolean
  /** The supplier's status, for portalAuthorize's facts */
  readonly supplierStatus: string | null
  readonly banks: readonly { readonly code: string; readonly nameTh: string; readonly shortName: string }[]
}

function stageOf(change: { status: string; submittedById: string | null }): PortalBankStage {
  if (change.status === 'DRAFT') return change.submittedById ? 'CHECKING' : 'AWAITING_CLAIM'
  if (change.status === 'PENDING_APPROVAL') return 'APPROVING'
  if (change.status === 'APPROVED') return 'IN_FORCE'
  return change.status === 'REJECTED' ? 'REJECTED' : 'CANCELLED'
}

/** The bank account of the contact's supplier, never a whole number; null for a contact of an application */
export async function getPortalBankAccount(ctx: Ctx): Promise<PortalBankView | null> {
  if (ctx.actor.type !== 'SUPPLIER') throw new Error('a portal query needs a portal context')
  if (!ctx.actor.supplierId) return null
  const db = forTenant(ctx.organizationId)
  const [account, change, contact, supplier] = await Promise.all([
    db.bankAccount.findFirst({ where: { AND: [portalWhere(ctx, 'bankAccount'), { status: 'ACTIVE' }] }, select: { bankCode: true, accountNo: true, accountName: true } }),
    db.bankAccountChange.findFirst({ where: portalWhere(ctx, 'bankAccountChange'), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { status: true, submittedById: true, bankCode: true, accountNo: true, createdAt: true } }),
    db.supplierContact.findFirst({ where: { AND: [portalWhere(ctx, 'supplierContact'), { id: ctx.actor.supplierContactId }] }, select: { isPrimary: true } }),
    db.supplier.findFirst({ where: portalWhere(ctx, 'supplier'), select: { status: true } }),
  ])
  const open = change ? change.status === 'DRAFT' || change.status === 'PENDING_APPROVAL' : false
  return {
    current: account ? { bankName: bankOf(account.bankCode)?.nameTh ?? account.bankCode, last4: account.accountNo.slice(-4), accountName: account.accountName } : null,
    latest: change ? { stage: stageOf(change), bankName: change.bankCode ? (bankOf(change.bankCode)?.nameTh ?? change.bankCode) : null, last4: change.accountNo ? change.accountNo.slice(-4) : null, createdAt: change.createdAt.toISOString() } : null,
    mayPropose: Boolean(contact?.isPrimary) && !open,
    isPrimary: Boolean(contact?.isPrimary),
    supplierStatus: supplier?.status ?? null,
    banks: BANKS.map((b) => ({ code: b.code, nameTh: b.nameTh, shortName: b.shortName })),
  }
}

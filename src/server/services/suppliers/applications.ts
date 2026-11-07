import { z } from 'zod'
import { normalizeAccount } from '@/core/bankfile/account'
import type { AppError, Result } from '@/core/result'
import { applicationSla, findSupplierDuplicates, type DuplicateWarningCode, type ExistingSupplier } from '@/core/supplier-onboarding'
import { normalizeTaxId } from '@/core/thai/taxid'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { supplierSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { openSecret, sealSecret } from '@/server/crypto/secret-box'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { PORTAL_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-portal'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { assertNoPendingAiReview } from '../ai/assist-contract'
import { startRoute } from '../approvals/route'
import { requireModule } from '../modules'
import { issueDocumentNumber } from '../numbering'
import { checkRegistry } from './index'
import { issuePortalLink } from './links'
import { primaryOf, revokeContactSessions, tellRegister } from './contacts'

// Supplier applications (S7-05 · ADR-181 · BR-SUP ข้อ 08 ถึง ข้อ 11 · FR-SUP-101 FR-SUP-102 FR-SUP-104): PROCUREMENT invites
// (a new supplier, or one already registered into the portal), the supplier fills the application in on the portal —
// or PROCUREMENT for it (fillOnBehalf) — and submits it; PROCUREMENT checks the registries and sends it on its route
// under DOA SUPPLIER_APPROVAL, or returns it. Every command checks the duplicate rules again (BR-SUP ข้อ 09). The approval
// itself is decided by the subject adapter (approvals/subjects/supplier-application.ts), which creates the supplier.
// A contact acts through the portal (actor SUPPLIER, channel PORTAL), checked by the contact's own application; a
// member acts with the capabilities of §2.4. The account number is kept sealed (BR-SUP ข้อ 07), its last four in clear.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

const OPEN_STATUSES = ['INVITED', 'DRAFT', 'RETURNED', 'SUBMITTED', 'PENDING_APPROVAL'] as const
const EDITABLE = new Set(['INVITED', 'DRAFT', 'RETURNED'])
const REASON = z.string().trim().min(3).max(500)

/** The context the account number is sealed with: one application's, so a sealed value never opens elsewhere */
export const accountContext = (organizationId: string, applicationId: string) => `supplier-application:${organizationId}:${applicationId}:accountNo`

// ---------- the application's fields ----------

export const ApplicationFields = z
  .object({
    nameTh: z.string().trim().min(1).max(200),
    nameEn: z.string().trim().max(200).nullable(),
    taxId: z.string().trim().max(20).nullable(),
    branchCode: z.string().regex(/^\d{5}$/),
    isVatRegistered: z.boolean(),
    payeeType: z.enum(['JURISTIC', 'INDIVIDUAL', 'FOREIGN']),
    address: z.string().trim().max(500).nullable(),
    phone: z.string().trim().max(40).nullable(),
    email: z.string().trim().toLowerCase().max(254).nullable(),
    category: z.string().trim().max(100).nullable(),
    whtIncomeTypeCode: z.string().trim().max(20).nullable(),
    paymentTermDays: z.int().min(0).max(365).nullable(),
    bankCode: z.string().regex(/^\d{3}$/).nullable(),
    /** In clear in the form only: sealed when stored */
    accountNo: z.string().trim().max(40).nullable(),
    accountName: z.string().trim().max(200).nullable(),
    bankBranch: z.string().trim().max(100).nullable(),
  })
  .partial()
export type ApplicationFieldsInput = z.infer<typeof ApplicationFields>

/** The reason given for each duplicate warning (BR-SUP ข้อ 09: every warning needs one before it is sent) */
const DuplicateReasons = z.partialRecord(z.enum(['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME', 'DUPLICATE_EMAIL']), REASON)

interface StoredWarning {
  readonly code: DuplicateWarningCode
  readonly matches: readonly string[]
  readonly reason: string | null
}

/** Suppliers of every status and the other open applications, as the duplicate check sees them */
async function existingForDuplicates(tx: TenantTx, exceptApplicationId: string | null): Promise<ExistingSupplier[]> {
  const suppliers = await tx.supplier.findMany({
    select: { code: true, taxId: true, branchCode: true, nameTh: true, email: true, contacts: { where: { status: 'ACTIVE' }, select: { email: true } } },
    orderBy: [{ code: 'asc' }],
  })
  const applications = await tx.supplierApplication.findMany({
    where: { status: { in: [...OPEN_STATUSES] }, kind: 'NEW', ...(exceptApplicationId ? { id: { not: exceptApplicationId } } : {}) },
    select: { id: true, number: true, taxId: true, branchCode: true, nameTh: true, email: true, contacts: { where: { status: 'ACTIVE' }, select: { email: true } } },
    orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
  })
  return [
    ...suppliers.map((s) => ({ ref: s.code, taxId: s.taxId, branchCode: s.branchCode, nameTh: s.nameTh, emails: [s.email, ...s.contacts.map((c) => c.email)].filter((e): e is string => Boolean(e)) })),
    ...applications.map((a) => ({ ref: a.number ?? a.id, taxId: a.taxId, branchCode: a.branchCode, nameTh: a.nameTh, emails: [a.email, ...a.contacts.map((c) => c.email)].filter((e): e is string => Boolean(e)) })),
  ]
}

/**
 * BR-SUP ข้อ 09: a block is refused (DUPLICATE_SUPPLIER · TAXID_CHECKSUM); warnings come back with the reasons given, and
 * `needReasons` refuses one without its reason (VALIDATION_FAILED reason DUPLICATE_REASON_REQUIRED, the warnings listed).
 */
async function duplicateCheck(
  tx: TenantTx,
  candidate: { readonly taxId: string | null; readonly branchCode: string; readonly nameTh: string; readonly email: string | null },
  exceptApplicationId: string | null,
  reasons: Readonly<Record<string, string>> | undefined,
  needReasons: boolean,
): Promise<{ readonly ok: true; readonly warnings: StoredWarning[] } | Fail> {
  const checked = findSupplierDuplicates(candidate, await existingForDuplicates(tx, exceptApplicationId))
  if (!checked.ok) {
    return checked.code === 'DUPLICATE_SUPPLIER'
      ? fail('DUPLICATE_SUPPLIER', 'a supplier with this tax id and branch is registered or invited', { reason: checked.reason, matches: [...checked.matches] })
      : fail('VALIDATION_FAILED', 'the tax id is not valid', { field: 'taxId', reason: checked.reason })
  }
  const warnings = checked.warnings.map((w) => ({ code: w.code, matches: [...w.matches], reason: reasons?.[w.code] ?? null }))
  const missing = warnings.filter((w) => !w.reason)
  if (needReasons && missing.length) return fail('VALIDATION_FAILED', 'every duplicate warning needs a reason', { field: 'duplicateReasons', reason: 'DUPLICATE_REASON_REQUIRED', warnings: missing.map((w) => ({ code: w.code, matches: w.matches })) })
  return { ok: true, warnings }
}

interface Effects {
  events: EventDraft[]
  notifications: NotificationDraft[]
  outbox: OutboxDraft[]
}
const effects = (): Effects => ({ events: [], notifications: [], outbox: [] })
function absorb(into: Effects, notice: { events: readonly EventDraft[]; notifications: readonly NotificationDraft[]; outbox: readonly OutboxDraft[] }) {
  into.events.push(...notice.events)
  into.notifications.push(...notice.notifications)
  into.outbox.push(...notice.outbox)
}

export async function orgCodeOf(tx: TenantTx, organizationId: string): Promise<string> {
  return (await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { code: true } })).code.toLowerCase()
}

/** The time an application waiting for its supplier expires (BR-SUP ข้อ 12) */
async function expiryOf(tx: TenantTx, ctx: Ctx, invitedAt: Date): Promise<Date> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  return applicationSla({ invitedAt, lastActivityAt: invitedAt }, supplierSettingsOf(org.settings), await loadBusinessCalendar(tx, ctx.organizationId)).expiresAt
}

async function memberGate(tx: TenantTx, ctx: Ctx, capability: 'supplier.invite' | 'supplier.application.fillOnBehalf' | 'supplier.application.route'): Promise<Fail | null> {
  const on = await requireModule(ctx, 'SUPPLIER', tx)
  if (!on.ok) return { ok: false, error: on.error }
  const may = await authorize(tx, ctx, capability)
  return may.ok ? null : { ok: false, error: may.error }
}

// ---------- supplierApplication.invite · .reinvite · .cancel ----------

const InviteInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('NEW'),
    nameTh: z.string().trim().min(1).max(200),
    /** null: a foreign supplier without a Thai taxpayer id */
    taxId: z.string().trim().max(20).nullable(),
    branchCode: z.string().regex(/^\d{5}$/).default('00000'),
    payeeType: z.enum(['JURISTIC', 'INDIVIDUAL', 'FOREIGN']).default('JURISTIC'),
    category: z.string().trim().max(100).nullable().optional(),
    contact: z.object({ nameTh: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().pipe(z.email()), locale: z.enum(['th', 'en']).default('th') }),
    inviterPhone: z.string().trim().max(40).nullable().optional(),
    duplicateReasons: DuplicateReasons.optional(),
  }),
  z.object({
    kind: z.literal('EXISTING'),
    supplierId: z.uuid(),
    contact: z.object({ nameTh: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().pipe(z.email()), locale: z.enum(['th', 'en']).default('th') }),
  }),
])

async function sendInvitation(tx: TenantTx, ctx: Ctx, applicationId: string, contactId: string): Promise<{ linkId: string } & Effects> {
  const link = await issuePortalLink(tx, { organizationId: ctx.organizationId, orgCode: await orgCodeOf(tx, ctx.organizationId), contactId, purpose: 'INVITATION', now: ctx.now, applicationId, createdById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null })
  const out = effects()
  absorb(
    out,
    await enqueueSupplierNotice(tx, ctx, {
      templateKey: PORTAL_SUPPLIER_TEMPLATES.invitation,
      contactId,
      applicationId,
      subjectType: 'SupplierApplication',
      subjectId: applicationId,
      dedupeKey: `supplier.invitation:${link.linkId}`,
      data: { url: link.url, expiresAt: link.expiresAt.toISOString() },
    }),
  )
  return { linkId: link.linkId, ...out }
}

export const inviteSupplierCommand = defineCommand({
  name: 'supplierApplication.invite',
  capability: 'supplier.invite',
  input: InviteInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ applicationId: string; contactId: string }>> {
    const refused = await memberGate(tx, ctx, 'supplier.invite')
    if (refused) return refused
    const inviter = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (await tx.supplierContact.findFirst({ where: { email: input.contact.email, status: 'ACTIVE' }, select: { id: true } })) {
      return fail('VALIDATION_FAILED', 'an active contact has this e-mail', { field: 'contact.email', reason: 'EMAIL_TAKEN' })
    }
    let warnings: StoredWarning[] = []
    let supplierId: string | null = null
    let fields: { nameTh: string; taxId: string | null; branchCode: string; payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'; category: string | null }
    if (input.kind === 'NEW') {
      const taxId = input.payeeType === 'FOREIGN' || input.taxId === null ? null : normalizeTaxId(input.taxId)
      if (input.payeeType !== 'FOREIGN' && !taxId) return fail('VALIDATION_FAILED', 'a Thai supplier has a taxpayer id', { field: 'taxId', reason: 'REQUIRED' })
      const checked = await duplicateCheck(tx, { taxId, branchCode: input.branchCode, nameTh: input.nameTh, email: input.contact.email }, null, input.duplicateReasons, true)
      if (!checked.ok) return checked
      warnings = checked.warnings
      fields = { nameTh: input.nameTh, taxId, branchCode: input.branchCode, payeeType: input.payeeType, category: input.category ?? null }
    } else {
      const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, nameTh: true, taxId: true, branchCode: true, payeeType: true, category: true, status: true } })
      if (!supplier || supplier.status !== 'ACTIVE') return fail('NOT_FOUND', 'supplier not found or not active')
      supplierId = supplier.id
      fields = { nameTh: supplier.nameTh, taxId: supplier.taxId, branchCode: supplier.branchCode, payeeType: supplier.payeeType, category: supplier.category }
    }
    const application = await tx.supplierApplication.create({
      data: {
        organizationId: ctx.organizationId,
        kind: input.kind,
        supplierId,
        status: 'INVITED',
        invitedById: inviter,
        inviterPhone: input.kind === 'NEW' ? (input.inviterPhone ?? null) : null,
        invitedAt: ctx.now,
        lastActivityAt: ctx.now,
        expiresAt: await expiryOf(tx, ctx, ctx.now),
        ...fields,
        email: input.contact.email,
        duplicateWarnings: warnings as unknown as object,
      },
      select: { id: true },
    })
    const contact = await tx.supplierContact.create({
      data: { organizationId: ctx.organizationId, applicationId: application.id, nameTh: input.contact.nameTh, email: input.contact.email, locale: input.contact.locale, isPrimary: true, createdById: inviter },
      select: { id: true },
    })
    const sent = await sendInvitation(tx, ctx, application.id, contact.id)
    // a new person who may act for a registered supplier: its register address and primary contact hear of it, never the
    // new address (BR-SUP ข้อ 08 · ข้อ 17)
    if (supplierId) absorb(sent, await tellRegister(tx, ctx, { supplierId, contactId: contact.id, contactName: input.contact.nameTh, changed: 'ADDED', primaryBefore: await primaryOf(tx, supplierId) }))
    return {
      ok: true,
      result: { applicationId: application.id, contactId: contact.id },
      events: [
        { type: 'supplier_application.invited', aggregateType: 'SupplierApplication', aggregateId: application.id, data: { kind: input.kind, contactId: contact.id, linkId: sent.linkId, supplierId, warnings: warnings.map((w) => w.code), reinvite: false } },
        { type: 'supplier_contact.created', aggregateType: 'SupplierContact', aggregateId: contact.id, data: { supplierId: null, applicationId: application.id, isPrimary: true, portalEnabled: true } },
        ...sent.events,
      ],
      notifications: sent.notifications,
      outbox: sent.outbox,
    }
  },
})

const ApplicationRef = z.object({ applicationId: z.uuid(), expectedVersion: z.int().min(0) })

async function lockedApplication(tx: TenantTx, ctx: Ctx, applicationId: string) {
  await lockRowsForUpdate(tx, 'SupplierApplication', ctx.organizationId, [applicationId])
  return tx.supplierApplication.findUnique({ where: { id: applicationId } })
}

export const reinviteSupplierCommand = defineCommand({
  name: 'supplierApplication.reinvite',
  capability: 'supplier.invite',
  input: ApplicationRef,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ applicationId: string }>> {
    const refused = await memberGate(tx, ctx, 'supplier.invite')
    if (refused) return refused
    const app = await lockedApplication(tx, ctx, input.applicationId)
    if (!app) return fail('NOT_FOUND', 'application not found')
    if (app.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the application changed since it was opened', { currentVersion: app.version })
    if (app.status !== 'INVITED' && app.status !== 'EXPIRED') return fail('INVALID_STATE_TRANSITION', 'only an invited or expired application is invited again', { status: app.status })
    const contact = await tx.supplierContact.findFirst({ where: { applicationId: app.id, status: 'ACTIVE', isPrimary: true }, select: { id: true } })
    if (!contact) return fail('VALIDATION_FAILED', 'the application has no contact', { reason: 'NO_CONTACT' })
    // the links sent before stop working: only the newest invitation opens the portal
    await tx.portalInviteLink.updateMany({ where: { applicationId: app.id, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
    // invitedAt stays the first invitation's: G-7 and the escalation count from it (BR-SUP ข้อ 12 ข้อ 13); the link and
    // the expiry are new
    await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'INVITED', lastActivityAt: ctx.now, expiresAt: await expiryOf(tx, ctx, ctx.now), remindedAt: null, version: { increment: 1 } } })
    const sent = await sendInvitation(tx, ctx, app.id, contact.id)
    const warnings = (app.duplicateWarnings as unknown as StoredWarning[]).map((w) => w.code)
    return {
      ok: true,
      result: { applicationId: app.id },
      events: [
        { type: 'supplier_application.invited', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { kind: app.kind, contactId: contact.id, linkId: sent.linkId, supplierId: app.supplierId, warnings, reinvite: true } },
        ...sent.events,
      ],
      notifications: sent.notifications,
      outbox: sent.outbox,
    }
  },
})

/** Closes what an application gave its contacts: their sessions end, the links unused stop working (BR-PORTAL ข้อ 03) */
export async function closeAccess(tx: TenantTx, ctx: Ctx, applicationId: string): Promise<EventDraft[]> {
  await tx.portalInviteLink.updateMany({ where: { applicationId, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
  const contacts = await tx.supplierContact.findMany({ where: { applicationId, supplierId: null }, select: { id: true }, orderBy: { id: 'asc' } })
  const events: EventDraft[] = []
  for (const c of contacts) events.push(...(await revokeContactSessions(tx, ctx, c.id, 'APPLICATION_CLOSED')))
  return events
}

async function reasonComment(tx: TenantTx, ctx: Ctx, applicationId: string, body: string): Promise<string> {
  return (await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'SupplierApplication', subjectId: applicationId, authorMemberId: ctx.actor.type === 'USER' ? ctx.actor.memberId : null, body }, select: { id: true } })).id
}

export const cancelApplicationCommand = defineCommand({
  name: 'supplierApplication.cancel',
  capability: 'supplier.invite',
  input: ApplicationRef.extend({ reason: REASON }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ applicationId: string }>> {
    const refused = await memberGate(tx, ctx, 'supplier.invite')
    if (refused) return refused
    const app = await lockedApplication(tx, ctx, input.applicationId)
    if (!app) return fail('NOT_FOUND', 'application not found')
    if (app.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the application changed since it was opened', { currentVersion: app.version })
    if (!['INVITED', 'DRAFT', 'RETURNED', 'SUBMITTED'].includes(app.status)) return fail('INVALID_STATE_TRANSITION', 'this application cannot be cancelled', { status: app.status })
    await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'CANCELLED', decidedAt: ctx.now, version: { increment: 1 } } })
    const commentId = await reasonComment(tx, ctx, app.id, input.reason)
    return {
      ok: true,
      result: { applicationId: app.id },
      events: [{ type: 'supplier_application.cancelled', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number: app.number, reasonCommentId: commentId } }, ...(await closeAccess(tx, ctx, app.id))],
    }
  },
})

// ---------- supplierApplication.update · .submit (the contact, or PROCUREMENT for it) ----------

/** Who changes an application: its own contact on the portal, or a member who may fill it in for the supplier */
async function editor(tx: TenantTx, ctx: Ctx, app: { readonly id: string; readonly status: string }, action: 'edit' | 'submit'): Promise<{ readonly side: 'CONTACT' | 'ON_BEHALF' } | Fail> {
  const on = await requireModule(ctx, 'SUPPLIER', tx)
  if (!on.ok) return { ok: false, error: on.error }
  if (ctx.actor.type === 'SUPPLIER') {
    if (ctx.channel !== 'PORTAL' || ctx.actor.applicationId !== app.id) return fail('FORBIDDEN', 'the contact acts on its own application only', { action: `portal.application.${action}` })
    if (!EDITABLE.has(app.status)) return fail('INVALID_STATE_TRANSITION', 'the application is not open to changes', { status: app.status })
    return { side: 'CONTACT' }
  }
  const may = await authorize(tx, ctx, 'supplier.application.fillOnBehalf')
  if (!may.ok) return { ok: false, error: may.error }
  if (!EDITABLE.has(app.status)) return fail('INVALID_STATE_TRANSITION', 'the application is not open to changes', { status: app.status })
  return { side: 'ON_BEHALF' }
}

const UpdateInput = ApplicationRef.extend({ fields: ApplicationFields, duplicateReasons: DuplicateReasons.optional() })

export const updateApplicationCommand = defineCommand({
  name: 'supplierApplication.update',
  capability: 'supplier.application.fillOnBehalf',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ applicationId: string; version: number }>> {
    const app = await lockedApplication(tx, ctx, input.applicationId)
    if (!app) return fail('NOT_FOUND', 'application not found')
    const who = await editor(tx, ctx, app, 'edit')
    if ('ok' in who) return who
    if (app.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the application changed since it was opened', { currentVersion: app.version })
    if (app.kind !== 'NEW') return fail('INVALID_STATE_TRANSITION', 'an invitation of a registered supplier has nothing to fill in', { kind: app.kind })
    const f = input.fields
    const data: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(f)) if (value !== undefined && key !== 'accountNo') data[key] = value
    if (f.taxId !== undefined) data.taxId = f.taxId === null ? null : normalizeTaxId(f.taxId)
    const payeeType = (f.payeeType ?? app.payeeType) as 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN'
    if (payeeType === 'FOREIGN') data.taxId = null
    if (f.accountNo !== undefined) {
      if (f.accountNo === null) Object.assign(data, { accountNoEnc: null, accountNoLast4: null })
      else {
        const checked = normalizeAccount({ bankCode: f.bankCode ?? app.bankCode ?? '', accountNo: f.accountNo })
        if (!checked.ok) return fail('VALIDATION_FAILED', 'the bank account is not valid', { field: 'fields.accountNo', reason: checked.reason })
        Object.assign(data, { accountNoEnc: sealSecret(checked.accountNo, accountContext(ctx.organizationId, app.id)), accountNoLast4: checked.accountNo.slice(-4) })
      }
    }
    const changed = Object.keys(f).filter((k) => f[k as keyof typeof f] !== undefined)
    if (changed.length === 0) return fail('VALIDATION_FAILED', 'nothing changed', { field: 'fields', reason: 'NO_CHANGE' })
    // the duplicate rules on what the application would become; reasons are asked for at submit (a draft may wait)
    const next = { taxId: (data.taxId as string | null | undefined) ?? (data.taxId === null ? null : app.taxId), branchCode: (data.branchCode as string | undefined) ?? app.branchCode, nameTh: (data.nameTh as string | undefined) ?? app.nameTh, email: (data.email as string | null | undefined) ?? app.email }
    const reasons = { ...Object.fromEntries((app.duplicateWarnings as unknown as StoredWarning[]).filter((w) => w.reason).map((w) => [w.code, w.reason!])), ...(input.duplicateReasons ?? {}) }
    const checked = await duplicateCheck(tx, next, app.id, reasons, false)
    if (!checked.ok) return checked
    const sources = { ...(app.fieldSources as Record<string, string>), ...Object.fromEntries(changed.map((k) => [k, who.side === 'ON_BEHALF' ? 'ON_BEHALF' : 'MANUAL'])) }
    const moved = app.status === 'INVITED' ? { status: 'DRAFT' as const } : {}
    const row = await tx.supplierApplication.update({
      where: { id: app.id },
      data: {
        ...data,
        ...moved,
        duplicateWarnings: checked.warnings as unknown as object,
        fieldSources: sources,
        lastActivityAt: ctx.now,
        ...(who.side === 'ON_BEHALF' && ctx.actor.type === 'USER' ? { filledOnBehalfById: ctx.actor.memberId } : {}),
        version: { increment: 1 },
      },
      select: { version: true },
    })
    return {
      ok: true,
      result: { applicationId: app.id, version: row.version },
      events: [{ type: 'supplier_application.updated', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { fields: changed, by: who.side, warnings: checked.warnings.map((w) => w.code) } }],
    }
  },
})

/**
 * What the application still lacks before a submit (BR-SUP ข้อ 11 · BR-SDOC ข้อ 01): the fields by name, then each required
 * document type with no copy pending or verified as `document:<code>`. The reminder of BR-SUP ข้อ 12 names the same list.
 */
export async function missingItems(tx: TenantTx, app: { id: string; nameTh: string; taxId: string | null; branchCode: string; payeeType: string; address: string | null }): Promise<string[]> {
  const types = await requiredTypes(tx, app.payeeType)
  const have = new Set((await tx.supplierDocument.findMany({ where: { applicationId: app.id, status: { in: ['PENDING', 'VERIFIED'] } }, select: { documentTypeCode: true } })).map((d) => d.documentTypeCode))
  return [...missingFields(app), ...types.filter((t) => !have.has(t)).map((t) => `document:${t}`)]
}

/** The fields BR-SUP ข้อ 11 needs before a submit, by the application's payee type */
function missingFields(app: { nameTh: string; taxId: string | null; branchCode: string; payeeType: string; address: string | null }): string[] {
  const missing: string[] = []
  if (!app.nameTh) missing.push('nameTh')
  if (app.payeeType !== 'FOREIGN' && !app.taxId) missing.push('taxId')
  if (!/^\d{5}$/.test(app.branchCode)) missing.push('branchCode')
  if (!app.address) missing.push('address')
  return missing
}

/** The document types the application must have (BR-SDOC ข้อ 01): active, required, for its payee type */
export async function requiredTypes(tx: TenantTx, payeeType: string): Promise<string[]> {
  const types = await tx.supplierDocumentType.findMany({ where: { active: true, required: true }, select: { code: true, appliesTo: true }, orderBy: { code: 'asc' } })
  return types.filter((t) => (t.appliesTo as string[]).includes(payeeType)).map((t) => t.code)
}

export const submitApplicationCommand = defineCommand({
  name: 'supplierApplication.submit',
  capability: 'supplier.application.fillOnBehalf',
  input: ApplicationRef.extend({ duplicateReasons: DuplicateReasons.optional() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ applicationId: string; number: string }>> {
    const app = await lockedApplication(tx, ctx, input.applicationId)
    if (!app) return fail('NOT_FOUND', 'application not found')
    const who = await editor(tx, ctx, app, 'submit')
    if ('ok' in who) return who
    if (app.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the application changed since it was opened', { currentVersion: app.version })
    if (app.kind !== 'NEW') return fail('INVALID_STATE_TRANSITION', 'an invitation of a registered supplier is not submitted', { kind: app.kind })
    if (ctx.actor.type === 'SUPPLIER') {
      const contact = await tx.supplierContact.findUniqueOrThrow({ where: { id: ctx.actor.supplierContactId }, select: { privacyNoticeVersion: true } })
      if (contact.privacyNoticeVersion !== PORTAL_PRIVACY_NOTICE_VERSION) return fail('PRIVACY_NOTICE_OUTDATED', 'the current privacy notice is not accepted yet', { version: PORTAL_PRIVACY_NOTICE_VERSION })
    }
    // BR-AI-17: values an AI put in wait for the person first
    const ai = await assertNoPendingAiReview(tx, ctx, { type: 'SUPPLIER_APPLICATION', id: app.id })
    if (!ai.ok) return { ok: false, error: ai.error }
    const missing = await missingItems(tx, app)
    if (!(await tx.supplierContact.count({ where: { applicationId: app.id, status: 'ACTIVE' } }))) missing.push('contact')
    if (missing.length) return fail('APPLICATION_INCOMPLETE', 'the application is not complete', { missing })
    const reasons = { ...Object.fromEntries((app.duplicateWarnings as unknown as StoredWarning[]).filter((w) => w.reason).map((w) => [w.code, w.reason!])), ...(input.duplicateReasons ?? {}) }
    const checked = await duplicateCheck(tx, { taxId: app.taxId, branchCode: app.branchCode, nameTh: app.nameTh, email: app.email }, app.id, reasons, true)
    if (!checked.ok) return checked
    const number = app.number ?? (await issueDocumentNumber(tx, ctx, { document: 'SUP' }))
    await tx.supplierApplication.update({
      where: { id: app.id },
      data: {
        number,
        status: 'SUBMITTED',
        submittedAt: ctx.now,
        submittedByContactId: ctx.actor.type === 'SUPPLIER' ? ctx.actor.supplierContactId : null,
        duplicateWarnings: checked.warnings as unknown as object,
        lastActivityAt: ctx.now,
        version: { increment: 1 },
      },
    })
    const out = effects()
    // PROCUREMENT filled it in: the contact gets a copy of the values sent, never the whole account number (BR-SUP ข้อ 10)
    if (who.side === 'ON_BEHALF' || app.filledOnBehalfById) {
      const contact = await tx.supplierContact.findFirst({ where: { applicationId: app.id, status: 'ACTIVE', isPrimary: true }, select: { id: true } })
      if (contact) {
        const lines = [
          `ชื่อ: ${app.nameTh}`,
          `เลขผู้เสียภาษี: ${app.taxId ? (app.payeeType === 'INDIVIDUAL' ? `•••••••••${app.taxId.slice(-4)}` : app.taxId) : '-'} สาขา ${app.branchCode}`,
          `ที่อยู่: ${app.address ?? '-'}`,
          ...(app.accountNoLast4 ? [`บัญชีธนาคาร: ${app.bankCode ?? ''} ลงท้าย ${app.accountNoLast4}`] : []),
        ]
        absorb(out, await enqueueSupplierNotice(tx, ctx, { templateKey: PORTAL_SUPPLIER_TEMPLATES.applicationCopy, contactId: contact.id, applicationId: app.id, subjectType: 'SupplierApplication', subjectId: app.id, dedupeKey: `supplier.application_copy:${app.id}:${app.version}`, data: { number, lines } }))
      }
    }
    if (app.invitedById) {
      out.notifications.push({
        recipientMemberId: app.invitedById,
        templateKey: 'supplier.application_submitted',
        data: { applicationId: app.id, number, nameTh: app.payeeType === 'INDIVIDUAL' ? null : app.nameTh },
        urgency: 'DIGEST',
        dedupeKey: `supplier.application_submitted:${app.id}:${app.version}`,
        subjectType: 'SupplierApplication',
        subjectId: app.id,
      })
    }
    return {
      ok: true,
      result: { applicationId: app.id, number },
      events: [{ type: 'supplier_application.submitted', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number, by: who.side, warnings: checked.warnings.map((w) => w.code) } }, ...out.events],
      notifications: out.notifications,
      outbox: out.outbox,
    }
  },
})

// ---------- supplierApplication.return · .verifyAndRoute (PROCUREMENT) ----------

export const returnApplicationCommand = defineCommand({
  name: 'supplierApplication.return',
  capability: 'supplier.application.route',
  input: ApplicationRef.extend({ reason: REASON }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ applicationId: string }>> {
    const refused = await memberGate(tx, ctx, 'supplier.application.route')
    if (refused) return refused
    const app = await lockedApplication(tx, ctx, input.applicationId)
    if (!app) return fail('NOT_FOUND', 'application not found')
    if (app.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the application changed since it was opened', { currentVersion: app.version })
    if (app.status !== 'SUBMITTED') return fail('INVALID_STATE_TRANSITION', 'only a submitted application is returned here', { status: app.status })
    await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'RETURNED', returnReason: input.reason, lastActivityAt: ctx.now, version: { increment: 1 } } })
    const commentId = await reasonComment(tx, ctx, app.id, input.reason)
    const out = await toContacts(tx, ctx, app.id, PORTAL_SUPPLIER_TEMPLATES.applicationReturned, `returned:${app.version}`, { number: app.number, reason: input.reason })
    return {
      ok: true,
      result: { applicationId: app.id },
      events: [{ type: 'supplier_application.returned', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number: app.number, reasonCommentId: commentId, by: 'PROCUREMENT' } }, ...out.events],
      notifications: out.notifications,
      outbox: out.outbox,
    }
  },
})

/** An e-mail to the primary contact of the application (its own address and language · BR-NOTI ข้อ 09) */
export async function toContacts(tx: TenantTx, ctx: Ctx, applicationId: string, templateKey: string, key: string, data: Record<string, unknown>): Promise<Effects> {
  const out = effects()
  const contact = await tx.supplierContact.findFirst({ where: { OR: [{ applicationId }, { supplier: { applicationId } }], status: 'ACTIVE', isPrimary: true }, select: { id: true } })
  if (contact) absorb(out, await enqueueSupplierNotice(tx, ctx, { templateKey, contactId: contact.id, applicationId, subjectType: 'SupplierApplication', subjectId: applicationId, dedupeKey: `${templateKey}:${applicationId}:${key}`, data }))
  return out
}

const CEASED = /CEASED|เลิก|ร้าง/i

/** The conflicted people of an application's route (BR-SOD ข้อ 11): inviter, filler on behalf, router, every verifier */
export async function conflictedOf(tx: TenantTx, app: { readonly id: string; readonly invitedById: string | null; readonly filledOnBehalfById: string | null; readonly routedById: string | null }): Promise<string[]> {
  const verifiers = await tx.supplierDocument.findMany({ where: { applicationId: app.id, verifiedById: { not: null } }, select: { verifiedById: true } })
  return [...new Set([app.invitedById, app.filledOnBehalfById, app.routedById, ...verifiers.map((v) => v.verifiedById)].filter((m): m is string => Boolean(m)))]
}

/** The words a route and its card name an application by: a sole proprietor never by name (BR-NOTI ข้อ 10) */
export const applicationLabel = (app: { readonly payeeType: string; readonly nameTh: string; readonly number: string | null }): string =>
  app.payeeType === 'INDIVIDUAL' ? `ผู้ขายบุคคลธรรมดา · ${app.number ?? ''}`.trim() : app.nameTh

export const verifyAndRouteCommand = defineCommand({
  name: 'supplierApplication.verifyAndRoute',
  capability: 'supplier.application.route',
  input: ApplicationRef.extend({ registryProofFileId: z.uuid().optional() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ applicationId: string; routeId: string }>> {
    const refused = await memberGate(tx, ctx, 'supplier.application.route')
    if (refused) return refused
    if (ctx.actor.type !== 'USER') return fail('FORBIDDEN', 'a member sends an application on its route')
    const router = ctx.actor.memberId
    const app = await lockedApplication(tx, ctx, input.applicationId)
    if (!app) return fail('NOT_FOUND', 'application not found')
    if (app.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the application changed since it was opened', { currentVersion: app.version })
    if (app.status !== 'SUBMITTED') return fail('INVALID_STATE_TRANSITION', 'only a submitted application is sent on its route', { status: app.status })
    const types = await requiredTypes(tx, app.payeeType)
    const verified = new Set((await tx.supplierDocument.findMany({ where: { applicationId: app.id, status: 'VERIFIED' }, select: { documentTypeCode: true } })).map((d) => d.documentTypeCode))
    const unverified = types.filter((t) => !verified.has(t))
    if (unverified.length) return fail('SUPPLIER_DOCUMENT_UNVERIFIED', 'required documents are not verified', { types: unverified })
    // BR-SUP ข้อ 11: the registries asked again (a foreign supplier is not); ceased refuses, not found needs proof
    let registry: { outcome: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE' | 'SKIPPED'; source: 'RD' | 'DBD' | 'MANUAL' | 'STUB' | null; data: Record<string, unknown> | null } = { outcome: 'SKIPPED', source: null, data: null }
    if (app.payeeType !== 'FOREIGN' && app.taxId) {
      const checked = await checkRegistry(app.taxId, app.branchCode)
      if (checked.proposal.juristicStatus && CEASED.test(checked.proposal.juristicStatus)) return fail('VALIDATION_FAILED', 'the registry says the business has ceased', { reason: 'REGISTRY_CEASED' })
      const vatCancelled = checked.proposal.isVatRegistered === false && app.isVatRegistered
      if (checked.proposal.outcome === 'FOUND') {
        registry = { outcome: 'FOUND', source: checked.proposal.sources[0] ?? null, data: { ...checked.data, vatCancelled } }
      } else {
        if (!input.registryProofFileId) return fail('VALIDATION_FAILED', 'the registries could not confirm the supplier: attach proof', { field: 'registryProofFileId', reason: 'REGISTRY_PROOF_REQUIRED', outcome: checked.proposal.outcome })
        const own = await tx.fileObject.count({ where: { id: input.registryProofFileId, uploadedById: router, status: 'AVAILABLE' } })
        if (own !== 1) return fail('VALIDATION_FAILED', 'the proof must be a file you uploaded', { field: 'registryProofFileId', reason: 'FILE' })
        await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: input.registryProofFileId, subjectType: 'SupplierApplication', subjectId: app.id, kind: 'REGISTRY_PROOF' } })
        registry = { outcome: checked.proposal.outcome, source: 'MANUAL', data: { ...checked.data, vatCancelled, manualProof: true } }
      }
    }
    const inviter = app.invitedById ? await tx.member.findUnique({ where: { id: app.invitedById }, select: { primaryDepartmentId: true } }) : null
    const routerMember = await tx.member.findUniqueOrThrow({ where: { id: router }, select: { primaryDepartmentId: true } })
    const department = inviter?.primaryDepartmentId ?? routerMember.primaryDepartmentId
    if (!department) return fail('VALIDATION_FAILED', 'the inviter has no department to charge', { reason: 'DEPARTMENT' })
    const conflicted = await conflictedOf(tx, { ...app, routedById: router })
    const started = await startRoute(
      tx,
      ctx,
      { type: 'SUPPLIER_APPLICATION', id: app.id, label: applicationLabel(app), number: app.number },
      { documentType: 'SUPPLIER_APPROVAL', requesterMemberId: app.invitedById ?? router, chargedDepartmentId: department, conflictMemberIds: conflicted, at: ctx.now },
    )
    if (!started.ok) return { ok: false, error: started.error }
    await tx.supplierApplication.update({
      where: { id: app.id },
      data: {
        status: 'PENDING_APPROVAL',
        routedById: router,
        currentRouteId: started.data.routeId,
        ...(registry.source ? { registrySource: registry.source, registryData: registry.data as object, registryCheckedAt: ctx.now } : {}),
        lastActivityAt: ctx.now,
        version: { increment: 1 },
      },
    })
    return {
      ok: true,
      result: { applicationId: app.id, routeId: started.data.routeId },
      events: [
        { type: 'supplier_application.routed', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number: app.number ?? '', routeId: started.data.routeId, registryOutcome: registry.outcome } },
        ...started.data.events,
      ],
      notifications: started.data.notifications,
    }
  },
})

// ---------- the first sign-in of an application's contact (registered with portal.verifyOtp) ----------

/**
 * BR-SUP ข้อ 08 · the state machine's INVITED rows: the first sign-in of a contact of an INVITED application moves it —
 * a NEW application to DRAFT (the supplier starts filling in), an EXISTING one to APPROVED at once (the supplier is
 * approved already: its contact moves to it and the portal opens for it). Called inside portal.verifyOtp's transaction.
 */
export async function applicationSignedIn(tx: TenantTx, ctx: Ctx, contact: { readonly id: string; readonly applicationId: string | null; readonly supplierId: string | null }): Promise<EventDraft[]> {
  if (!contact.applicationId || contact.supplierId) return []
  await lockRowsForUpdate(tx, 'SupplierApplication', ctx.organizationId, [contact.applicationId])
  const app = await tx.supplierApplication.findUnique({ where: { id: contact.applicationId }, select: { id: true, kind: true, status: true, supplierId: true, number: true, version: true } })
  if (!app) return []
  if (app.status !== 'INVITED') {
    await tx.supplierApplication.update({ where: { id: app.id }, data: { lastActivityAt: ctx.now } })
    return []
  }
  if (app.kind === 'NEW') {
    await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'DRAFT', lastActivityAt: ctx.now, version: { increment: 1 } } })
    return [{ type: 'supplier_application.drafted', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { contactId: contact.id } }]
  }
  const supplierId = app.supplierId!
  await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'APPROVED', decidedAt: ctx.now, approvedSupplierId: supplierId, lastActivityAt: ctx.now, version: { increment: 1 } } })
  // the supplier keeps its primary contact: the invited person joins it as one more (supplier_contact_one_primary)
  const primary = await primaryOf(tx, supplierId)
  await tx.supplierContact.updateMany({ where: { applicationId: app.id }, data: { supplierId, ...(primary ? { isPrimary: false } : {}) } })
  await tx.supplier.update({ where: { id: supplierId }, data: { portalEnabled: true, version: { increment: 1 } } })
  return [
    { type: 'supplier_application.approved', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number: app.number, supplierId, kind: 'EXISTING', bankAccountChangeId: null } },
    { type: 'supplier.updated', aggregateType: 'Supplier', aggregateId: supplierId, data: { code: (await tx.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: { code: true } })).code, changed: ['portalEnabled'] } },
  ]
}

// ---------- the sealed account number, for the approval (S7-10's draftBankAccountChangeInTx takes it) ----------

/** The application's account number in clear: only where an approved application drafts its bank account change */
export function openAccountNo(organizationId: string, application: { readonly id: string; readonly accountNoEnc: string | null }): string | null {
  return application.accountNoEnc ? openSecret(application.accountNoEnc, accountContext(organizationId, application.id)) : null
}

// ---------- the commands as functions ----------

type RunResult<T> = Promise<Result<T>>
export const inviteSupplier = (ctx: Ctx, input: z.input<typeof InviteInput>, opts: RunOptions): RunResult<{ applicationId: string; contactId: string }> => runCommand(ctx, inviteSupplierCommand, input, opts)
export const reinviteSupplier = (ctx: Ctx, input: z.input<typeof ApplicationRef>, opts: RunOptions): RunResult<{ applicationId: string }> => runCommand(ctx, reinviteSupplierCommand, input, opts)
export const cancelApplication = (ctx: Ctx, input: z.input<typeof ApplicationRef> & { reason: string }, opts: RunOptions): RunResult<{ applicationId: string }> => runCommand(ctx, cancelApplicationCommand, input, opts)
export const updateApplication = (ctx: Ctx, input: z.input<typeof UpdateInput>, opts: RunOptions): RunResult<{ applicationId: string; version: number }> => runCommand(ctx, updateApplicationCommand, input, opts)
export const submitApplication = (ctx: Ctx, input: z.input<typeof ApplicationRef> & { duplicateReasons?: Record<string, string> }, opts: RunOptions): RunResult<{ applicationId: string; number: string }> =>
  runCommand(ctx, submitApplicationCommand, input, opts)
export const returnApplication = (ctx: Ctx, input: z.input<typeof ApplicationRef> & { reason: string }, opts: RunOptions): RunResult<{ applicationId: string }> => runCommand(ctx, returnApplicationCommand, input, opts)
export const verifyAndRoute = (ctx: Ctx, input: z.input<typeof ApplicationRef> & { registryProofFileId?: string }, opts: RunOptions): RunResult<{ applicationId: string; routeId: string }> => runCommand(ctx, verifyAndRouteCommand, input, opts)

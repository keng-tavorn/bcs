import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { PORTAL_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-portal'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'

// The contacts of a supplier (S7-04 · BR-SUP ข้อ 17 · BR-PORTAL ข้อ 01 ข้อ 03 · docs/sub-specs/S7.md "คำสั่งของขั้น"):
// PROCUREMENT adds, changes and deactivates them (supplier.contact.manage) and revokes their portal sessions. An e-mail
// is the key of a contact: lower case, one ACTIVE contact per address in the organization. A contact added to an ACTIVE
// supplier, or one whose e-mail changes, is told to the address in the register and to the primary contact before it
// (never to the new address), with the name of the member who did it. Deactivating a contact, and revoking its access,
// ends every session of it in the same transaction.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

const email = z
  .string()
  .trim()
  .max(254)
  .transform((s) => s.toLowerCase())
  .pipe(z.email())
const name = z.string().trim().min(1).max(200)
const optionalText = z.string().trim().max(200).nullable().optional()

interface Effects {
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
  readonly outbox: OutboxDraft[]
}

/** BR-SUP ข้อ 17: the register's address and the primary contact before the change hear who may now act for the supplier */
async function tellRegister(tx: TenantTx, ctx: Ctx, input: { readonly supplierId: string; readonly contactId: string; readonly contactName: string; readonly changed: 'ADDED' | 'EMAIL'; readonly primaryBefore: string | null }): Promise<Effects> {
  const out: Effects = { events: [], notifications: [], outbox: [] }
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: input.supplierId }, select: { status: true } })
  if (supplier.status !== 'ACTIVE') return out
  const by = ctx.actor.type === 'USER' ? await tx.member.findUnique({ where: { id: ctx.actor.memberId }, select: { displayNameTh: true, displayNameEn: true } }) : null
  const data = { contactName: input.contactName, changed: input.changed, addedByTh: by?.displayNameTh ?? '', addedByEn: by?.displayNameEn ?? '' }
  const targets: Array<{ supplierId?: string; contactId?: string; key: string }> = [{ supplierId: input.supplierId, key: 'register' }]
  if (input.primaryBefore && input.primaryBefore !== input.contactId) targets.push({ contactId: input.primaryBefore, key: `primary:${input.primaryBefore}` })
  for (const target of targets) {
    const notice = await enqueueSupplierNotice(tx, ctx, {
      templateKey: PORTAL_SUPPLIER_TEMPLATES.contactAdded,
      ...(target.supplierId ? { supplierId: target.supplierId } : { contactId: target.contactId! }),
      subjectType: 'SupplierContact',
      subjectId: input.contactId,
      dedupeKey: `supplier.contact_added:${ctx.requestId}:${input.contactId}:${target.key}`,
      data,
    })
    out.events.push(...notice.events)
    out.notifications.push(...notice.notifications)
    out.outbox.push(...notice.outbox)
  }
  return out
}

async function primaryOf(tx: TenantTx, supplierId: string): Promise<string | null> {
  return (await tx.supplierContact.findFirst({ where: { supplierId, isPrimary: true, status: 'ACTIVE' }, select: { id: true } }))?.id ?? null
}

/** Ends every live session of the contact, each with its event (BR-PORTAL ข้อ 03) */
export async function revokeContactSessions(tx: TenantTx, ctx: Ctx, contactId: string, reason: 'CONTACT_DEACTIVATED' | 'SUPPLIER_INACTIVE' | 'APPLICATION_CLOSED' | 'ADMIN'): Promise<EventDraft[]> {
  const live = await tx.portalSession.findMany({ where: { contactId, revokedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })
  if (live.length === 0) return []
  await tx.portalSession.updateMany({ where: { id: { in: live.map((s) => s.id) }, revokedAt: null }, data: { revokedAt: ctx.now, revokedReason: reason } })
  return live.map((s) => ({ type: 'portal_session.revoked', aggregateType: 'SupplierContact', aggregateId: contactId, data: { contactId, sessionId: s.id, reason } }))
}

async function allowed(tx: TenantTx, ctx: Ctx): Promise<Fail | null> {
  const on = await requireModule(ctx, 'SUPPLIER', tx)
  if (!on.ok) return { ok: false, error: on.error }
  const may = await authorize(tx, ctx, 'supplier.contact.manage')
  return may.ok ? null : { ok: false, error: may.error }
}

// ---------- supplierContact.create ----------

const CreateContactInput = z.object({
  supplierId: z.uuid(),
  nameTh: name,
  nameEn: optionalText,
  email,
  phone: z.string().trim().max(40).nullable().optional(),
  roleLabel: optionalText,
  isPrimary: z.boolean().default(false),
  locale: z.enum(['th', 'en']).default('th'),
  portalEnabled: z.boolean().default(true),
})

export const createSupplierContactCommand = defineCommand({
  name: 'supplierContact.create',
  capability: 'supplier.contact.manage',
  input: CreateContactInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ contactId: string }>> {
    const refused = await allowed(tx, ctx)
    if (refused) return refused
    await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [input.supplierId])
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true } })
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    if (await tx.supplierContact.findFirst({ where: { email: input.email, status: 'ACTIVE' }, select: { id: true } })) return fail('VALIDATION_FAILED', 'an active contact has this e-mail', { field: 'email', reason: 'EMAIL_TAKEN' })
    const primaryBefore = await primaryOf(tx, input.supplierId)
    if (input.isPrimary && primaryBefore) await tx.supplierContact.update({ where: { id: primaryBefore }, data: { isPrimary: false, version: { increment: 1 } } })
    const row = await tx.supplierContact.create({
      data: {
        organizationId: ctx.organizationId,
        supplierId: input.supplierId,
        nameTh: input.nameTh,
        nameEn: input.nameEn ?? null,
        email: input.email,
        phone: input.phone ?? null,
        roleLabel: input.roleLabel ?? null,
        isPrimary: input.isPrimary,
        locale: input.locale,
        portalEnabled: input.portalEnabled,
        createdById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
      },
      select: { id: true },
    })
    const told = await tellRegister(tx, ctx, { supplierId: input.supplierId, contactId: row.id, contactName: input.nameTh, changed: 'ADDED', primaryBefore })
    return {
      ok: true,
      result: { contactId: row.id },
      events: [
        { type: 'supplier_contact.created', aggregateType: 'SupplierContact', aggregateId: row.id, data: { supplierId: input.supplierId, applicationId: null, isPrimary: input.isPrimary, portalEnabled: input.portalEnabled } },
        ...told.events,
      ],
      notifications: told.notifications,
      outbox: told.outbox,
    }
  },
})

// ---------- supplierContact.update ----------

const UpdateContactInput = z.object({
  contactId: z.uuid(),
  expectedVersion: z.int().min(0),
  nameTh: name.optional(),
  nameEn: optionalText,
  email: email.optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  roleLabel: optionalText,
  isPrimary: z.boolean().optional(),
  locale: z.enum(['th', 'en']).optional(),
  portalEnabled: z.boolean().optional(),
})

const FIELDS = ['nameTh', 'nameEn', 'email', 'phone', 'roleLabel', 'isPrimary', 'locale', 'portalEnabled'] as const

export const updateSupplierContactCommand = defineCommand({
  name: 'supplierContact.update',
  capability: 'supplier.contact.manage',
  input: UpdateContactInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ contactId: string; version: number }>> {
    const refused = await allowed(tx, ctx)
    if (refused) return refused
    await lockRowsForUpdate(tx, 'SupplierContact', ctx.organizationId, [input.contactId])
    const contact = await tx.supplierContact.findUnique({ where: { id: input.contactId } })
    if (!contact || contact.status !== 'ACTIVE') return fail('NOT_FOUND', 'contact not found')
    if (contact.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the contact changed since it was opened', { currentVersion: contact.version })
    const changed = FIELDS.filter((f) => input[f] !== undefined && input[f] !== contact[f])
    if (changed.length === 0) return fail('VALIDATION_FAILED', 'nothing changed', { field: '(input)', reason: 'NO_CHANGE' })
    if (changed.includes('email') && (await tx.supplierContact.findFirst({ where: { email: input.email!, status: 'ACTIVE', id: { not: contact.id } }, select: { id: true } }))) {
      return fail('VALIDATION_FAILED', 'an active contact has this e-mail', { field: 'email', reason: 'EMAIL_TAKEN' })
    }
    const primaryBefore = contact.supplierId ? await primaryOf(tx, contact.supplierId) : null
    if (changed.includes('isPrimary') && input.isPrimary && primaryBefore && primaryBefore !== contact.id) {
      await tx.supplierContact.update({ where: { id: primaryBefore }, data: { isPrimary: false, version: { increment: 1 } } })
    }
    const data = Object.fromEntries(changed.map((f) => [f, input[f] ?? null]))
    const row = await tx.supplierContact.update({ where: { id: contact.id }, data: { ...data, version: { increment: 1 } }, select: { version: true } })
    const events: EventDraft[] = [{ type: 'supplier_contact.updated', aggregateType: 'SupplierContact', aggregateId: contact.id, data: { supplierId: contact.supplierId, changed } }]
    // an address changed or the portal taken away: the sessions of the old address end with it (BR-PORTAL ข้อ 03)
    if (changed.includes('email') || (changed.includes('portalEnabled') && input.portalEnabled === false)) events.push(...(await revokeContactSessions(tx, ctx, contact.id, 'ADMIN')))
    const told = changed.includes('email') && contact.supplierId ? await tellRegister(tx, ctx, { supplierId: contact.supplierId, contactId: contact.id, contactName: input.nameTh ?? contact.nameTh, changed: 'EMAIL', primaryBefore }) : null
    return {
      ok: true,
      result: { contactId: contact.id, version: row.version },
      events: [...events, ...(told?.events ?? [])],
      notifications: told?.notifications ?? [],
      outbox: told?.outbox ?? [],
    }
  },
})

// ---------- supplierContact.deactivate · supplierContact.revokeSessions ----------

const ContactRef = z.object({ contactId: z.uuid(), expectedVersion: z.int().min(0) })

export const deactivateSupplierContactCommand = defineCommand({
  name: 'supplierContact.deactivate',
  capability: 'supplier.contact.manage',
  input: ContactRef,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ contactId: string; sessionsRevoked: number }>> {
    const refused = await allowed(tx, ctx)
    if (refused) return refused
    await lockRowsForUpdate(tx, 'SupplierContact', ctx.organizationId, [input.contactId])
    const contact = await tx.supplierContact.findUnique({ where: { id: input.contactId }, select: { id: true, status: true, version: true, supplierId: true } })
    if (!contact) return fail('NOT_FOUND', 'contact not found')
    if (contact.status !== 'ACTIVE') return fail('INVALID_STATE_TRANSITION', 'the contact is not active', { status: contact.status })
    if (contact.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the contact changed since it was opened', { currentVersion: contact.version })
    await tx.supplierContact.update({ where: { id: contact.id }, data: { status: 'DEACTIVATED', deactivatedAt: ctx.now, isPrimary: false, version: { increment: 1 } } })
    const revoked = await revokeContactSessions(tx, ctx, contact.id, 'CONTACT_DEACTIVATED')
    return {
      ok: true,
      result: { contactId: contact.id, sessionsRevoked: revoked.length },
      events: [{ type: 'supplier_contact.deactivated', aggregateType: 'SupplierContact', aggregateId: contact.id, data: { supplierId: contact.supplierId, sessionsRevoked: revoked.length } }, ...revoked],
    }
  },
})

export const revokeSupplierContactSessionsCommand = defineCommand({
  name: 'supplierContact.revokeSessions',
  capability: 'supplier.contact.manage',
  input: z.object({ contactId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ contactId: string; sessionsRevoked: number }>> {
    const refused = await allowed(tx, ctx)
    if (refused) return refused
    await lockRowsForUpdate(tx, 'SupplierContact', ctx.organizationId, [input.contactId])
    if (!(await tx.supplierContact.findUnique({ where: { id: input.contactId }, select: { id: true } }))) return fail('NOT_FOUND', 'contact not found')
    const revoked = await revokeContactSessions(tx, ctx, input.contactId, 'ADMIN')
    if (revoked.length === 0) return fail('VALIDATION_FAILED', 'the contact has no session', { field: 'contactId', reason: 'NO_SESSION' })
    return { ok: true, result: { contactId: input.contactId, sessionsRevoked: revoked.length }, events: revoked }
  },
})

export const createSupplierContact = (ctx: Ctx, input: z.input<typeof CreateContactInput>, opts: RunOptions): Promise<Result<{ contactId: string }>> => runCommand(ctx, createSupplierContactCommand, input, opts)
export const updateSupplierContact = (ctx: Ctx, input: z.input<typeof UpdateContactInput>, opts: RunOptions): Promise<Result<{ contactId: string; version: number }>> =>
  runCommand(ctx, updateSupplierContactCommand, input, opts)
export const deactivateSupplierContact = (ctx: Ctx, input: z.input<typeof ContactRef>, opts: RunOptions): Promise<Result<{ contactId: string; sessionsRevoked: number }>> =>
  runCommand(ctx, deactivateSupplierContactCommand, input, opts)
export const revokeSupplierContactSessions = (ctx: Ctx, input: { contactId: string }, opts: RunOptions): Promise<Result<{ contactId: string; sessionsRevoked: number }>> =>
  runCommand(ctx, revokeSupplierContactSessionsCommand, input, opts)

import { documentTypeOfSubject } from '@/core/doa'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { PORTAL_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-portal'
import type { SubjectFacts } from '../../sla/subject'
import { applicationLabel, conflictedOf, toContacts } from '../../suppliers/applications'
import { suggestSupplierCode } from '../../suppliers/codes'
import { createSupplierInTx } from '../../suppliers/index'
import { revokeContactSessions } from '../../suppliers/contacts'
import type { SubjectAdapter, SubjectDecided } from './index'

// The SUPPLIER_APPLICATION approval subject (BR-DOA-26 · ADR-182 · BR-SUP ข้อ 11 · FR-SUP-104 AC2 ถึง AC5): an application
// sent under DOA SUPPLIER_APPROVAL with no amount, in its inviter's department. Kept off its route and refused at deciding
// (BR-SOD ข้อ 11): the inviter, whoever filled it in for the supplier, whoever sent it on its route and every verifier of
// its documents. Approving creates the supplier in decide's own transaction (createSupplierInTx · never a runCommand of
// its own), moves the application's contacts and documents to it and opens the portal for it; a second approval of the
// same application finds it APPROVED and is refused, so there is one supplier per application (INV-SUP ข้อ 02). A return
// or a rejection goes back to the supplier by e-mail. Chat button and e-mail link are open (OQ-189 default) — there is no
// amount and no step-up; questions go back as a return (allowsRequestInfo false). A sole proprietor is never named on a
// card (BR-NOTI ข้อ 10).

async function load(tx: TenantTx, id: string) {
  return tx.supplierApplication.findFirst({ where: { id } })
}

const refused = (message: string): SubjectDecided => ({ ok: false, error: { code: 'VALIDATION_FAILED', message, details: { reason: 'SUBJECT' } } })

/** Supplier.phone of an approved application and where it came from (ADR-190): the registry, the inviter, else the applicant */
function phoneOf(app: { readonly registryData: unknown; readonly inviterPhone: string | null; readonly phone: string | null }): { phone: string | null; source: 'REGISTRY' | 'INVITER' | 'APPLICANT' | null } {
  const registry = (app.registryData as { dbd?: { record?: { phone?: string } } } | null)?.dbd?.record?.phone ?? null
  if (registry) return { phone: registry, source: 'REGISTRY' }
  if (app.inviterPhone) return { phone: app.inviterPhone, source: 'INVITER' }
  return app.phone ? { phone: app.phone, source: 'APPLICANT' } : { phone: null, source: null }
}

/** BR-SUP ข้อ 11: the flag a supplier starts with — VAT cancelled at the registry, or confirmed by hand when not found */
function flagOf(app: { readonly payeeType: string; readonly registrySource: string | null; readonly registryData: unknown }): 'NONE' | 'VAT_CANCELLED' | 'NOT_FOUND' {
  if (app.payeeType === 'FOREIGN') return 'NONE'
  const data = (app.registryData ?? {}) as { vatCancelled?: boolean; manualProof?: boolean }
  if (data.vatCancelled) return 'VAT_CANCELLED'
  return app.registrySource === 'MANUAL' ? 'NOT_FOUND' : 'NONE'
}

export const supplierApplicationSubject: SubjectAdapter = {
  async facts(tx, id): Promise<SubjectFacts> {
    const app = await load(tx, id)
    const inviter = app?.invitedById ? await tx.member.findUnique({ where: { id: app.invitedById }, select: { primaryDepartmentId: true } }) : null
    return {
      type: 'SUPPLIER_APPLICATION',
      id,
      documentType: documentTypeOfSubject('SUPPLIER_APPLICATION'),
      number: app?.number ?? null,
      title: app ? applicationLabel(app) : null,
      changeKind: null,
      poId: null,
      ownerMemberId: app?.invitedById ?? null,
      conflictMemberIds: app ? await conflictedOf(tx, app) : [],
      chargedDepartmentId: inviter?.primaryDepartmentId ?? null,
    }
  },
  labels: (facts) => ({ label: facts.number ?? facts.title ?? facts.documentType, title: facts.title }),
  href: (facts) => `/suppliers/applications/${facts.id}`,
  async decide(tx, ctx, task, decision): Promise<SubjectDecided> {
    const applicationId = task.step.route.subjectId
    await lockRowsForUpdate(tx, 'SupplierApplication', ctx.organizationId, [applicationId])
    const app = await load(tx, applicationId)
    if (!app) return refused('no supplier application for this task')
    if (app.status !== 'PENDING_APPROVAL' || app.currentRouteId !== task.step.route.id) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'the application is not waiting for this route', details: { status: app.status } } }
    const events: EventDraft[] = []

    if (decision.outcome === 'RETURNED') {
      await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'RETURNED', currentRouteId: null, returnReason: decision.reason, lastActivityAt: ctx.now, version: { increment: 1 } } })
      const told = await toContacts(tx, ctx, app.id, PORTAL_SUPPLIER_TEMPLATES.applicationReturned, `route-returned:${task.id}`, { number: app.number, reason: decision.reason ?? '' })
      return {
        ok: true,
        documentStatus: 'RETURNED',
        events: [{ type: 'supplier_application.returned', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number: app.number, reasonCommentId: decision.reasonCommentId, by: 'APPROVER' } }, ...told.events],
        notifications: told.notifications,
      }
    }
    if (decision.outcome === 'REJECTED') {
      await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'REJECTED', decidedAt: ctx.now, rejectReason: decision.reason, version: { increment: 1 } } })
      const told = await toContacts(tx, ctx, app.id, PORTAL_SUPPLIER_TEMPLATES.applicationRejected, `route-rejected:${task.id}`, { number: app.number, reason: decision.reason ?? '' })
      await tx.portalInviteLink.updateMany({ where: { applicationId: app.id, usedAt: null, revokedAt: null }, data: { revokedAt: ctx.now } })
      const contacts = await tx.supplierContact.findMany({ where: { applicationId: app.id, supplierId: null }, select: { id: true }, orderBy: { id: 'asc' } })
      for (const c of contacts) events.push(...(await revokeContactSessions(tx, ctx, c.id, 'APPLICATION_CLOSED')))
      return {
        ok: true,
        documentStatus: 'REJECTED',
        events: [{ type: 'supplier_application.rejected', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number: app.number, reasonCommentId: decision.reasonCommentId } }, ...told.events, ...events],
        notifications: told.notifications,
      }
    }

    // APPROVED: the supplier of a NEW application is created here, with what the application confirmed
    const codes = (await tx.supplier.findMany({ select: { code: true } })).map((s) => s.code)
    const phone = phoneOf(app)
    const created = await createSupplierInTx(tx, ctx, {
      code: suggestSupplierCode(codes) ?? app.number ?? app.id.slice(0, 8),
      nameTh: app.nameTh,
      nameEn: app.nameEn,
      taxId: app.payeeType === 'FOREIGN' ? null : app.taxId,
      branchCode: app.branchCode,
      isVatRegistered: app.isVatRegistered,
      isForeign: app.payeeType === 'FOREIGN',
      email: app.email,
      phone: phone.phone,
      address: app.address,
      category: app.category,
      registry: app.registrySource ? { source: app.registrySource as 'RD' | 'DBD' | 'MANUAL' | 'STUB', status: null, data: { ...((app.registryData ?? {}) as object), phoneSource: phone.source } } : null,
      registryFlag: flagOf(app),
      payeeType: app.payeeType,
      defaultWhtIncomeTypeCode: app.whtIncomeTypeCode,
      paymentTermDays: app.paymentTermDays,
      portalEnabled: true,
      applicationId: app.id,
      via: 'APPLICATION',
      phoneSource: phone.source,
    })
    if (!created.ok) return { ok: false, error: created.error }
    const supplierId = created.supplierId
    await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'APPROVED', decidedAt: ctx.now, approvedSupplierId: supplierId, supplierId, version: { increment: 1 } } })
    await tx.supplierContact.updateMany({ where: { applicationId: app.id }, data: { supplierId } })
    await tx.supplierDocument.updateMany({ where: { applicationId: app.id }, data: { supplierId } })
    const code = (await tx.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: { code: true } })).code
    // S7-10 drafts the bank account change of an application that gave an account (draftBankAccountChangeInTx · ADR-190)
    const told = await toContacts(tx, ctx, app.id, PORTAL_SUPPLIER_TEMPLATES.applicationApproved, `approved:${task.id}`, { number: app.number, code })
    return {
      ok: true,
      documentStatus: 'APPROVED',
      events: [
        { type: 'supplier_application.approved', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number: app.number, supplierId, kind: app.kind, bankAccountChangeId: null } },
        ...created.events,
        ...told.events,
      ],
      notifications: told.notifications,
    }
  },
  allowsRequestInfo: false,
  // OQ-189 default: the chat button and the e-mail link (sign-in first) decide it; no step-up, there is no amount
  channels: { chatButton: () => true, emailLink: true, liff: true },
  // BR-SOD ข้อ 11: the inviter, the filler on behalf, the router and every verifier
  sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
}

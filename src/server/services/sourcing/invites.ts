import { getEnv } from '@/lib/env'
import { newId } from '@/lib/ids'
import type { Ctx } from '@/server/context'
import { newSecret, sha256Hex } from '@/server/crypto/portal'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { SOURCING_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-sourcing'
import { linkUrl } from '../suppliers/links'
import { supplierDocumentStatusInTx } from '../suppliers/documents'
import { supplierRiskStatus } from './risk-link'

// What an invite to an RFx needs besides its row (S10-04 · BR-RFX-03 · BR-NOTI-11): the contact who gets the e-mail, the
// snapshot of the supplier at invite time, and the one-time link of purpose RFX_INVITE. The link expires when the RFx
// closes (not supplier.inviteLinkDays: an RFP stays open ten business days), and a later close moves the expiry of
// links not used yet. A contact who used the link signs in again from /portal/<org>/login (S7).

export interface Effects {
  events: EventDraft[]
  notifications: NotificationDraft[]
  outbox: OutboxDraft[]
}
export const effects = (): Effects => ({ events: [], notifications: [], outbox: [] })
export function absorb(into: Effects, notice: { events: readonly EventDraft[]; notifications: readonly NotificationDraft[]; outbox: readonly OutboxDraft[] }) {
  into.events.push(...notice.events)
  into.notifications.push(...notice.notifications)
  into.outbox.push(...notice.outbox)
}

export async function orgCodeOf(tx: TenantTx, organizationId: string): Promise<string> {
  return (await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { code: true } })).code.toLowerCase()
}

/** /portal/<org>/login: where a contact signs in again after using the link */
export const portalLoginUrl = (orgCode: string): string => `${getEnv().APP_URL.replace(/\/$/, '')}/portal/${orgCode}/login`

/** The active contact who gets the e-mail: the primary one, else the first active (BR-RFX-03) */
export async function inviteContactOf(tx: TenantTx, owner: { readonly supplierId?: string | null; readonly applicationId?: string | null }): Promise<string | null> {
  const where = owner.supplierId ? { supplierId: owner.supplierId } : { applicationId: owner.applicationId! }
  const contact = await tx.supplierContact.findFirst({ where: { ...where, status: 'ACTIVE' }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
  return contact?.id ?? null
}

export interface SupplierSnapshot {
  readonly name: string
  readonly isVatRegistered: boolean
  readonly isForeign: boolean
  readonly registryFlag: string | null
  /** S7's supplierDocumentStatus: every required document VERIFIED and not expired today */
  readonly requiredDocumentsOk: boolean | null
  /** S11's risk through risk-link.ts; null without RISK or without a provider */
  readonly risk: { readonly tier: string | null; readonly blocked: boolean } | null
}

/** BR-RFX-03: what the comparison and the award show of the supplier as it was when invited */
export async function supplierSnapshot(
  tx: TenantTx,
  ctx: Ctx,
  owner: { readonly supplier?: { readonly id: string; readonly nameTh: string; readonly isVatRegistered: boolean; readonly isForeign: boolean; readonly registryFlag: string } | null; readonly application?: { readonly nameTh: string; readonly isVatRegistered: boolean; readonly payeeType: string } | null },
  riskOn: boolean,
): Promise<SupplierSnapshot> {
  if (owner.supplier) {
    const s = owner.supplier
    const docs = await supplierDocumentStatusInTx(tx, ctx.organizationId, s.id, ctx.now)
    const risk = riskOn ? await supplierRiskStatus(tx, ctx.organizationId, s.id, ctx.now) : null
    return { name: s.nameTh, isVatRegistered: s.isVatRegistered, isForeign: s.isForeign, registryFlag: s.registryFlag, requiredDocumentsOk: docs.requiredDocumentsOk, risk }
  }
  const a = owner.application!
  return { name: a.nameTh, isVatRegistered: a.isVatRegistered, isForeign: a.payeeType === 'FOREIGN', registryFlag: null, requiredDocumentsOk: null, risk: null }
}

/** A one-time link of purpose RFX_INVITE that expires when the RFx closes; only its sha256 is kept */
export async function issueRfxLink(
  tx: TenantTx,
  ctx: Ctx,
  input: { readonly orgCode: string; readonly contactId: string; readonly supplierId: string | null; readonly applicationId: string | null; readonly closesAt: Date },
): Promise<{ readonly linkId: string; readonly url: string }> {
  const token = newSecret()
  const linkId = newId()
  await tx.portalInviteLink.create({
    data: {
      id: linkId,
      organizationId: ctx.organizationId,
      contactId: input.contactId,
      purpose: 'RFX_INVITE',
      tokenHash: sha256Hex(token),
      expiresAt: input.closesAt,
      supplierId: input.supplierId,
      applicationId: input.applicationId,
      createdById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
    },
  })
  return { linkId, url: linkUrl(input.orgCode, token) }
}

export interface RfxMailFacts {
  readonly id: string
  readonly number: string | null
  readonly title: string
  readonly titleEn: string | null
  readonly closesAt: Date | null
  readonly questionCutoffAt: Date | null
  readonly revisionNo: number
}

/** Sends rfx.invited to an invite of an RFx that is OPEN: a link and the e-mail in one transaction (BR-NOTI-11) */
export async function sendInvitation(
  tx: TenantTx,
  ctx: Ctx,
  rfx: RfxMailFacts,
  invite: { readonly id: string; readonly contactId: string; readonly supplierId: string | null; readonly applicationId: string | null },
  knownOrgCode?: string,
): Promise<{ readonly linkId: string } & Effects> {
  const orgCode = knownOrgCode ?? (await orgCodeOf(tx, ctx.organizationId))
  const link = await issueRfxLink(tx, ctx, { orgCode, contactId: invite.contactId, supplierId: invite.supplierId, applicationId: invite.applicationId, closesAt: rfx.closesAt! })
  await tx.rfxInvite.update({ where: { id: invite.id }, data: { linkId: link.linkId } })
  const out = effects()
  absorb(
    out,
    await enqueueSupplierNotice(tx, ctx, {
      templateKey: SOURCING_SUPPLIER_TEMPLATES.invited,
      contactId: invite.contactId,
      supplierId: invite.supplierId,
      applicationId: invite.applicationId,
      subjectType: 'RfxEvent',
      subjectId: rfx.id,
      dedupeKey: `rfx.invited:${invite.id}:${link.linkId}`,
      data: { number: rfx.number, title: rfx.title, titleEn: rfx.titleEn, closesAt: rfx.closesAt!.toISOString(), questionCutoffAt: rfx.questionCutoffAt?.toISOString() ?? null, url: link.url, loginUrl: portalLoginUrl(orgCode) },
    }),
  )
  return { linkId: link.linkId, ...out }
}

/** An e-mail of the RFx to every invite in these statuses (amended, cancelled, closed …), once per reason and revision */
export async function mailInvites(
  tx: TenantTx,
  ctx: Ctx,
  rfx: RfxMailFacts,
  statuses: readonly ('INVITED' | 'VIEWED' | 'DECLINED' | 'BID_SUBMITTED' | 'WITHDRAWN')[],
  templateKey: string,
  key: string,
  data: Record<string, unknown>,
): Promise<Effects> {
  const invites = await tx.rfxInvite.findMany({ where: { rfxEventId: rfx.id, status: { in: [...statuses] } }, orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }], select: { id: true, contactId: true, supplierId: true, applicationId: true } })
  const orgCode = await orgCodeOf(tx, ctx.organizationId)
  const out = effects()
  for (const i of invites) {
    absorb(
      out,
      await enqueueSupplierNotice(tx, ctx, {
        templateKey,
        contactId: i.contactId,
        supplierId: i.supplierId,
        applicationId: i.applicationId,
        subjectType: 'RfxEvent',
        subjectId: rfx.id,
        dedupeKey: `${templateKey}:${i.id}:${key}`,
        data: { number: rfx.number, title: rfx.title, titleEn: rfx.titleEn, closesAt: rfx.closesAt?.toISOString() ?? null, revisionNo: rfx.revisionNo, loginUrl: portalLoginUrl(orgCode), ...data },
      }),
    )
  }
  return out
}

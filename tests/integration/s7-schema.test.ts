import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { testAppUrl, testMigratorUrl } from '../support/test-db'

// S7-01 (docs/sub-specs/S7.md "Entity และ migration" · ADR-183 · ADR-185 · ADR-188 · ADR-190): the one migration of
// S7 against real Postgres (ADR-027) — an event from the portal names its contact and no member (INV-SUP-05), and the
// CHECKs, partial uniques and append-only trigger hold what the services of S7-04 to S7-12 will rely on.

const NOW = new Date('2026-11-06T03:00:00Z')
const hex = () => createHash('sha256').update(randomUUID()).digest('hex')
let orgId: string
let memberId: string
let supplierId: string
let app: pg.Client
let migrator: pg.Client

async function sqlError(client: pg.Client, sql: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await client.query(sql, params)
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { code: `S7-${randomUUID().slice(0, 8)}`, legalNameTh: 'S7 schema', taxId: '0999999000055', settings: {} } })
  orgId = org.id
  memberId = (await prisma.member.create({ data: { organizationId: orgId, displayNameTh: 'จัดซื้อ', email: `s7-${randomUUID().slice(0, 8)}@test.bcs.local`, status: 'ACTIVE' } })).id
  supplierId = (await prisma.supplier.create({ data: { organizationId: orgId, code: 'S7-SUP', nameTh: 'ผู้ขาย S7', taxId: '0105555000011' } })).id
  app = new pg.Client({ connectionString: testAppUrl() })
  migrator = new pg.Client({ connectionString: testMigratorUrl() })
  await Promise.all([app.connect(), migrator.connect()])
})

afterAll(async () => {
  await Promise.all([app.end(), migrator.end()])
})

const contact = (data: Record<string, unknown> = {}) =>
  prisma.supplierContact.create({ data: { organizationId: orgId, supplierId, nameTh: 'ผู้ติดต่อ', email: `c-${randomUUID().slice(0, 8)}@supplier.test`, ...data } })

describe('[INV-SUP-05] [BR-PORTAL-06] an event from the portal names its contact, never a member', () => {
  it('appendEvents writes actorType SUPPLIER with actorSupplierContactId and no actorMemberId', async () => {
    const c = await contact()
    const ctx = makeCtx({ organizationId: orgId, actor: { type: 'SUPPLIER', supplierContactId: c.id, supplierId }, channel: 'PORTAL', now: NOW })
    const noticeId = randomUUID()
    const [appended] = await forTenant(orgId).$transaction((tx) =>
      appendEvents(tx, ctx, [{ type: 'supplier_notice.sent', aggregateType: 'SupplierNotice', aggregateId: noticeId, data: { noticeId, templateKey: 't', subjectType: 'PurchaseOrder', subjectId: noticeId } }]),
    )
    const row = await prisma.event.findUniqueOrThrow({ where: { id: appended!.id } })
    expect(row).toMatchObject({ actorType: 'SUPPLIER', actorSupplierContactId: c.id, actorMemberId: null, channel: 'PORTAL' })
  })

  it('a member actor leaves actorSupplierContactId empty', async () => {
    const ctx = makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId }, channel: 'WEB', now: NOW })
    const noticeId = randomUUID()
    const [appended] = await forTenant(orgId).$transaction((tx) =>
      appendEvents(tx, ctx, [{ type: 'supplier_notice.sent', aggregateType: 'SupplierNotice', aggregateId: noticeId, data: { noticeId, templateKey: 't', subjectType: 'PurchaseOrder', subjectId: noticeId } }]),
    )
    expect(await prisma.event.findUniqueOrThrow({ where: { id: appended!.id } })).toMatchObject({ actorType: 'USER', actorMemberId: memberId, actorSupplierContactId: null })
  })

  it('Postgres refuses a row that names a contact and a member, or a contact on a non-supplier actor (event_supplier_actor)', async () => {
    const insert = `insert into "Event"(id, "organizationId", type, "aggregateType", "aggregateId", "occurredAt", "actorType", "actorMemberId",
      "actorSupplierContactId", channel, "correlationId", "requestId", data, "schemaVersion")
      values ($1, $2, 'test.probe', 'Test', $1, now(), $3, $4, $5, 'PORTAL', $1, 'test', '{}', 1)`
    expect(await sqlError(app, insert, [randomUUID(), orgId, 'SUPPLIER', memberId, randomUUID()])).toBe('23514')
    expect(await sqlError(app, insert, [randomUUID(), orgId, 'USER', null, randomUUID()])).toBe('23514')
    expect(await sqlError(app, insert, [randomUUID(), orgId, 'SUPPLIER', null, randomUUID()])).toBeUndefined()
  })
})

describe('[BR-PORTAL-01] [BR-PORTAL-03] contacts, links and sessions keep only what they must', () => {
  it('a contact belongs to a supplier or an application, its email in lower case, one active per email', async () => {
    await expect(prisma.supplierContact.create({ data: { organizationId: orgId, nameTh: 'ไม่มีเจ้าของ', email: 'x@supplier.test' } })).rejects.toThrow(/supplier_contact_owner/)
    await expect(contact({ email: 'Upper@Supplier.test' })).rejects.toThrow(/supplier_contact_owner/)
    const first = await contact({ email: 'same@supplier.test' })
    await expect(contact({ email: 'same@supplier.test' })).rejects.toThrow(/Unique constraint/)
    // a deactivated contact frees the address
    await prisma.supplierContact.update({ where: { id: first.id }, data: { status: 'DEACTIVATED', deactivatedAt: NOW } })
    await expect(contact({ email: 'same@supplier.test' })).resolves.toBeTruthy()
  })

  it('one active primary contact per supplier', async () => {
    const own = await prisma.supplier.create({ data: { organizationId: orgId, code: `S7-P-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายหลัก', isForeign: true } })
    await contact({ supplierId: own.id, isPrimary: true })
    await expect(contact({ supplierId: own.id, isPrimary: true })).rejects.toThrow(/Unique constraint/)
    await expect(contact({ supplierId: own.id, isPrimary: false })).resolves.toBeTruthy()
  })

  it('a link keeps the sha256 of its token only; a session hash is unique in the organization', async () => {
    const c = await contact()
    const link = { organizationId: orgId, contactId: c.id, purpose: 'LOGIN' as const, expiresAt: new Date(NOW.getTime() + 15 * 60_000) }
    await expect(prisma.portalInviteLink.create({ data: { ...link, tokenHash: 'raw-token' } })).rejects.toThrow(/portal_invite_link_token_hash/)
    const tokenHash = hex()
    await prisma.portalInviteLink.create({ data: { ...link, tokenHash } })
    await expect(prisma.portalInviteLink.create({ data: { ...link, tokenHash } })).rejects.toThrow(/Unique constraint/)
    const session = { organizationId: orgId, contactId: c.id, sessionHash: hex(), csrfTokenHash: hex(), lastSeenAt: NOW, expiresAt: new Date('2099-01-01T00:00:00Z'), userAgentHash: hex(), ipHash: hex() }
    await prisma.portalSession.create({ data: session })
    await expect(prisma.portalSession.create({ data: { ...session, csrfTokenHash: hex() } })).rejects.toThrow(/Unique constraint/)
    // revokedAt and its reason come together
    await expect(prisma.portalSession.create({ data: { ...session, sessionHash: hex(), revokedAt: NOW } })).rejects.toThrow(/portal_session_shape/)
  })

  it('PortalIpRateLimit is global (no organizationId) and counts LINK and OTP only per sha256 of an IP', async () => {
    const fields = Object.keys(prisma.portalIpRateLimit.fields)
    expect(fields).not.toContain('organizationId')
    await expect(prisma.portalIpRateLimit.create({ data: { scopeKey: hex(), bucket: 'UPLOAD', windowStart: NOW } })).rejects.toThrow(/portal_ip_rate_limit_shape/)
    await expect(prisma.portalIpRateLimit.create({ data: { scopeKey: hex(), bucket: 'OTP', windowStart: NOW, count: 1 } })).resolves.toBeTruthy()
  })
})

describe('[BR-SUP-08] [BR-SUP-09] [INV-SUP-02] applications', () => {
  const application = (data: Record<string, unknown> = {}) =>
    prisma.supplierApplication.create({ data: { organizationId: orgId, kind: 'NEW', invitedById: memberId, invitedAt: NOW, lastActivityAt: NOW, expiresAt: NOW, nameTh: 'ผู้สมัคร', ...data } })

  it('an EXISTING application names its supplier; a foreign payee has no Thai tax id', async () => {
    await expect(application({ kind: 'EXISTING' })).rejects.toThrow(/supplier_application_shape/)
    await expect(application({ kind: 'EXISTING', supplierId })).resolves.toBeTruthy()
    await expect(application({ payeeType: 'FOREIGN', taxId: '0105555000029' })).rejects.toThrow(/supplier_application_shape/)
    await expect(application({ accountNoEnc: 'enc' })).rejects.toThrow(/supplier_application_shape/)
  })

  it('one open NEW application per tax id and branch; a closed one frees it', async () => {
    const first = await application({ taxId: '0105555000037' })
    await expect(application({ taxId: '0105555000037' })).rejects.toThrow(/Unique constraint/)
    await expect(application({ taxId: '0105555000037', branchCode: '00001' })).resolves.toBeTruthy()
    await prisma.supplierApplication.update({ where: { id: first.id }, data: { status: 'CANCELLED' } })
    await expect(application({ taxId: '0105555000037' })).resolves.toBeTruthy()
  })
})

describe('[BR-SDOC-02] [BR-SDOC-03] [INV-SUP-03] supplier documents', () => {
  let fileId: string
  beforeAll(async () => {
    await prisma.supplierDocumentType.create({ data: { organizationId: orgId, code: 'ISO_CERT', nameTh: 'ISO', nameEn: 'ISO', appliesTo: ['JURISTIC'], singleInstance: false } })
    fileId = (await prisma.fileObject.create({ data: { organizationId: orgId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'iso.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: '0'.repeat(64), status: 'AVAILABLE', uploadedById: memberId } })).id
  })
  const document = (data: Record<string, unknown> = {}) =>
    prisma.supplierDocument.create({ data: { organizationId: orgId, supplierId, documentTypeCode: 'ISO_CERT', fileId, issuedOn: new Date('2026-01-01'), expiresOn: new Date('2026-12-31'), ...data } })
  const verified = { status: 'VERIFIED' as const, verifiedAt: NOW }

  it('expires on or after its issue date, names its owner, and a VERIFIED one names who verified it', async () => {
    await expect(document({ expiresOn: new Date('2025-12-31') })).rejects.toThrow(/supplier_document_shape/)
    await expect(document({ supplierId: null })).rejects.toThrow(/supplier_document_shape/)
    await expect(document({ status: 'VERIFIED' })).rejects.toThrow(/supplier_document_shape/)
    await expect(document({ status: 'REJECTED' })).rejects.toThrow(/supplier_document_shape/)
    // an expired or superseded document keeps the name of who verified it
    await expect(document({ ...verified, verifiedById: memberId, status: 'EXPIRED' })).resolves.toBeTruthy()
  })

  it('one VERIFIED document per supplier, type and scope; another scope is another document (GC-SUP ข้อ 52 ถึง 54)', async () => {
    await document({ ...verified, verifiedById: memberId, scope: 'ISO 9001', scopeKey: 'iso 9001' })
    await expect(document({ ...verified, verifiedById: memberId, scope: 'iso  9001', scopeKey: 'iso 9001' })).rejects.toThrow(/Unique constraint/)
    await expect(document({ ...verified, verifiedById: memberId, scope: 'ISO 27001', scopeKey: 'iso 27001' })).resolves.toBeTruthy()
    // PENDING ones are not counted
    await expect(document({ scope: 'ISO 9001', scopeKey: 'iso 9001' })).resolves.toBeTruthy()
  })
})

describe('[BR-SUP-14] acknowledgements of a PO are append-only', () => {
  it('refuses UPDATE and DELETE by the app role and by the owner role', async () => {
    // the privileges refuse the app role before any row is looked at; the trigger guards the owner role
    const id = randomUUID()
    expect(await sqlError(app, `update "PoAcknowledgement" set note = 'x' where id = $1`, [id])).toBe('42501')
    expect(await sqlError(app, `delete from "PoAcknowledgement" where id = $1`, [id])).toBe('42501')
    const triggers = await migrator.query(`select tgname from pg_trigger where tgrelid = '"PoAcknowledgement"'::regclass and not tgisinternal`)
    expect(triggers.rows.map((r: { tgname: string }) => r.tgname)).toContain('po_acknowledgement_append_only')
  })
})

describe('[BR-SOD-12] [BR-NOTI-09] what S7 changed in the tables of S8 and S9', () => {
  it('a bank account change from the portal has no member until claimed; an internal one, or one past DRAFT, has one', async () => {
    const c = await contact()
    const base = { organizationId: orgId, kind: 'ADD' as const, ownerKind: 'SUPPLIER' as const, supplierId, bankCode: '002', accountNo: '9000000001', accountName: 'ผู้ขาย S7', reason: 'บัญชีใหม่' }
    await expect(prisma.bankAccountChange.create({ data: { ...base, source: 'INTERNAL' } })).rejects.toThrow(/bank_account_change_submitter/)
    await expect(prisma.bankAccountChange.create({ data: { ...base, source: 'INTERNAL', submittedById: memberId, proposedByContactId: c.id, status: 'CANCELLED' } })).rejects.toThrow(/bank_account_change_submitter/)
    await expect(prisma.bankAccountChange.create({ data: { ...base, source: 'PORTAL', proposedByContactId: c.id, status: 'PENDING_APPROVAL' } })).rejects.toThrow(/bank_account_change_submitter/)
    const drafted = await prisma.bankAccountChange.create({ data: { ...base, source: 'PORTAL', proposedByContactId: c.id } })
    expect(drafted.submittedById).toBeNull()
    // FINANCE claims it before anything else happens to it (ADR-190)
    await expect(prisma.bankAccountChange.update({ where: { id: drafted.id }, data: { status: 'CANCELLED' } })).rejects.toThrow(/bank_account_change_submitter/)
    await expect(prisma.bankAccountChange.update({ where: { id: drafted.id }, data: { submittedById: memberId, claimedAt: NOW, status: 'CANCELLED' } })).resolves.toBeTruthy()
  })

  it('a supplier notice names a supplier, an application or a contact', async () => {
    const notice = { organizationId: orgId, templateKey: 't', subjectType: 'SupplierApplication', subjectId: randomUUID(), dedupeKey: randomUUID() }
    await expect(prisma.supplierNotice.create({ data: notice })).rejects.toThrow(/supplier_notice_recipient/)
    const c = await contact()
    await expect(prisma.supplierNotice.create({ data: { ...notice, contactId: c.id } })).resolves.toBeTruthy()
  })
})

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { approvalCardMessage } from '@/server/line/postback-cards'
import { portalCtx } from '@/server/portal/session'
import { listMyTasks } from '@/server/queries/tasks'
import { getSupplierApplicationTaskView } from '@/server/services/suppliers/application-view'
import { applicationSignedIn, inviteSupplier, submitApplication, updateApplication, verifyAndRoute } from '@/server/services/suppliers/applications'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-09 (FR-SUP-104 AC5 · BR-NOTI ข้อ 10): the approval task of a supplier application on the approver's surfaces. The
// view of the web and LIFF task pages is read by the task's approver (supplier.application.view ASSIGNED) and PROCUREMENT
// FINANCE AUDITOR, refused to any other member; a sole proprietor's tax id shows its last four digits, and neither the
// inbox row nor the LINE card nor the view's label ever names them (the full name is on the signed-in pages only).

const NOW = new Date('2026-11-02T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
const as = (code: string) => org.ctxOf(code, NOW)

/** A taxpayer id with its check digit (BR-TAXID-01): a juristic one starts with 0, a Thai individual's with 1 to 8 */
function taxId(first = 0): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? first : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

async function file(memberCode = 'proc_officer') {
  return prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member[memberCode]! } })
}

async function document(applicationId: string, type: string) {
  const f = await file()
  return prisma.supplierDocument.create({ data: { organizationId: org.organizationId, applicationId, documentTypeCode: type, fileId: f.id, issuedOn: new Date('2026-10-01'), expiresOn: new Date('2027-03-29') } })
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  // who sends applications on their route and verifies their documents; dm_proc (the SA-01 approver) holds no role
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.asst_con!, role: 'PROCUREMENT', grantedAt: NOW } })
  await prisma.supplierDocumentType.createMany({
    data: [
      { organizationId: org.organizationId, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true, validityDays: 180 },
      { organizationId: org.organizationId, code: 'ID_CARD', nameTh: 'บัตรประชาชน', nameEn: 'ID card', appliesTo: ['INDIVIDUAL'], required: true, sensitive: true },
    ],
  })
})

const contactCtx = (contact: { id: string; applicationId: string | null; supplierId: string | null }): Ctx => portalCtx(org.organizationId, contact, NOW)
const version = async (id: string) => (await prisma.supplierApplication.findUniqueOrThrow({ where: { id } })).version

/** Invited, filled in by its contact with its one required document, submitted, verified and sent on its SA-01 route */
async function routed(options: { nameTh: string; payeeType: 'JURISTIC' | 'INDIVIDUAL'; category?: string }) {
  const individual = options.payeeType === 'INDIVIDUAL'
  const invite = await inviteSupplier(
    as('proc_officer'),
    {
      kind: 'NEW',
      nameTh: options.nameTh,
      taxId: taxId(individual ? 3 : 0),
      branchCode: '00000',
      payeeType: options.payeeType,
      category: options.category ?? null,
      contact: { nameTh: 'ผู้ติดต่อ', email: `view-${randomUUID().slice(0, 8)}@supplier.test` },
    } as Parameters<typeof inviteSupplier>[1],
    key(),
  )
  if (!invite.ok) throw new Error(JSON.stringify(invite.error))
  const applicationId = invite.data.applicationId
  const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: invite.data.contactId } })
  await forTenant(org.organizationId).$transaction((tx) => applicationSignedIn(tx, contactCtx(contact), contact))
  await prisma.supplierContact.update({ where: { id: contact.id }, data: { privacyNoticeVersion: '2026-11-01' } })
  const ctx = contactCtx(contact)
  const u = await updateApplication(ctx, { applicationId, expectedVersion: await version(applicationId), fields: { address: '1 ถนนพระราม 4 กรุงเทพฯ', isVatRegistered: !individual } }, key())
  if (!u.ok) throw new Error(JSON.stringify(u.error))
  await document(applicationId, individual ? 'ID_CARD' : 'COMPANY_CERT')
  const s = await submitApplication(ctx, { applicationId, expectedVersion: await version(applicationId) }, key())
  if (!s.ok) throw new Error(JSON.stringify(s.error))
  await prisma.supplierDocument.updateMany({ where: { applicationId }, data: { status: 'VERIFIED', verifiedById: org.member.asst_con!, verifiedAt: NOW } })
  const proof = await file('asst_con')
  const r = await verifyAndRoute(as('asst_con'), { applicationId, expectedVersion: await version(applicationId), registryProofFileId: proof.id }, key())
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { routeId: r.data.routeId } }, orderBy: { createdAt: 'asc' } })
  return { applicationId, number: s.data.number, task }
}

describe('[FR-SUP-104/AC5] the approver reads the application on the task pages', () => {
  it('the approver of the task and PROCUREMENT read its facts; a member without rights is FORBIDDEN; an unknown id is NOT_FOUND', async () => {
    const a = await routed({ nameTh: `บริษัท ดูงาน ${randomUUID().slice(0, 6)} จำกัด`, payeeType: 'JURISTIC', category: 'ผู้รับเหมาก่อสร้าง' })
    expect(a.task.assigneeMemberId).toBe(org.member.dm_proc)

    const seen = await getSupplierApplicationTaskView(as('dm_proc'), a.applicationId)
    if (!seen.ok) throw new Error(JSON.stringify(seen.error))
    expect(seen.data).toMatchObject({
      number: a.number,
      payeeType: 'JURISTIC',
      category: 'ผู้รับเหมาก่อสร้าง',
      taxIdMasked: false,
      branchCode: '00000',
      registry: { source: 'MANUAL', vatCancelled: false },
      invitedBy: { th: expect.any(String) },
      routedBy: { th: expect.any(String) },
      filledOnBehalfBy: null,
    })
    expect(seen.data.label).toBe(seen.data.nameTh)
    expect(seen.data.taxId).toMatch(/^0\d{12}$/)
    expect(seen.data.documents).toEqual([expect.objectContaining({ typeCode: 'COMPANY_CERT', status: 'VERIFIED', typeName: { th: 'หนังสือรับรองบริษัท', en: 'Company certificate' }, verifiedBy: expect.objectContaining({ th: expect.any(String) }) })])

    expect(await getSupplierApplicationTaskView(as('proc_officer'), a.applicationId)).toMatchObject({ ok: true })
    expect(await getSupplierApplicationTaskView(as('req_con'), a.applicationId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'supplier.application.view' } } })
    expect(await getSupplierApplicationTaskView(as('dm_proc'), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await getSupplierApplicationTaskView(as('dm_proc'), 'not-a-uuid')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('[BR-NOTI-10] a sole proprietor: tax id masked to its last four, never named by the label, the inbox row or the LINE card', async () => {
    const name = `นายทดสอบ ${randomUUID().slice(0, 6)} บุคคล`
    const a = await routed({ nameTh: name, payeeType: 'INDIVIDUAL', category: 'งานไฟฟ้า' })
    const stored = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })

    const seen = await getSupplierApplicationTaskView(as('dm_proc'), a.applicationId)
    if (!seen.ok) throw new Error(JSON.stringify(seen.error))
    expect(seen.data.taxIdMasked).toBe(true)
    expect(seen.data.taxId).toBe(`${'X'.repeat(9)}${stored.taxId!.slice(-4)}`)
    expect(seen.data.label).toBe(`ผู้ขายบุคคลธรรมดา · ${a.number}`)
    expect(seen.data.label).not.toContain(name)

    const inbox = await listMyTasks(as('dm_proc'))
    const row = inbox.items.find((i) => i.id === a.task.id)
    expect(row?.subject).toMatchObject({ kind: 'SUPPLIER_APPLICATION', number: a.number, supplierName: null, category: 'งานไฟฟ้า' })
    expect(JSON.stringify(row)).not.toContain(name)

    const card = await approvalCardMessage(org.organizationId, { taskId: a.task.id, memberId: org.member.dm_proc!, fallbackLabel: seen.data.label }, NOW, { locale: 'th', liffId: null, appUrl: 'http://localhost:3000' })
    expect(card).not.toBeNull()
    const text = JSON.stringify(card)
    expect(text).not.toContain(name)
    expect(text).not.toContain(stored.taxId!)
    expect(text).toContain(`ผู้ขายบุคคลธรรมดา · ${a.number}`)
    expect(text).toContain('งานไฟฟ้า')
    expect(text).toContain('1 ฉบับ')
  })

  it('the LINE card of a juristic supplier names it, its inviter as the requester, and says the duplicate warnings', async () => {
    const name = `บริษัท การ์ด ${randomUUID().slice(0, 6)} จำกัด`
    const a = await routed({ nameTh: name, payeeType: 'JURISTIC' })
    const card = await approvalCardMessage(org.organizationId, { taskId: a.task.id, memberId: org.member.dm_proc!, fallbackLabel: a.number }, NOW, { locale: 'th', liffId: null, appUrl: 'http://localhost:3000' })
    const text = JSON.stringify(card)
    expect(text).toContain(name)
    expect(text).toContain('ผู้เชิญ')
    expect(text).toContain('เตือนซ้ำ')
    expect(text).toContain('ใบสมัครผู้ขาย')
    // another member's card: nothing (the task is not theirs)
    expect(await approvalCardMessage(org.organizationId, { taskId: a.task.id, memberId: org.member.req_con!, fallbackLabel: a.number }, NOW, { locale: 'th', liffId: null, appUrl: 'http://localhost:3000' })).toBeNull()
  })

  it('SUPPLIER off: MODULE_DISABLED', async () => {
    const off = await createP2Org({ modules: ['PAY'] })
    expect(await getSupplierApplicationTaskView(off.ctxOf('dm_proc', NOW), randomUUID())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

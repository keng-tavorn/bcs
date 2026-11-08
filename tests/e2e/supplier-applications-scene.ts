import { randomUUID } from 'node:crypto'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { getEnv } from '@/lib/env'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { deliverNotification } from '@/server/notifications/deliver'
import { portalCtx } from '@/server/portal/session'
import { seedDevPins } from '@/server/seed/pins'
import { openLineChannel, seedLineChannel } from '@/server/services/line-channel'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { applicationSignedIn, submitApplication, updateApplication } from '@/server/services/suppliers/applications'
import { E2E_DB, E2E_PIN } from '../support/e2e-env'
import { createP2Org } from '../support/p2-org'

// Run by tests/e2e/supplier-applications.spec.ts against the e2e database only (S7-09, scenes 1 and 3 of Demo_Script_P2 on
// the workspace's side). Modes:
//   setup <tag> <lineUserId>  an organization of its own with PAY and SUPPLIER (phase-2 fixtures, AI off), its LINE channel
//                             and PINs, proc_officer asst_con dm_proc able to sign in (e-mail <code>.<tag>@p2.bcs.local),
//                             dm_proc (SA-01) linked to the LINE user, a required document type and a registered supplier
//                             whose name a new invitation will resemble
//   fill <applicationId>      the supplier's side of the portal (S7-08 does it in the browser): signed in, the address, the
//                             company certificate (scanned clean), sent
//   deliver <applicationId>   dm_proc's pending notices delivered (the e2e app sends no outbox to Inngest): the card by LINE
//   state <applicationId>     the application's status and how its task was decided
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the supplier applications scene runs in the e2e database only')
setDefaultOutboxSender(null)
const [mode, a1, a2] = process.argv.slice(2)
const now = () => new Date()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

async function orgOfApplication(applicationId: string) {
  return prisma.supplierApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { organizationId: true } })
}

if (mode === 'setup') {
  if (!a1 || !/^[a-z0-9]+$/.test(a1) || !a2 || !/^U[0-9a-f]{32}$/.test(a2)) throw new Error('setup <tag> <lineUserId>')
  const tag = a1
  const org = await createP2Org({ modules: ['PAY', 'SUPPLIER'] })
  const at = now()
  await prisma.organization.update({ where: { id: org.organizationId }, data: { displayName: `ทดสอบผู้ขาย ${tag}` } })
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'CORE', enabled: true, enabledAt: at, contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.asst_con!, role: 'PROCUREMENT', grantedAt: at } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: at } })
  const line = await seedLineChannel(org.organizationId, getEnv(), at)
  if (line.status !== 'CREATED') throw new Error(`the LINE channel was not saved: ${line.status}`)
  await seedDevPins(org.organizationId, E2E_PIN, at)
  const password = process.env.SEED_DEV_PASSWORD
  const totpKey = process.env.SEED_TOTP_KEY
  if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')
  for (const code of ['proc_officer', 'asst_con', 'dm_proc']) {
    const local = `${code}.${tag}`
    const email = `${local}@p2.bcs.local`
    const userId = await upsertUserWithPassword({ email, name: `ผู้ใช้ ${code}`, password })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, local), deriveSeedBackupCodes(totpKey, local))
    await prisma.member.update({ where: { id: org.member[code]! }, data: { email, userId } })
  }
  const issued = await issueLineLinkCode(makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.dm_proc! }, channel: 'WEB', now: at }), at)
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code}`)
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: a2, aud: process.env.LINE_LIFF_CHANNEL_ID }) })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code}`)
  await prisma.supplierDocumentType.create({ data: { organizationId: org.organizationId, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true, validityDays: 180 } })
  const existingName = `บริษัท เหล็กสยาม ${tag} จำกัด`
  await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `SIAM-${tag.slice(0, 4).toUpperCase()}`, nameTh: existingName, taxId: '0105536000552', branchCode: '00000' } })
  const channel = await openLineChannel(org.organizationId)
  if (!channel.ok) throw new Error(`no LINE channel: ${channel.reason}`)
  const orgCode = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { code: true } })).code
  console.log(JSON.stringify({ orgCode, existingName, channelKey: channel.channel.channelKey }))
} else if (mode === 'fill') {
  const { organizationId } = await orgOfApplication(a1!)
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { applicationId: a1!, isPrimary: true } })
  const at = now()
  await forTenant(organizationId).$transaction((tx) => applicationSignedIn(tx, portalCtx(organizationId, contact, at), contact))
  await prisma.supplierContact.update({ where: { id: contact.id }, data: { privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  const ctx = portalCtx(organizationId, contact, at)
  const version = async () => (await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a1! } })).version
  const u = await updateApplication(ctx, { applicationId: a1!, expectedVersion: await version(), fields: { address: '88 ถนนสุขุมวิท กรุงเทพฯ 10110', isVatRegistered: true } }, key())
  if (!u.ok) throw new Error(JSON.stringify(u.error))
  const file = await prisma.fileObject.create({ data: { organizationId, storageKey: `e2e/${randomUUID()}.pdf`, fileName: 'หนังสือรับรอง.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', scanStatus: 'CLEAN' } })
  await prisma.fileLink.create({ data: { organizationId, fileId: file.id, subjectType: 'SupplierApplication', subjectId: a1!, kind: 'SUPPLIER_DOC' } })
  await prisma.supplierDocument.create({ data: { organizationId, applicationId: a1!, documentTypeCode: 'COMPANY_CERT', fileId: file.id, issuedOn: new Date('2026-10-01'), expiresOn: new Date('2027-03-29') } })
  const s = await submitApplication(ctx, { applicationId: a1!, expectedVersion: await version() }, key())
  if (!s.ok) throw new Error(JSON.stringify(s.error))
  console.log(JSON.stringify({ number: s.data.number }))
} else if (mode === 'deliver') {
  const { organizationId } = await orgOfApplication(a1!)
  const approver = await prisma.member.findFirstOrThrow({ where: { organizationId, email: { startsWith: 'dm_proc.' } }, select: { id: true } })
  const pending = await prisma.notification.findMany({ where: { organizationId, status: 'PENDING', urgency: 'IMMEDIATE', recipientMemberId: approver.id }, orderBy: [{ createdAt: 'asc' }], select: { id: true, templateKey: true } })
  const delivered = []
  for (const n of pending) delivered.push({ templateKey: n.templateKey, outcome: await deliverNotification(organizationId, n.id, now(), { openChannel: openLineChannel }) })
  console.log(JSON.stringify(delivered))
} else if (mode === 'state') {
  const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a1! }, select: { status: true, approvedSupplierId: true } })
  const decided = await prisma.event.findFirst({ where: { type: 'approval_task.decided', data: { path: ['subjectId'], equals: a1! } }, orderBy: { seq: 'desc' }, select: { data: true } })
  console.log(JSON.stringify({ status: app.status, supplierId: app.approvedSupplierId, channel: (decided?.data as { channel?: string } | undefined)?.channel ?? null }))
} else {
  throw new Error(`unknown mode ${mode}`)
}
await prisma.$disconnect()

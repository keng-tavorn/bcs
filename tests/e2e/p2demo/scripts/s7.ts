import { createHash, randomUUID } from 'node:crypto'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { scanFile } from '@/server/services/suppliers/documents'
import { E2E_DB, E2E_P2DEMO } from '../../../support/e2e-env'

// Run by the scenes of phase 2 (tests/e2e/p2demo, S7-17 · ADR-191, through ../support.ts) against the p2demo e2e database
// only, on SIMEC of the phase-1 workbook: what happens outside the screens, and what a scene reads back. Prints JSON on
// its last line; amounts are satang as strings. The portal's codes and sessions printed here are of this test database.
//   invitation <email>      the newest application whose primary contact has that e-mail: its id, status and number, the
//                           contact, and the link of the invitation e-mail as the notice holds it (the e2e app sends
//                           nothing to Mailpit)
//   code <contactId>        the newest sign-in code e-mailed to the contact (its notice)
//   scan <applicationId>    the central scan of every file of the application's documents still PENDING, clean (job
//                           file-scan: the e2e app has no Inngest), so procurement can verify them
//   scan-proofs <changeId>  the central scan of the proofs attached to a bank account change, clean
//   application <id>        an application: status, number, the supplier it made (code), its bank account change (status
//                           and number), the channel its approval was decided on
//   session <email>         a session of the portal for an ACTIVE contact of that e-mail, the privacy notice of today
//                           acknowledged and first signed in (what scene 1 does on the screens once for its contact)
//   stuck <ref>             the application of a row of Supplier_Applications by its contact: status, escalatedAt, what
//                           is missing, the notices the supplier got (reminder) and who in BCS was told (escalation)
//   history-po <ref>        the PO the history made for a row of Request_History (its draft's events carry the row's
//                           key): id, number, status, amounts, acknowledgement
//   told <poId>             who was told of the acknowledgement and of a new date (template, member's code, urgency)
//   paid <supplierCode>     the payment items the history paid the supplier: run number, transfer, the account's last four
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the scene script of phase 2 runs in its e2e database only')
if (!E2E_P2DEMO) throw new Error('the scene script of phase 2 runs in p2demo mode only (E2E_P2DEMO=1)')
setDefaultOutboxSender(null)
const [mode, arg] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'SIMEC' }, select: { id: true, code: true } })
const organizationId = org.id
const sha = (v: string) => createHash('sha256').update(v).digest('hex')
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
const codeOf = async (memberId: string | null) => (memberId ? ((await prisma.member.findUnique({ where: { id: memberId }, select: { employeeCode: true } }))?.employeeCode ?? null) : null)

if (mode === 'invitation') {
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId, email: arg!.toLowerCase(), applicationId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, applicationId: true } })
  const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: contact.applicationId! }, select: { id: true, status: true, number: true } })
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { applicationId: app.id, templateKey: 'supplier.invitation' }, orderBy: { createdAt: 'desc' } })
  out({ applicationId: app.id, status: app.status, number: app.number, contactId: contact.id, url: (notice.data as { url: string }).url })
} else if (mode === 'code') {
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { organizationId, contactId: arg!, templateKey: 'supplier.otp' }, orderBy: { createdAt: 'desc' } })
  out({ code: (notice.data as { code: string }).code })
} else if (mode === 'scan') {
  const docs = await prisma.supplierDocument.findMany({ where: { organizationId, applicationId: arg!, file: { scanStatus: 'PENDING' } }, select: { fileId: true } })
  const now = new Date()
  for (const d of docs) await scanFile(organizationId, d.fileId, now)
  out({ scanned: docs.length })
} else if (mode === 'scan-proofs') {
  // the proofs FINANCE attached to a bank account change, scanned clean (job file-scan: the e2e app has no Inngest)
  const links = await prisma.fileLink.findMany({ where: { organizationId, subjectType: 'BankAccountChange', subjectId: arg!, kind: 'BANK_PROOF', file: { scanStatus: 'PENDING' } }, select: { fileId: true } })
  const now = new Date()
  for (const l of links) await scanFile(organizationId, l.fileId, now)
  out({ scanned: links.length })
} else if (mode === 'application') {
  const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: arg! }, select: { status: true, number: true, approvedSupplierId: true, currentRouteId: true } })
  const supplier = app.approvedSupplierId ? await prisma.supplier.findUnique({ where: { id: app.approvedSupplierId }, select: { code: true } }) : null
  const change = app.approvedSupplierId ? await prisma.bankAccountChange.findFirst({ where: { organizationId, supplierId: app.approvedSupplierId }, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, status: true, source: true } }) : null
  const decided = await prisma.event.findFirst({ where: { organizationId, type: 'approval_task.decided', data: { path: ['subjectId'], equals: arg! } }, orderBy: { seq: 'desc' }, select: { data: true } })
  out({ status: app.status, number: app.number, supplierCode: supplier?.code ?? null, bankChange: change, channel: (decided?.data as { channel?: string } | undefined)?.channel ?? null })
} else if (mode === 'session') {
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId, email: arg!.toLowerCase(), status: 'ACTIVE', portalEnabled: true }, select: { id: true, firstSignedInAt: true } })
  const now = new Date()
  await prisma.supplierContact.update({ where: { id: contact.id }, data: { privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION, ...(contact.firstSignedInAt ? {} : { firstSignedInAt: now }) } })
  const sid = randomUUID() + randomUUID()
  const csrf = randomUUID()
  await prisma.portalSession.create({ data: { organizationId, contactId: contact.id, sessionHash: sha(sid), csrfTokenHash: sha(csrf), lastSeenAt: now, expiresAt: new Date(now.getTime() + 3_600_000), userAgentHash: sha('e2e'), ipHash: sha('e2e') } })
  out({ sid, csrf })
} else if (mode === 'stuck') {
  const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId, email: arg!.toLowerCase(), applicationId: { not: null } }, select: { id: true, applicationId: true } })
  const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: contact.applicationId! }, select: { id: true, status: true, escalatedAt: true, remindedAt: true, invitedById: true } })
  const notices = await prisma.supplierNotice.findMany({ where: { organizationId, applicationId: app.id }, select: { templateKey: true, status: true } })
  const told = await prisma.notification.findMany({ where: { organizationId, subjectId: app.id }, select: { templateKey: true, recipientMemberId: true } })
  out({ applicationId: app.id, status: app.status, escalatedAt: app.escalatedAt, remindedAt: app.remindedAt, invitedBy: await codeOf(app.invitedById), notices, told: await Promise.all(told.map(async (n) => ({ templateKey: n.templateKey, to: await codeOf(n.recipientMemberId) }))) })
} else if (mode === 'history-po') {
  if (!/^H\d{2,3}$/.test(arg ?? '')) throw new Error(`history-po takes a ref of sheet Request_History, not ${arg}`)
  // every event of a step of the history carries the step's key as its requestId (src/server/services/demo-history)
  const draft = await prisma.event.findFirst({ where: { organizationId, aggregateType: 'Request', requestId: `demo-history:${arg}:draft` }, select: { aggregateId: true } })
  if (!draft) throw new Error(`the history made no request for ${arg}`)
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { organizationId, lines: { some: { sources: { some: { requestLine: { requestId: draft.aggregateId } } } } } }, select: { id: true, number: true, status: true, netSatang: true, vatSatang: true, grossSatang: true, supplierAckStatus: true, supplier: { select: { code: true } } } })
  out(po)
} else if (mode === 'told') {
  const told = await prisma.notification.findMany({ where: { organizationId, subjectId: arg!, templateKey: { in: ['po.acknowledged', 'po.delivery_changed'] } }, select: { templateKey: true, recipientMemberId: true, urgency: true } })
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: arg! }, select: { supplierAckStatus: true } })
  out({ status: po.supplierAckStatus, told: await Promise.all(told.map(async (n) => ({ templateKey: n.templateKey, to: await codeOf(n.recipientMemberId), urgency: n.urgency }))) })
} else if (mode === 'paid') {
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId, code: arg! }, select: { id: true } })
  const items = await prisma.paymentRunItem.findMany({ where: { organizationId, supplierId: supplier.id, status: 'PAID' }, orderBy: { createdAt: 'asc' }, select: { transferSatang: true, payeeAccountNo: true, run: { select: { number: true } } } })
  // the account's last four only: the full number never leaves this script
  out(items.map((i) => ({ run: i.run.number, transferSatang: i.transferSatang, last4: (i.payeeAccountNo ?? '').slice(-4) })))
} else {
  throw new Error(`unknown mode ${mode}`)
}
await prisma.$disconnect()

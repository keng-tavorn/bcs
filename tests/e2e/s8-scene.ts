import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { sweepSupplierNotices } from '@/server/notifications/supplier-notices'
import { etaxXml } from '../support/etax-files'
import { AP_NOW, apOrg, codedDraft, ok, receive, sentPo, submit } from '../support/ap'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/s8.spec.ts against the e2e database only (S8-13 · e2e @s8): a phase-1 organization of its own per
// run (createP1Org through tests/support/ap.ts: PAY AI BCS_GO on, a supplier, account codes), every member able to sign
// in — e-mail <code>.<tag>@s8.bcs.local, SEED_DEV_PASSWORD, TOTP from SEED_TOTP_KEY and "<code>.<tag>" as the seed
// derives it — and the data of one flow, made through the services:
//   inbox <tag>     a PO received in full and the supplier's e-Tax invoice e-mailed to the organization's inbox (Mailpit)
//   variance <tag>  a PO received and an invoice 10% over its price, submitted: EXCEPTION PRICE_OVER
//   reject <tag>    the same, for FINANCE to reject; the supplier's address is the run's own
//   notices         sends the supplier e-mails waiting (the job supplier-notice-send, which the e2e app does not run)
// Prints one JSON line. The demo organization (PAY off) is never touched.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the S8 scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')
const [mode, tag] = process.argv.slice(2)

async function signInReady(ap: Awaited<ReturnType<typeof apOrg>>, runTag: string) {
  for (const [code, memberId] of Object.entries(ap.org.member)) {
    const local = `${code}.${runTag}`
    const email = `${local}@s8.bcs.local`
    const userId = await upsertUserWithPassword({ email, name: `ผู้ใช้ ${code}`, password: password! })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, local), deriveSeedBackupCodes(totpKey!, local))
    await prisma.member.update({ where: { id: memberId }, data: { email, userId } })
  }
}

async function organization(runTag: string) {
  const ap = await apOrg()
  // CORE is on in every organization the seed makes (src/server/seed/demo-org.ts): the menus of the shell follow it
  await prisma.orgModule.create({ data: { organizationId: ap.org.organizationId, module: 'CORE', enabled: true, enabledAt: AP_NOW, contractRef: 'TEST-P1', reason: 'องค์กรทดสอบระยะ 1' } })
  await signInReady(ap, runTag)
  return ap
}

if (mode === 'notices') {
  console.log(JSON.stringify({ sent: await sweepSupplierNotices(new Date(Date.now() + 2 * 60_000)) }))
} else if (mode === 'inbox') {
  const ap = await organization(tag!)
  const inbox = `inbox-${tag}@s8.bcs.local`
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ap.org.organizationId }, select: { settings: true } })
  const settings = org.settings as Record<string, unknown>
  await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { settings: { ...settings, ap: { ...((settings.ap as object) ?? {}), inboxAddress: inbox } } } })
  const po = await sentPo(ap, [{ quantity: '10', unitPrice: '1000.00' }])
  await receive(ap, po, { 0: '10' })
  const invoiceNo = `S8IN-${tag!.toUpperCase()}`
  const today = new Date().toISOString().slice(0, 10)
  await nodemailer.createTransport({ host: 'localhost', port: 1025, secure: false }).sendMail({
    from: 'ap-supplier@test.bcs.local',
    to: inbox,
    subject: `ใบแจ้งหนี้ ${invoiceNo} ตาม ${po.number}`,
    text: 'ใบแจ้งหนี้ตามแนบ',
    messageId: `<${randomUUID()}@supplier.test>`,
    attachments: [{ filename: `${invoiceNo}.xml`, content: etaxXml({ invoiceNo, issueDate: `${today}T00:00:00`, net: '10000.00', vat: '700.00', gross: '10700.00' }), contentType: 'application/xml' }],
  })
  console.log(JSON.stringify({ tag, poNumber: po.number, invoiceNo }))
} else if (mode === 'variance' || mode === 'reject') {
  const ap = await organization(tag!)
  const supplierEmail = `supplier.${tag}@s8.bcs.local`
  await prisma.supplier.update({ where: { id: ap.supplierId }, data: { email: supplierEmail } })
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
  await receive(ap, po, { 0: '1' })
  const invoiceNo = `S8EX-${tag!.toUpperCase()}`
  const draft = await codedDraft(ap, po, { no: invoiceNo, date: AP_NOW.toISOString().slice(0, 10), vat: '77.00', lines: [{ line: 0, quantity: '1', unitPrice: '1100.00' }] })
  const submitted = ok(await submit(ap, draft))
  if (submitted.status !== 'EXCEPTION') throw new Error(`expected EXCEPTION, got ${submitted.status}`)
  console.log(JSON.stringify({ tag, poNumber: po.number, invoiceId: draft.invoiceId, number: submitted.number, invoiceNo, supplierEmail, approver: 'dm_con' }))
} else {
  throw new Error(`unknown mode ${mode}`)
}
await prisma.$disconnect()

import { randomUUID } from 'node:crypto'
import { nextRunDate } from '@/core/payment'
import { taxDateOf } from '@/core/vat'
import { getEnv } from '@/lib/env'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { seedDevPins } from '@/server/seed/pins'
import { sweepSupplierNotices } from '@/server/notifications/supplier-notices'
// the payment advice and the bank account notice are S9's templates: registered by importing their file
import '@/server/notifications/supplier-templates-pay'
import { seedLineChannel } from '@/server/services/line-channel'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { AP_NOW } from '../support/ap'
import { E2E_DB, E2E_PIN } from '../support/e2e-env'
import { payOrg, paySupplier, readyInvoice, sentRun } from '../support/pay'

// Run by tests/e2e/liff-pay.spec.ts against the e2e database only (S9-06 · e2e @pay): a phase-1 organization of its own
// per run (payOrg of tests/support/pay.ts: PAY on, SERVICE withheld, a payer account CB-01), its LINE channel from the
// LINE_* values of the run, the approvers' PIN of the e2e seed, the CFO linked to the LINE user given through a link
// code and the fake LINE server's ID token, and a payment run sent for approval through the services:
//   liff <lineCfo>         two suppliers, 128,400.00 baht of invoices with VAT (over the stepUpThreshold of 100,000.00),
//                          the first supplier's registry reported ceased after its invoice was ready and the preparer's
//                          reason given; the run pays on the next Friday from today (real time: the app decides it now)
//   decided <runId>        the run's status and how its task was decided (channel, step-up)
//   web <tag>              S9-09: every member able to sign in (e-mail <code>.<tag>@pay.bcs.local, TOTP of SEED_TOTP_KEY),
//                          the approvers' PIN, two suppliers with an invoice ready for payment (due 15 Oct 2026) and a
//                          third whose registry was reported ceased after its invoice was ready
//   payday <runId>         the bank paid today: the run's pay date set to today (Bangkok) so results can be recorded on
//                          any day the e2e runs (the run was approved for a later Friday)
//   notices                sends the supplier e-mails waiting (the job supplier-notice-send, which the e2e app does not run)
// Prints one JSON line. No other organization is touched.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the payment scene runs in the e2e database only')
const [mode, arg] = process.argv.slice(2)

async function linkLine(organizationId: string, memberId: string, lineUserId: string) {
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: new Date() })
  const issued = await issueLineLinkCode(ctx, new Date())
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code}`)
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }) })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code}`)
}

if (mode === 'liff') {
  if (!arg || !/^U[0-9a-f]{32}$/.test(arg)) throw new Error('liff <lineCfo>: a LINE user id')
  const ap = await payOrg()
  const tag = randomUUID().slice(0, 6).toUpperCase()
  // a code after DEMO's: the BCS team's list of organizations is by code, and other specs take the demo one first
  await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { code: `PAY-${tag}`, displayName: `ทดสอบรอบจ่าย ${tag}` } })
  await prisma.orgModule.create({ data: { organizationId: ap.org.organizationId, module: 'CORE', enabled: true, enabledAt: AP_NOW, contractRef: 'TEST-P1', reason: 'องค์กรทดสอบระยะ 1' } })
  await prisma.roleAssignment.create({ data: { organizationId: ap.org.organizationId, memberId: ap.org.member.admin!, role: 'ORG_ADMIN', grantedAt: AP_NOW } })
  const line = await seedLineChannel(ap.org.organizationId, getEnv(), AP_NOW)
  if (line.status !== 'CREATED') throw new Error(`the LINE channel was not saved: ${line.status}`)
  await seedDevPins(ap.org.organizationId, E2E_PIN, AP_NOW)
  // the CFO signs in (a LINE link is a member's with an account of their own)
  const password = process.env.SEED_DEV_PASSWORD
  if (!password) throw new Error('SEED_DEV_PASSWORD is needed')
  const email = `cfo.${tag.toLowerCase()}@pay.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ cfo', password })
  // an approver's role asks for the second factor before work starts (the seed's TOTP of SEED_TOTP_KEY)
  const totpKey = process.env.SEED_TOTP_KEY
  if (!totpKey) throw new Error('SEED_TOTP_KEY is needed')
  const local = `cfo.${tag.toLowerCase()}`
  await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, local), deriveSeedBackupCodes(totpKey, local))
  await prisma.member.update({ where: { id: ap.org.member.cfo! }, data: { email, userId } })
  await linkLine(ap.org.organizationId, ap.org.member.cfo!, arg)

  const flagged = await paySupplier(ap)
  const clean = await paySupplier(ap)
  const invoices = [await readyInvoice(ap, flagged.id, '60000.00', '4200.00', '2026-10-15'), await readyInvoice(ap, clean.id, '60000.00', '4200.00', '2026-10-15')]
  await prisma.supplier.update({ where: { id: flagged.id }, data: { registryFlag: 'CEASED' } })
  // the next Friday from today, as the app decides it now (the holidays of the fixture: 13 and 23 Oct 2026)
  const holidays = (await prisma.holiday.findMany({ where: { organizationId: ap.org.organizationId }, select: { date: true } })).map((h) => h.date.toISOString().slice(0, 10))
  const payDate = nextRunDate(taxDateOf(new Date()), { runWeekdays: ['FRI'], holidayShift: 'PREVIOUS' }, { workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], holidays })
  const sent = await sentRun(ap, invoices, { [flagged.id]: 'ส่งมอบงานครบก่อนเลิกกิจการ ตรวจกับจัดซื้อแล้ว' }, payDate)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PAYMENT_RUN', subjectId: sent.runId } } }, select: { id: true } })
  const run = await prisma.paymentRun.findUniqueOrThrow({ where: { id: sent.runId }, select: { totalTransferSatang: true } })
  console.log(JSON.stringify({ orgCode: `PAY-${tag}`, runId: sent.runId, taskId: task.id, number: sent.number, flagsKey: sent.flagsKey, flagged: flagged.code, clean: clean.code, transferSatang: run.totalTransferSatang.toString() }))
} else if (mode === 'web') {
  if (!arg || !/^[a-z0-9]+$/.test(arg)) throw new Error('web <tag>: a run tag')
  const ap = await payOrg()
  const code = `PAY-${arg.toUpperCase()}`
  await prisma.organization.update({ where: { id: ap.org.organizationId }, data: { code, displayName: `ทดสอบรอบจ่าย ${arg}` } })
  await prisma.orgModule.create({ data: { organizationId: ap.org.organizationId, module: 'CORE', enabled: true, enabledAt: AP_NOW, contractRef: 'TEST-P1', reason: 'องค์กรทดสอบระยะ 1' } })
  const password = process.env.SEED_DEV_PASSWORD
  const totpKey = process.env.SEED_TOTP_KEY
  if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')
  for (const [memberCode, memberId] of Object.entries(ap.org.member)) {
    const local = `${memberCode}.${arg}`
    const email = `${local}@pay.bcs.local`
    const userId = await upsertUserWithPassword({ email, name: `ผู้ใช้ ${memberCode}`, password })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, local), deriveSeedBackupCodes(totpKey, local))
    await prisma.member.update({ where: { id: memberId }, data: { email, userId } })
  }
  await seedDevPins(ap.org.organizationId, E2E_PIN, AP_NOW)
  const suppliers = [await paySupplier(ap), await paySupplier(ap), await paySupplier(ap)]
  const invoices = []
  for (const s of suppliers) invoices.push(await readyInvoice(ap, s.id, '30000.00', '2100.00', '2026-10-15'))
  await prisma.supplier.update({ where: { id: suppliers[2]!.id }, data: { registryFlag: 'CEASED' } })
  console.log(JSON.stringify({ orgCode: code, suppliers: suppliers.map((s) => ({ id: s.id, code: s.code, email: s.email, last4: s.accountNo!.slice(-4) })), invoiceIds: invoices }))
} else if (mode === 'payday') {
  const today = taxDateOf(new Date())
  await prisma.paymentRun.update({ where: { id: arg! }, data: { payDate: new Date(`${today}T00:00:00Z`) } })
  console.log(JSON.stringify({ payDate: today }))
} else if (mode === 'notices') {
  console.log(JSON.stringify({ sent: await sweepSupplierNotices(new Date(Date.now() + 2 * 60_000)) }))
} else if (mode === 'decided') {
  const run = await prisma.paymentRun.findUniqueOrThrow({ where: { id: arg! }, select: { status: true } })
  const decided = await prisma.event.findFirst({ where: { type: 'approval_task.decided', data: { path: ['subjectId'], equals: arg! } }, orderBy: { seq: 'desc' }, select: { data: true } })
  const data = (decided?.data ?? {}) as { channel?: string; stepUpGrantId?: string | null; decision?: string }
  console.log(JSON.stringify({ status: run.status, channel: data.channel ?? null, decision: data.decision ?? null, stepUp: Boolean(data.stepUpGrantId) }))
} else {
  throw new Error(`unknown mode ${mode}`)
}
await prisma.$disconnect()

import { randomUUID } from 'node:crypto'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { confirmInvoiceCoding, submitInvoice } from '@/server/services/ap'
import { updateAgentSetting } from '@/server/services/ai'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/admin-ai.spec.ts against the e2e database only (NEW-125 · ADR-083): a phase-1 organization of its own
// per run (PAY AI on, as tests/e2e/s8-scene.ts makes it), every member able to sign in — e-mail <code>.<tag>@s8.bcs.local
// as tests/e2e/s8-support.ts signs in — with admin as ORG_ADMIN and auditor as AUDITOR, and what /admin/ai reads:
//   notebook <tag>  two invoices of category SAFETY whose line FINANCE coded 530101 (the notebook's entry), an invoice
//                   10% over its PO's price (the amount found, OQ-41), a reading FINANCE took in after changing one of
//                   its three values with the checks warning, a question the member found helpful, and the Document
//                   Agent switched on by the admin (the history of the settings)
// Prints one JSON line. The demo organization is never touched.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the AI admin scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')
const [mode, tag] = process.argv.slice(2)
if (mode !== 'notebook' || !tag) throw new Error('usage: admin-ai-scene.ts notebook <tag>')

async function organization(runTag: string): Promise<ApOrg> {
  const ap = await apOrg()
  const { organizationId } = ap.org
  // A Z code like every scene: DEMO stays first among the customers, which admin.spec.ts and uat-config.spec.ts open
  await prisma.organization.update({ where: { id: organizationId }, data: { code: `ZE2E-AI-${runTag.toUpperCase()}` } })
  await prisma.orgModule.create({ data: { organizationId, module: 'CORE', enabled: true, enabledAt: AP_NOW, contractRef: 'TEST-P1', reason: 'องค์กรทดสอบระยะ 1' } })
  await prisma.roleAssignment.create({ data: { organizationId, memberId: ap.org.member.admin!, role: 'ORG_ADMIN', grantedAt: AP_NOW } })
  for (const [code, memberId] of Object.entries(ap.org.member)) {
    const local = `${code}.${runTag}`
    const email = `${local}@s8.bcs.local`
    const userId = await upsertUserWithPassword({ email, name: `ผู้ใช้ ${code}`, password: password! })
    await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey!, local), deriveSeedBackupCodes(totpKey!, local))
    await prisma.member.update({ where: { id: memberId }, data: { email, userId } })
  }
  return ap
}

/** An invoice of `category` ready for payment, its line coded `code` by FINANCE, ten days before the last */
let days = 0
async function readyInvoice(ap: ApOrg, category: string, code: string) {
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
  await prisma.poLine.updateMany({ where: { poId: po.id }, data: { categoryCode: category } })
  await receive(ap, po, { 0: '1' })
  const date = new Date(Date.UTC(2026, 9, 10 - 10 * ++days)).toISOString().slice(0, 10)
  const draft = await codedDraft(ap, po, { no: `AINB-${randomUUID().slice(0, 6)}`, date, vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
  const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } })
  const version = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
  ok(await confirmInvoiceCoding(fin(ap), { invoiceId: draft.invoiceId, version, lines: [{ invoiceLineId: line.id, accountCode: code, costCenterId: line.costCenterId! }] }, key()))
  const v = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
  const submitted = ok(await submit(ap, { invoiceId: draft.invoiceId, version: v }))
  if (submitted.status !== 'READY_FOR_PAYMENT') throw new Error(`expected READY_FOR_PAYMENT, got ${submitted.status}`)
}

const ap = await organization(tag)
const { organizationId } = ap.org
await readyInvoice(ap, 'SAFETY', '530101')
await readyInvoice(ap, 'SAFETY', '530101')
// The month of the page is the reader's (now): the calls are made now
const now = new Date()
await prisma.agentAction.create({
  data: {
    organizationId, agent: 'DOCUMENT', purpose: 'INVOICE_READ', level: 'L1', status: 'EDITED', channel: 'WEB', promptVersion: PROMPT_VERSIONS.INVOICE_READ, model: 'claude-opus-5-5',
    requestedById: ap.org.member.fin_officer!, inputRefs: { fileId: randomUUID() }, verification: { status: 'WARN', fail: [], warn: ['VAT_AMOUNT'], skip: [], flagged: ['statedVat'], computed: {} },
    review: { requiredPaths: [], confirmedPaths: ['invoiceDate'], proposed: { supplierInvoiceNo: 'IV-1', invoiceDate: '2026-10-09', statedVat: '70.00' } },
    diff: { statedVat: { ai: '70.00', final: '71.00' } }, decidedAt: now, decidedById: ap.org.member.fin_officer!, costCredits: 12, createdAt: now,
  },
})
await prisma.agentAction.create({
  data: {
    organizationId, agent: 'INSIGHT', purpose: 'QUESTION', level: 'L0', status: 'DRAFT', channel: 'WEB', promptVersion: PROMPT_VERSIONS.QUESTION, model: 'claude-haiku-5-5',
    requestedById: ap.org.member.req_con!, output: { tools: ['my_requests'], kind: 'ANSWER' }, feedback: 'HELPFUL', costCredits: 3, createdAt: new Date(now.getTime() + 1000),
  },
})
// An invoice 10% over its PO's price, raised now: the amount found of this month
const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
await receive(ap, po, { 0: '1' })
const over = await codedDraft(ap, po, { no: `AIEX-${tag.toUpperCase()}`, date: '2026-10-11', vat: '77.00', lines: [{ line: 0, quantity: '1', unitPrice: '1100.00' }] })
const raised = ok(await submitInvoice(ap.org.ctxOf('fin_officer', now), over, key()))
if (raised.status !== 'EXCEPTION') throw new Error(`expected EXCEPTION, got ${raised.status}`)
ok(await updateAgentSetting(ap.org.ctxOf('admin', now), { agent: 'DOCUMENT', enabled: true }, key()))
console.log(JSON.stringify({ tag, invoiceNumber: raised.number }))
await prisma.$disconnect()

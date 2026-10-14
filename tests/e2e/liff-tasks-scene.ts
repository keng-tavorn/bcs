import { randomBytes, randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { MS_PER_HOUR } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { seedBudget } from '@/server/seed/budget'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization, type DemoOrgInput } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { seedDevPins } from '@/server/seed/pins'
import { parseBudget, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { loadInputWorkbook } from '@/server/seed/workbook'
import { decideTask } from '@/server/services/approvals/decide'
import { submitDoaVersion } from '@/server/services/doa'
import { draftDoaCopy, getDoaEditor } from '@/server/services/doa/editor'
import { completeUpload, requestUpload } from '@/server/services/files'
import { seedLineChannel } from '@/server/services/line-channel'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDraft, submitRequest } from '../support/requests'
import { attachFile } from '@/server/services/requests/attachments'
import { E2E_DB, E2E_PIN } from '../support/e2e-env'
import { ATTACHMENT_NAME, ATTACHMENT_PDF } from './tasks-attachment'

// Run by tests/e2e/liff-tasks.spec.ts against the e2e database only (S5-06, the LIFF task pages). It builds, once per run,
// a twin of the demo organization — the same workbook and seed services as pnpm db:seed (departments, positions and
// their holders, DOA version 1 with its stepUpThreshold, request types and forms, the budget, suppliers and delivery
// sites, the LINE channel from the LINE_* values of the run, the e2e seed's PIN for the approvers) under a code of its own
// and with people of its own (employee codes lt<run>_<code>, e-mails lt<run>-<code>@e2e.bcs.local, the demo's names) —
// so the approvers this spec links to LINE, the requests, POs and receipts it makes, the PIN tries it spends and the DOA
// version it approves never touch a record another spec reads. Local e2e data only; the seed is the one place that may
// publish a DOA version and assign holders outside the customer's own 4-eyes flow (NG-12). Every step goes through the
// services, the approvers' decisions with their PIN step-up as the demo history makes them; the one exception is
// `overdue`, which moves a task's due time (test data: no service moves it, and no SLA job runs in e2e). Prints JSON on
// its last line.
//   twin <vp> <ceo> <coo> <dm> <vpSup> <idle>  the twin, its members linked to these LINE users through a link code and
//                                  the fake LINE server's ID token: the VP of the operations division (vp_ops), the CEO,
//                                  the COO, the DM of construction (dm_con), the VP of the support division (vp_sup), and
//                                  a member with no task (asst_con)
//   request <org> <gross> <title> [attach|plain] [con|it]
//                                  a purchase request of <gross> baht with VAT submitted by the requester of construction
//                                  (req_con, the construction capex line: PR-02 sends it to vp_ops) or of IT (req_it, the
//                                  IT opex line: to vp_sup); with a PDF attached when asked. <title> is a key of TITLES
//                                  (the Thai title stays off the command line)
//   overdue <org> <taskId>         the task was due two hours ago
//   po <org>                       an urgent request of 100,000.00 baht with VAT (net 93,457.94) with a PDF, approved by
//                                  vp_ops with the PIN, drafted into its own PO by procurement and sent for approval: a
//                                  task for the COO at the stepUpThreshold (PO-01)
//   variance <org>                 the same PO approved by the COO with the PIN and e-mailed to the supplier (Mailpit),
//                                  then received by the requester: both pumps damaged, kept once approved, with a photo —
//                                  a variance of 100,000.00 baht with VAT for dm_con at the stepUpThreshold (GRV-01)
//   doa <org>                      its admin saves version 2 (the DM band up to 30,000 baht) through the editor's service
//                                  and sends it with the drafter's tick: a task for the CEO with a boundary table
//   approve <org> <taskId>         the task's assignee approves it on the web, through the service (a task below the
//                                  stepUpThreshold: no PIN) — while its LIFF page is open on the phone
//   decided <org> <taskId>         the decision recorded for the task: its channel and whether it used a step-up
//   pin-reset <org> <code>         the member's wrong PINs forgotten (a test that failed half-way leaves none behind)
//   pin-off <org> <code>           the member has no PIN (FR-AUTH-005 AC1 sets one on the web)
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF tasks scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

const now = systemClock.now()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
/** The titles of the requests a test asks for, by key */
const TITLES: Readonly<Record<string, string>> = {
  drill: 'สว่านโรตารี่สำหรับไซต์งาน',
  cutter: 'เครื่องตัดคอนกรีต',
  pump: 'ปั๊มน้ำบาดาล',
  scaffold: 'นั่งร้านเหล็ก',
  generator: 'เครื่องปั่นไฟสำรอง',
  mixer: 'เครื่องผสมปูน',
  server: 'เครื่องแม่ข่ายสำรองข้อมูล',
}
/** The PO of `po` and `variance`: two pumps, 100,000.00 baht with 7% VAT (the stepUpThreshold of DOA version 1) */
const PUMPS = { description: 'ปั๊มสูบน้ำเสียแบบจุ่ม', quantity: '2', uom: 'เครื่อง', unitPrice: '46728.97' }
/** The start of a JPEG (the file service reads the first bytes): a photo the receiver took of the damaged pumps */
const PHOTO_NAME = 'damaged-pumps.jpg'
const PHOTO = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(512, 0x20), Buffer.from('ffd9', 'hex')])

/** A LINE user id as LINE makes them */
const LINE_USER = /^U[0-9a-f]{32}$/

function must<T>(label: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`${label} failed: ${JSON.stringify(r.error)}`)
  return r.data
}

/** The twin's member with this demo code (vp_ops, ceo, req_con, admin, …) */
async function memberOf(orgCode: string, code: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } })
  const member = await prisma.member.findFirst({ where: { organizationId: org.id, employeeCode: { endsWith: `_${code}` } }, select: { id: true, displayNameTh: true, employeeCode: true } })
  if (!member) throw new Error(`the twin ${orgCode} has no ${code}`)
  return { organizationId: org.id, ...member, ctx: makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now }) }
}

/** Links the member's account to the LINE user as the LIFF link page does: a link code spent with an ID token of the fake LINE server */
async function linkLine(orgCode: string, code: string, lineUserId: string) {
  if (!LINE_USER.test(lineUserId)) throw new Error('a LINE user id is U and 32 hexadecimal digits')
  const member = await memberOf(orgCode, code)
  const issued = await issueLineLinkCode(member.ctx, now)
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code}`)
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }),
  })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code} ${JSON.stringify(linked.error.details ?? {})}`)
}

async function twin(lines: readonly string[]) {
  const run = randomBytes(3).toString('hex')
  const prefix = `lt${run}`
  const workbook = await loadInputWorkbook()
  const demo = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const codeOf = (code: string) => `${prefix}_${code}`
  const input: DemoOrgInput = {
    org: { ...demo.org, code: `ZE2E-LT-${run.toUpperCase()}`, displayName: 'ทดสอบงานใน LINE', contractSignatory: codeOf(demo.org.contractSignatory), orgAdmins: demo.org.orgAdmins.map(codeOf) },
    settings: demo.settings,
    users: demo.users.map((u) => ({ ...u, code: codeOf(u.code), email: `${prefix}-${u.code}@e2e.bcs.local` })),
  }
  const report = await seedDemoOrganization(input, { password: password!, totpKey: totpKey!, now })
  const organizationId = report.organizationId
  await seedOrgStructure(organizationId, input.users, parseOrgStructureInput(workbook), now)
  await seedBudget(organizationId, parseBudget(workbook), now)
  await seedSuppliers(organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, now)
  const line = await seedLineChannel(organizationId, getEnv(), now)
  if (line.status !== 'CREATED') throw new Error(`the twin's LINE channel was not saved: ${line.status}`)
  await seedDevPins(organizationId, E2E_PIN, now)
  const linked = ['vp_ops', 'ceo', 'coo', 'dm_con', 'vp_sup', 'asst_con'] as const
  if (lines.length !== linked.length) throw new Error(`twin needs ${linked.length} LINE users`)
  for (const [i, code] of linked.entries()) await linkLine(input.org.code, code, lines[i]!)
  const name = (code: string) => input.users.find((u) => u.code === codeOf(code))!.displayNameTh
  return {
    orgCode: input.org.code,
    organizationName: input.org.displayName,
    approver: name('vp_ops'),
    ceo: name('ceo'),
    coo: name('coo'),
    dm: name('dm_con'),
    vpSup: name('vp_sup'),
    requester: name('req_con'),
    itRequester: name('req_it'),
  }
}

/** Uploads a file as the member through the presigned flow (FR-PLT-004): its id once the server read it back */
async function upload(ctx: Ctx, fileName: string, mimeType: string, bytes: Buffer): Promise<string> {
  const started = must('upload', await requestUpload(ctx, { fileName, mimeType, sizeBytes: bytes.length }))
  const put = await fetch(started.uploadUrl, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'Content-Type': mimeType } })
  if (!put.ok) throw new Error(`upload failed: ${put.status}`)
  return must('upload recorded', await completeUpload(ctx, { ticket: started.ticket })).fileId
}

/** The approver's PIN step-up for the document, as the decision page asks it (FR-AUTH-005 AC2), then the decision */
async function approveWithPin(member: Awaited<ReturnType<typeof memberOf>>, subjectType: 'REQUEST' | 'PURCHASE_ORDER', subjectId: string) {
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', assigneeMemberId: member.id, step: { route: { subjectType, subjectId } } }, select: { id: true } })
  const granted = await grantStepUp({ organizationId: member.organizationId, memberId: member.id, subjectType, subjectId, method: 'PIN', pin: E2E_PIN, channel: 'WEB' }, new Date(), { sender: null })
  if (!granted.ok) throw new Error(`the PIN step-up was refused: ${granted.reason}`)
  must('approve', await decideTask(member.ctx, { taskId: task.id, decision: 'APPROVE' }, key()))
}

const openTaskOf = (subjectType: 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE' | 'DOA_VERSION', subjectId: string) =>
  prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType, subjectId } } }, select: { id: true } })

async function request(orgCode: string, gross: string, titleKey: string, file: string | undefined, unit: string | undefined) {
  const title = TITLES[titleKey]
  if (!title) throw new Error(`unknown request title ${titleKey}`)
  const it = unit === 'it'
  const requester = await memberOf(orgCode, it ? 'req_it' : 'req_con')
  const line = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: requester.organizationId, code: it ? 'IT-OPEX-2569' : 'CON-CAPEX-2569' }, select: { id: true } })
  const draft = must(
    'draft',
    await createDraft(requester.ctx, { requestTypeCode: 'BUY_GOODS', title, priceIncludesVat: true, budgetLineId: line.id, lines: [{ description: title, quantity: '1', uom: 'ชุด', unitPrice: gross }] }, key()),
  )
  if (file === 'attach') {
    const fileId = await upload(requester.ctx, ATTACHMENT_NAME, 'application/pdf', ATTACHMENT_PDF)
    must('attach', await attachFile(requester.ctx, { requestId: draft.requestId, fileId, kind: 'JUSTIFICATION' }, key()))
  }
  const sent = must('submit', await submitRequest(requester.ctx, { requestId: draft.requestId }, key()))
  const task = await openTaskOf('REQUEST', draft.requestId)
  return { requestId: draft.requestId, number: sent.number, taskId: task.id, title, ...(file === 'attach' ? { fileName: ATTACHMENT_NAME } : {}) }
}

async function overdue(orgCode: string, taskId: string) {
  const { organizationId } = await memberOf(orgCode, 'admin')
  const dueAt = new Date(now.getTime() - 2 * MS_PER_HOUR)
  const moved = await prisma.approvalTask.updateMany({ where: { id: taskId, organizationId, status: 'OPEN' }, data: { dueAt } })
  if (moved.count !== 1) throw new Error('no open task of the twin to move')
  return { dueAt: dueAt.toISOString() }
}

/** An urgent request with its PDF, approved with the PIN, drafted into its own PO (BR-CONS-02) and sent for approval */
async function waitingPo(orgCode: string) {
  const [requester, vp, procurement] = await Promise.all([memberOf(orgCode, 'req_con'), memberOf(orgCode, 'vp_ops'), memberOf(orgCode, 'proc_officer')])
  const organizationId = requester.organizationId
  const [budgetLine, site, supplier] = await Promise.all([
    prisma.budgetLine.findFirstOrThrow({ where: { organizationId, code: 'CON-CAPEX-2569' }, select: { id: true } }),
    prisma.deliverySite.findFirstOrThrow({ where: { organizationId, code: 'SITE-A' }, select: { id: true } }),
    prisma.supplier.findFirstOrThrow({ where: { organizationId, code: 'S1' }, select: { id: true } }),
  ])
  const draft = must(
    'draft',
    await createDraft(requester.ctx, { requestTypeCode: 'BUY_GOODS', title: 'ปั๊มสูบน้ำเสียสำหรับบ่อพักไซต์ A', urgency: 'URGENT', budgetLineId: budgetLine.id, deliverySiteId: site.id, lines: [PUMPS] }, key()),
  )
  const fileId = await upload(requester.ctx, ATTACHMENT_NAME, 'application/pdf', ATTACHMENT_PDF)
  must('attach', await attachFile(requester.ctx, { requestId: draft.requestId, fileId, kind: 'JUSTIFICATION' }, key()))
  const sent = must('submit', await submitRequest(requester.ctx, { requestId: draft.requestId }, key()))
  await approveWithPin(vp, 'REQUEST', draft.requestId)
  const requestLines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId }, orderBy: { lineNo: 'asc' }, select: { id: true } })
  const assigned = must('assign supplier', await assignSupplier(procurement.ctx, { requestLineIds: requestLines.map((l) => l.id), supplierId: supplier.id }, key()))
  const poId = assigned.purchaseOrderIds[0]
  if (!poId) throw new Error('the urgent request made no draft PO')
  must('submit PO', await submitPo(procurement.ctx, { poId }, key()))
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { number: true } })
  return { poId, number: po.number, requestNumber: sent.number, fileName: ATTACHMENT_NAME, taskId: (await openTaskOf('PURCHASE_ORDER', poId)).id }
}

async function po(orgCode: string) {
  return waitingPo(orgCode)
}

/** The PO approved with the PIN and e-mailed, then received by the requester: both pumps damaged, kept once approved */
async function variance(orgCode: string) {
  const made = await waitingPo(orgCode)
  const [coo, procurement, requester] = await Promise.all([memberOf(orgCode, 'coo'), memberOf(orgCode, 'proc_officer'), memberOf(orgCode, 'req_con')])
  await approveWithPin(coo, 'PURCHASE_ORDER', made.poId)
  const mailed = must('send PO', await sendPurchaseOrder(procurement.ctx, { poId: made.poId }, key()))
  if (!mailed.sent) throw new Error(`the PO e-mail bounced: ${mailed.bounce}`)
  const poLine = await prisma.poLine.findFirstOrThrow({ where: { poId: made.poId }, select: { id: true } })
  const photo = await upload(requester.ctx, PHOTO_NAME, 'image/jpeg', PHOTO)
  const gr = must(
    'receive',
    await postGoodsReceipt(
      requester.ctx,
      {
        poId: made.poId,
        deliveryNoteNo: 'DN-6618',
        photoFileIds: [photo],
        lines: [{ poLineId: poLine.id, received: '2', rejected: '2', damagedDisposition: 'ACCEPT_DAMAGED', remark: 'ตัวเรือนบุบทั้งสองเครื่อง ผู้ขายลดราคาให้ ใช้งานได้' }],
      },
      key(),
    ),
  )
  const v = await prisma.variance.findFirstOrThrow({ where: { poId: made.poId, status: 'PENDING_APPROVAL' }, select: { id: true } })
  return { varianceId: v.id, poNumber: made.number, grNumber: gr.number, photoName: PHOTO_NAME, taskId: (await openTaskOf('VARIANCE', v.id)).id }
}

async function doa(orgCode: string) {
  const admin = await memberOf(orgCode, 'admin')
  const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: admin.organizationId, versionNo: 1 }, select: { id: true } })
  const view = must('editor', await getDoaEditor(admin.ctx, v1.id))
  const saved = must(
    'draft',
    await draftDoaCopy(
      admin.ctx,
      {
        sourceVersionId: v1.id,
        effectiveDate: view.defaultEffectiveDate,
        changeReason: 'ขยายวงเงินผู้จัดการฝ่ายเป็น 30,000 บาท',
        policy: { ...view.policy },
        rules: view.rules.map((r) => ({
          code: r.code,
          documentType: r.documentType,
          band: r.band && r.code === 'PR-01' ? { ...r.band, upper: '3000000' } : r.band && r.code === 'PR-02' ? { ...r.band, lower: '3000000' } : r.band,
          steps: r.steps.map((s) => ({ approver: s.approver, slaMinutes: s.slaMinutes })),
        })),
      },
      key(),
    ),
  )
  must('submit', await submitDoaVersion(admin.ctx, { versionId: saved.versionId, boundaryTableConfirmed: true }, key()))
  return { versionId: saved.versionId, versionNo: saved.versionNo, taskId: (await openTaskOf('DOA_VERSION', saved.versionId)).id }
}

/** The task's assignee approves it on the web (channel WEB), as if from another device */
async function approveOnWeb(orgCode: string, taskId: string) {
  const { organizationId } = await memberOf(orgCode, 'admin')
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { id: taskId, organizationId, status: 'OPEN' }, select: { assigneeMemberId: true } })
  if (!task.assigneeMemberId) throw new Error('the task has no assignee')
  const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: task.assigneeMemberId }, channel: 'WEB', now })
  must('approve', await decideTask(ctx, { taskId, decision: 'APPROVE' }, key()))
  return { approved: true }
}

async function decided(orgCode: string, taskId: string) {
  const { organizationId } = await memberOf(orgCode, 'admin')
  const event = await prisma.event.findFirst({ where: { organizationId, aggregateType: 'ApprovalTask', aggregateId: taskId, type: 'approval_task.decided' }, select: { channel: true, data: true } })
  const data = (event?.data ?? {}) as { decision?: unknown; stepUpGrantId?: unknown }
  return { channel: event?.channel ?? null, decision: data.decision ?? null, stepUp: typeof data.stepUpGrantId === 'string' }
}

async function pinReset(orgCode: string, code: string) {
  const member = await memberOf(orgCode, code)
  await prisma.member.update({ where: { id: member.id }, data: { pinFailedCount: 0, pinLockedUntil: null } })
  return { reset: true }
}

async function pinOff(orgCode: string, code: string) {
  const member = await memberOf(orgCode, code)
  await prisma.member.update({ where: { id: member.id }, data: { transactionPinHash: null, pinFailedCount: 0, pinLockedUntil: null } })
  return { off: true }
}

const [command, ...args] = process.argv.slice(2)
let result: unknown
switch (command) {
  case 'twin':
    result = await twin(args)
    break
  case 'request':
    result = await request(args[0]!, args[1]!, args[2]!, args[3], args[4])
    break
  case 'overdue':
    result = await overdue(args[0]!, args[1]!)
    break
  case 'po':
    result = await po(args[0]!)
    break
  case 'variance':
    result = await variance(args[0]!)
    break
  case 'doa':
    result = await doa(args[0]!)
    break
  case 'approve':
    result = await approveOnWeb(args[0]!, args[1]!)
    break
  case 'decided':
    result = await decided(args[0]!, args[1]!)
    break
  case 'pin-reset':
    result = await pinReset(args[0]!, args[1]!)
    break
  case 'pin-off':
    result = await pinOff(args[0]!, args[1]!)
    break
  default:
    throw new Error(`unknown LIFF tasks scene command ${command ?? '(none)'}`)
}
console.log(JSON.stringify(result))
await prisma.$disconnect()

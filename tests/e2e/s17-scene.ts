import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { intakeInputText } from '@/lib/ai-schemas/agents'
import { fixtureKey } from '@/integrations/ai'
import { chatIntakeAiRun } from '@/server/jobs/chat-intake-ai'
import { lineRichMenuRun } from '@/server/jobs/line-rich-menu'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { deliverNotification } from '@/server/notifications/deliver'
import { seedAccountCodes } from '@/server/seed/account-codes'
import { seedBudget } from '@/server/seed/budget'
import { seedCatalog } from '@/server/seed/catalog'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { seedP1Ai } from '@/server/seed/p1-ai'
import { seedP1Modules } from '@/server/seed/p1-modules'
import { seedDevPins } from '@/server/seed/pins'
import { parseBudget, parseCatalogItems, parseCostCenters, parseGlAccounts, parseHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { parseWorkflowReviewers, seedWorkflow } from '@/server/seed/workflow'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '@/server/seed/workbook'
import { dismissChatIntake } from '@/server/services/chat-intake'
import { fetchChatImage, pendingChatImages } from '@/server/services/chat-intake/images'
import { homeApprovals, homeFollowing, homeTodo } from '@/server/services/home'
import { budgetKeyLines, seedDemoHistory } from '@/server/services/demo-history'
import { seedLineChannel } from '@/server/services/line-channel'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { registerPushDevice } from '@/server/services/push-devices'
import { updateNotificationPrefs } from '@/server/services/self/notification-prefs'
import { runLineRichMenu } from '../../scripts/line-richmenu'
import { buildLineWebhook, lineEvents, lineMessageId, newReplyToken, postLineWebhook, signLineWebhook } from '../../scripts/line-simulate'
import { E2E_BASE_URL, E2E_DB, E2E_PIN } from '../support/e2e-env'

// Run by tests/e2e/s17.spec.ts (S17-16, e2e @s17) against the e2e database only: the scenes of docs/sub-specs/S17.md
// "Demo ของขั้น" with its people and figures. Their organization is a twin of the phase-1 one (SIMEC of
// docs/inputs/BCS_inputs_p1.xlsx) under code S17-SIMEC, built once per e2e database by the seed's own functions as
// pnpm db:reset:p1 builds SIMEC — its structure and holders, DOA-P1 and the parallel reviewers of S6, PAY AI BCS_GO on with
// the agents and credits, the budget, suppliers, sites, catalogue, the LINE channel of the run, the e2e PIN — e-mails
// s17.<e-mail of the sheet>, the same employee codes (TOTP from SEED_TOTP_KEY as the seed derives it), and of sheet
// Request_History only the rows the scenes use: H229 (pm_p07's asphalt road, 9,500 m² at 260.00, 2,642,900.00 with VAT,
// past the three reviewers and waiting for the CEO), H042 (store_p07's ready-mix concrete, 2 m³ at 2,780.00, its PO sent
// to the supplier) and H237 (store_p06's black steel sheets, 13,950.00 before VAT, waiting for dm_coni). Local e2e data only; the seed is the one place that may publish a DOA version (NG-12).
// Every step goes through the services. Prints JSON on its last line.
//   twin                       the twin (made once; again it only reads it): its code, the scene's people and documents
//   push-device <code>         what "รับแจ้งเตือนในแอป" of /settings/notifications does in BCS Go once FCM gave the phone's
//                              token: the device registered and push turned on (channel APP) — a browser has no FCM, so
//                              the native half is tried on a phone (docs/runbooks/bcs-go-demo.md)
//   deliver <code> <requestId> plays job notification-deliver for the member's task notices of the request (e2e has no
//                              Inngest): PUSH_PROVIDER=fake sends them to the fake FCM of the run
//   decided <taskId>           how the task was decided: its decision, the decision's channel and the step-up's method
//   po <poId>                  the PO's status and its receipts (each with its channel and whether it was captured offline)
//   menus                      the rich menus of every set for the twin's channel, made once (pnpm line:richmenu's command):
//                              the sets by their key and the menu LINE holds for each
//   link <code> <lineUserId>   the member linked to this LINE user (a link code spent with the fake LINE server's ID token),
//                              or to the one an earlier scene of the run linked: prints the LINE user
//   menu-job <code>            plays job line-rich-menu for the member's latest role grant (e2e has no Inngest)
//   home <code>                what the web home's services give the member now: the numbers /liff/home must show
//   chat <lineUserId>          se_p01a writes the request in the chat and sends the quotation's photo (DOC-031: steel
//                              DB25 SD40, 1 t, 24,411.00 + VAT 1,708.77 = 26,119.77), signed webhooks as LINE sends them;
//                              prints the chat draft and the answers the account gave (the fake LINE server's replies)
//   chat-jobs <intakeId>       plays the photo's fetch (job chat-intake-image) and the Intake Agent's reading (job
//                              chat-intake-ai, AI_MODE=fixture: tests/fixtures/ai/INTAKE, recorded E2E for this scene)
//   ai-key                     the name of the recorded answer the reading of scene 3 looks for, as the fixture client
//                              names it (tests/fixtures/ai/INTAKE/<sha256>.json): the twin's types and sites as the agent
//                              lists them, the chat's words and the photo — a change of the phase-1 sheets renames it
//   ai <on|off>                the twin's AI module (EG-1: without AI the chat and LIFF work on as before)
//   request <requestId>        the request's status, total and the approver its open task waits for
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the S17 scene runs in the e2e database only')
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed')

export const S17_ORG = 'S17-SIMEC'
/** The e-mail of a member of the twin: s17.<the sheet's e-mail> */
export const s17Email = (email: string) => `s17.${email}`
/** What se_p01a types in the chat (scene 3) */
export const CHAT_TEXT = 'ขอซื้อเหล็กข้ออ้อย DB25 1 ตัน ส่งไซต์พระราม 9'
/** The quotation's photo of scene 3 (tests/fixtures/ai-docs/manifest.json) */
const DOC_031 = 'tests/fixtures/ai-docs/DOC-031.jpg'
const LINE_USER = /^U[0-9a-f]{32}$/
/** The rows of sheet Request_History the scenes use */
const SCENE_ROWS = ['H042', 'H229', 'H237']

const now = systemClock.now()
const [mode = '', first = '', second = ''] = process.argv.slice(2)

function must<T>(label: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`${label} failed: ${JSON.stringify(r.error)}`)
  return r.data
}

async function organizationId(): Promise<string> {
  const org = await prisma.organization.findUnique({ where: { code: S17_ORG }, select: { id: true } })
  if (!org) throw new Error(`run twin first: no ${S17_ORG}`)
  return org.id
}

async function memberOf(code: string) {
  const orgId = await organizationId()
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: orgId, employeeCode: code }, select: { id: true, displayNameTh: true, email: true } })
  return { organizationId: orgId, ...member, ctx: (channel: 'WEB' | 'APP') => makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: member.id }, channel, now }) }
}

async function requestByTitle(orgId: string, prefix: string) {
  return prisma.request.findFirstOrThrow({ where: { organizationId: orgId, title: { startsWith: prefix } }, select: { id: true, number: true, title: true } })
}

async function twin() {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const sheet = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const input = {
    ...sheet,
    org: { ...sheet.org, code: S17_ORG, displayName: 'SIMEC ฉาก S17' },
    users: sheet.users.map((u) => ({ ...u, email: s17Email(u.email) })),
  }
  await seedTaxRates()
  const report = await seedDemoOrganization(input, { password: password!, totpKey: totpKey!, now })
  const orgId = report.organizationId
  if (report.organizationCreated) {
    await seedOrgStructure(orgId, input.users, parseOrgStructureInput(workbook), now)
    await seedP1Modules(orgId, now)
    const workflow = parseWorkflowReviewers(workbook, S17_ORG)
    if (workflow) await seedWorkflow(orgId, workflow, now)
    await seedP1Ai(orgId, now)
    const budget = parseBudget(workbook)
    await seedBudget(orgId, budget, now, parseCostCenters(workbook))
    await seedSuppliers(orgId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, now)
    await seedAccountCodes(orgId, parseGlAccounts(workbook))
    await seedCatalog(orgId, parseCatalogItems(workbook), now)
    const line = await seedLineChannel(orgId, getEnv(), now)
    if (line.status !== 'CREATED') throw new Error(`the twin's LINE channel was not saved: ${line.status}`)
    await seedDevPins(orgId, E2E_PIN, now)
    const rows = parseHistory(workbook).filter((r) => SCENE_ROWS.includes(r.ref))
    if (rows.length !== SCENE_ROWS.length) throw new Error(`sheet Request_History lacks one of ${SCENE_ROWS.join(' ')}`)
    await seedDemoHistory(orgId, rows, now, { pin: E2E_PIN, budgetKeys: budgetKeyLines(budget) })
  }
  const road = await requestByTitle(orgId, 'งานถนนแอสฟัลต์')
  const concrete = await requestByTitle(orgId, 'คอนกรีตผสมเสร็จ 400')
  const ceo = await memberOf('ceo')
  const task = await prisma.approvalTask.findFirst({ where: { organizationId: orgId, status: 'OPEN', assigneeMemberId: ceo.id, step: { route: { subjectType: 'REQUEST', subjectId: road.id } } }, select: { id: true } })
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { organizationId: orgId, lines: { some: { sources: { some: { requestLine: { requestId: concrete.id } } } } } }, select: { id: true, number: true, status: true } })
  const names = Object.fromEntries(
    await Promise.all(['ceo', 'pm_p07', 'store_p07', 'se_p01a', 'vp_ops'].map(async (code) => [code, (await memberOf(code)).displayNameTh] as const)),
  )
  return { orgCode: S17_ORG, created: report.organizationCreated, names, road: { ...road, ceoTaskId: task?.id ?? null }, concrete: { ...concrete, poId: po.id, poNumber: po.number, poStatus: po.status } }
}

async function pushDevice(code: string) {
  const member = await memberOf(code)
  const token = `s17-${randomUUID().replaceAll('-', '')}:APA91b${randomUUID().replaceAll('-', '')}`
  const registered = must('push_device.register', await registerPushDevice(member.ctx('APP'), { token, platform: 'ANDROID', appVersion: '0.1.0', deviceLabel: 'โทรศัพท์ฉาก S17' }, { idempotencyKey: randomUUID(), sender: null }))
  const turnedOn = await updateNotificationPrefs(member.ctx('APP'), { appPush: true }, { idempotencyKey: randomUUID(), sender: null })
  if (!turnedOn.ok && turnedOn.error.details?.reason !== 'NO_CHANGE') throw new Error(`push was not turned on: ${turnedOn.error.code}`)
  return { deviceId: registered.deviceId, token }
}

async function deliver(code: string, requestId: string) {
  const member = await memberOf(code)
  const tasks = await prisma.approvalTask.findMany({ where: { organizationId: member.organizationId, assigneeMemberId: member.id, step: { route: { subjectType: 'REQUEST', subjectId: requestId } } }, select: { id: true } })
  const notices = await prisma.notification.findMany({
    where: { organizationId: member.organizationId, recipientMemberId: member.id, templateKey: 'task.assigned', status: 'PENDING' },
    select: { id: true, data: true },
  })
  const mine = notices.filter((n) => tasks.some((t) => (n.data as { taskId?: unknown }).taskId === t.id))
  if (mine.length === 0) throw new Error(`${code} has no task notice of the request waiting`)
  const outcomes = []
  for (const n of mine) outcomes.push(await deliverNotification(member.organizationId, n.id, systemClock.now()))
  return { outcomes }
}

async function decided(taskId: string) {
  const orgId = await organizationId()
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { organizationId: orgId, id: taskId }, select: { status: true, decision: true, channel: true, assigneeMemberId: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } } })
  // The grant the decision used: the assignee's, for the task's document
  const grant = await prisma.stepUpGrant.findFirst({
    where: { organizationId: orgId, memberId: task.assigneeMemberId, subjectType: task.step.route.subjectType, subjectId: task.step.route.subjectId, usedAt: { not: null } },
    select: { method: true },
    orderBy: { usedAt: 'desc' },
  })
  return { status: task.status, decision: task.decision, channel: task.channel, stepUp: grant?.method ?? null }
}

async function po(poId: string) {
  const orgId = await organizationId()
  const order = await prisma.purchaseOrder.findFirstOrThrow({ where: { organizationId: orgId, id: poId }, select: { status: true } })
  const receipts = await prisma.goodsReceipt.findMany({ where: { organizationId: orgId, poId }, select: { id: true, number: true, status: true, offlineCapturedAt: true, lines: { select: { receivedQuantity: true } } }, orderBy: { createdAt: 'asc' } })
  const out = []
  for (const gr of receipts) {
    const photos = await prisma.fileLink.count({ where: { organizationId: orgId, subjectType: 'GoodsReceipt', subjectId: gr.id, kind: 'PHOTO' } })
    const posted = await prisma.event.findFirst({ where: { organizationId: orgId, aggregateId: gr.id, type: 'gr.posted' }, select: { channel: true } })
    out.push({ number: gr.number, status: gr.status, offline: gr.offlineCapturedAt !== null, quantities: gr.lines.map((l) => l.receivedQuantity.toFixed(2)), photos, channel: posted?.channel ?? null })
  }
  return { status: order.status, receipts: out }
}

async function menus() {
  const orgId = await organizationId()
  if ((await prisma.lineRichMenuVariant.count({ where: { organizationId: orgId } })) === 0) {
    const run = await runLineRichMenu({ org: S17_ORG })
    if (!run.ok) throw new Error(`the rich menus were not made: ${run.problem}`)
  }
  const sets = await prisma.lineRichMenuVariant.findMany({ where: { organizationId: orgId }, select: { variantKey: true, richMenuId: true } })
  return { sets: Object.fromEntries(sets.map((v) => [v.variantKey, v.richMenuId])) }
}

async function menuJob(code: string) {
  const member = await memberOf(code)
  const granted = await prisma.event.findFirstOrThrow({ where: { organizationId: member.organizationId, type: 'member.role_granted', aggregateId: member.id }, select: { aggregateId: true }, orderBy: { occurredAt: 'desc' } })
  return { outcome: await lineRichMenuRun({ data: { organizationId: member.organizationId, aggregateId: granted.aggregateId, type: 'member.role_granted' } }, { run: (_id, fn) => fn() }) }
}

async function home(code: string) {
  const member = await memberOf(code)
  const ctx = makeCtx({ organizationId: member.organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: systemClock.now() })
  const [todo, approvals, following] = await Promise.all([homeTodo(ctx), homeApprovals(ctx), homeFollowing(ctx)])
  if (!todo.ok || !approvals.ok || !following.ok) throw new Error('the home services refused')
  return {
    todo: todo.data.rows.map((r) => ({ key: r.key, count: r.count })),
    approvals: { all: approvals.data.all.count, overdue: approvals.data.overdue.count, info: approvals.data.info.count, taskIds: approvals.data.all.rows.map((t) => t.id) },
    following: { total: following.data.total, open: following.data.open },
  }
}

async function link(code: string, lineUserId: string) {
  if (!LINE_USER.test(lineUserId)) throw new Error('a LINE user id is U and 32 hexadecimal digits')
  const member = await memberOf(code)
  // Linked by an earlier scene of the run: the same LINE user
  const linked = await prisma.channelIdentity.findFirst({ where: { organizationId: member.organizationId, memberId: member.id, channel: 'LINE', unlinkedAt: null }, select: { externalUserId: true } })
  if (linked) return { lineUserId: linked.externalUserId }
  const issued = must('line link code', await issueLineLinkCode(member.ctx('WEB'), now))
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }) })
  const { idToken } = (await answer.json()) as { idToken: string }
  must('line link', await linkLineAccount({ code: issued.code, idToken }, { sender: null, requestId: randomUUID() }))
  return { lineUserId }
}

/** One webhook as LINE sends it, signed with the channel secret of the run, to the twin's channel */
async function send(event: ReturnType<typeof lineEvents.message>) {
  const orgId = await organizationId()
  const channel = await prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId: orgId }, select: { channelKey: true } })
  const { body } = buildLineWebhook([event])
  const answer = await postLineWebhook(`${E2E_BASE_URL}/api/webhooks/line/${channel.channelKey}`, body, signLineWebhook(process.env.LINE_MESSAGING_CHANNEL_SECRET!, body))
  if (answer.status !== 200) throw new Error(`the webhook answered ${answer.status}`)
}

async function chat(lineUserId: string) {
  const member = await memberOf('se_p01a')
  // A draft an earlier scene of the run left open (it stopped half way) is closed as its owner would ("ไม่ใช่คำขอ"),
  // so this chat opens a draft of its own
  for (const open of await prisma.chatIntake.findMany({ where: { organizationId: member.organizationId, memberId: member.id, status: 'OPEN' }, select: { id: true } })) {
    must('chat_intake.dismiss', await dismissChatIntake(member.ctx('WEB'), { intakeId: open.id }, { idempotencyKey: randomUUID(), sender: null }))
  }
  const tokens = [newReplyToken(), newReplyToken()]
  await send(lineEvents.message({ userId: lineUserId, text: CHAT_TEXT, replyToken: tokens[0]! }))
  const messageId = lineMessageId()
  const photo = await readFile(DOC_031)
  const put = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/content`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId, contentType: 'image/jpeg', base64: photo.toString('base64') }) })
  if (!put.ok) throw new Error(`the fake LINE server did not keep the photo: ${put.status}`)
  await send(lineEvents.image({ userId: lineUserId, messageId, replyToken: tokens[1]! }))
  const intake = await prisma.chatIntake.findFirstOrThrow({ where: { organizationId: member.organizationId, memberId: member.id, status: 'OPEN' }, select: { id: true, messageCount: true, imageCount: true }, orderBy: { openedAt: 'desc' } })
  const sent = (await (await fetch(`${process.env.LINE_API_BASE_URL}/__fake/messages`)).json()) as { messages: Array<{ kind: string; replyToken: string | null; messages: unknown[] }> }
  const replies = tokens.map((token) => sent.messages.find((m) => m.kind === 'reply' && m.replyToken === token)?.messages ?? [])
  return { intakeId: intake.id, messageCount: intake.messageCount, imageCount: intake.imageCount, replies }
}

async function chatJobs(intakeId: string) {
  const orgId = await organizationId()
  const images = []
  for (const itemId of await pendingChatImages(orgId, intakeId)) images.push((await fetchChatImage(orgId, itemId, systemClock.now())).status)
  const ai = await chatIntakeAiRun({ data: { organizationId: orgId, aggregateId: intakeId } }, { run: (_id, fn) => fn() })
  const action = await prisma.chatIntake.findFirstOrThrow({ where: { organizationId: orgId, id: intakeId }, select: { agentAction: { select: { status: true, errorCode: true } } } })
  return { images, ai, action: action.agentAction }
}

/** What the Intake Agent is given for scene 3's chat, as runIntake builds it (src/server/services/ai/agents/intake.ts) */
async function aiKey() {
  const db = forTenant(await organizationId())
  const types = await db.requestType.findMany({ where: { active: true, currentFormVersion: { status: 'PUBLISHED' } }, select: { code: true, nameTh: true, descriptionTh: true }, orderBy: { code: 'asc' } })
  const sites = await db.deliverySite.findMany({ where: { active: true }, select: { code: true, nameTh: true }, orderBy: { code: 'asc' } })
  const text = intakeInputText({ message: CHAT_TEXT, requestTypes: types.map((t) => ({ code: t.code, name: t.nameTh, description: t.descriptionTh })), items: [], sites: sites.map((s) => ({ code: s.code, name: s.nameTh })) })
  return { key: fixtureKey({ purpose: 'INTAKE', text, files: [{ bytes: new Uint8Array(await readFile(DOC_031)), mediaType: 'image/jpeg' }] }) }
}

async function ai(state: string) {
  if (state !== 'on' && state !== 'off') throw new Error('ai on|off')
  const orgId = await organizationId()
  const moved = await prisma.orgModule.updateMany({ where: { organizationId: orgId, module: 'AI' }, data: { enabled: state === 'on' } })
  if (moved.count !== 1) throw new Error('the twin has no AI module row')
  return { ai: state }
}

async function request(requestId: string) {
  const orgId = await organizationId()
  const r = await prisma.request.findFirstOrThrow({ where: { organizationId: orgId, id: requestId }, select: { number: true, status: true, grossSatang: true, requestType: { select: { code: true } } } })
  const task = await prisma.approvalTask.findFirst({ where: { organizationId: orgId, status: 'OPEN', step: { kind: 'APPROVAL', route: { subjectType: 'REQUEST', subjectId: requestId } } }, select: { assignee: { select: { employeeCode: true } } } })
  return { number: r.number, status: r.status, type: r.requestType.code, gross: String(r.grossSatang), approver: task?.assignee.employeeCode ?? null }
}

const MODES: Readonly<Record<string, () => Promise<unknown>>> = {
  twin: () => twin(),
  menus: () => menus(),
  link: () => link(first, second),
  'menu-job': () => menuJob(first),
  home: () => home(first),
  'push-device': () => pushDevice(first),
  deliver: () => deliver(first, second),
  decided: () => decided(first),
  po: () => po(first),
  chat: () => chat(first),
  'chat-jobs': () => chatJobs(first),
  'ai-key': () => aiKey(),
  ai: () => ai(first),
  request: () => request(first),
}
const run = Object.hasOwn(MODES, mode) ? MODES[mode] : undefined
if (!run) throw new Error(`unknown mode ${mode}`)
console.log(JSON.stringify(await run()))
await prisma.$disconnect()

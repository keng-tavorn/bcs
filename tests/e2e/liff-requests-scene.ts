import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { cancelRequest, createDraft, submitRequest } from '../support/requests'
import { E2E_DB } from '../support/e2e-env'
import { lineWithRoom } from './budget-room'

// Run by tests/e2e/liff-requests.spec.ts (through liffRequestsScene) against the e2e database only: builds what a test
// of the LIFF request pages needs through the services, as the workspace and LINE would, and prints it as JSON on the
// last line.
//   requester <tag> <lineUserId> <CON|IT> [history]
//        a fresh requester of that department, linked to that LINE account (a link code issued and spent with an ID token
//        of the fake LINE server, as /liff/link does). With "history": a request of theirs sent and cancelled — of CON a
//        purchase (BUY_GOODS) on CON-OPEX-2569 to SITE-A, of IT an IT purchase (IT_PURCHASE) on IT-OPEX-2569 — so the form
//        of that type fills that budget line (and site) as BR-FORM-02 says, whatever lines other specs of the run add to
//        the department (scene 1: req_con's form; scene 4: req_it's)
//   approved <tag> <lineUserId>
//        a fresh CON requester linked to that LINE account, with a request of 42,000.00 baht before VAT sent from LIFF
//        and approved by its approver in the LINE chat (scenes 1 and 2), for the request page and the list
//   asked <tag> <lineUserId>
//        the same request, whose approver asked a question from the LIFF decision page (it waits for the requester's answer)
//   returned <tag> <lineUserId>
//        the same request, which its approver returned for changes from the LIFF decision page, with a reason
//   states <tag> <lineUserId>
//        one fresh CON requester linked to that LINE account with a request in each state their LINE messages open: approved
//        in the chat, asked a question, returned, and a draft (smaller amounts: the page's weight is the point)
//   approve-in-chat <requestId>
//        the open task's assignee approves on the LINE_CHAT channel, through the same command the card's postback runs
//   channels <requestId>
//        the channels of the request's request.drafted, request.submitted and request.resubmitted Events
//   drafts <tag>
//        the drafts of the scene member with that tag: id, title and the channels of their request.drafted Events
// Requests whose amount is not the point take a CON budget line that has room left for them (CON-CAPEX-2569 first), so
// this spec does not use up the line the demo's scenes and other specs count on (CON-OPEX-2569); when no line has room,
// a budget admin tops one up through the budget import, never by writing a balance (tests/e2e/budget-room.ts). A fresh
// member (employee code e2e-liffreq-<tag>, a plain requester of the demo organization no other test touches) keeps each
// test apart from the rest of the run; nothing here signs anyone in. Link codes are short-lived secrets of this test
// database only, and are never printed.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the LIFF requests scene runs in the e2e database only')

const [command, ...args] = process.argv.slice(2)
const password = process.env.SEED_DEV_PASSWORD
if (!password) throw new Error('SEED_DEV_PASSWORD is needed')

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true, displayName: true, legalNameTh: true } })
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ctxOf = (memberId: string, channel: Ctx['channel']) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel, now: systemClock.now() })

function tagOf(value: string | undefined): string {
  if (!value || !/^[a-z0-9-]{3,40}$/.test(value)) throw new Error('the scene needs a tag of lower-case letters, digits and -')
  return value
}

function lineUserOf(value: string | undefined): string {
  if (!value || !/^U[0-9a-f]{32}$/.test(value)) throw new Error('the scene needs a LINE user id (U and 32 hexadecimal digits)')
  return value
}

function requestIdOf(value: string | undefined): string {
  if (!value || !/^[0-9a-f-]{36}$/.test(value)) throw new Error('the scene needs a request id')
  return value
}

const employeeCodeOf = (tag: string) => `e2e-liffreq-${tag}`

async function freshMember(tag: string, departmentCode: 'CON' | 'IT') {
  const employeeCode = employeeCodeOf(tag)
  const email = `${employeeCode}@demo.bcs.local`
  const nameTh = `ทดสอบ ขอซื้อ ${tag}`
  const nameEn = `LIFF Requester ${tag}`
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: departmentCode }, select: { id: true, nameTh: true } })
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  const member = await prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: nameTh, displayNameEn: nameEn, employeeCode, status: 'ACTIVE', primaryDepartmentId: department.id },
    update: {},
    select: { id: true },
  })
  return { id: member.id, email, employeeCode, nameTh, nameEn, departmentName: department.nameTh, organizationName: org.displayName ?? org.legalNameTh }
}

/** Links the member to the LINE account as the LIFF link page does: a code issued on the web, spent with an ID token */
async function link(memberId: string, lineUserId: string): Promise<void> {
  const issued = await issueLineLinkCode(ctxOf(memberId, 'WEB'), systemClock.now())
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code}`)
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }),
  })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code}`)
}

/**
 * A CON budget line with at least `netSatang` left: CON-CAPEX-2569 when it has room, else CON-OPEX-2569; when neither
 * has, a budget admin tops CON-CAPEX-2569 up through the budget import (tests/e2e/budget-room.ts)
 */
const conLineWithRoom = (netSatang: bigint) => lineWithRoom(['CON-CAPEX-2569', 'CON-OPEX-2569'], netSatang)

async function site(code: string) {
  return prisma.deliverySite.findFirstOrThrow({ where: { organizationId: org.id, code }, select: { id: true, code: true } })
}

type Line = { description: string; quantity: string; uom: string; unitPrice: string }

/** Plywood and nails, 42,000.00 baht before VAT (scene 1 of the Demo_Script sheet) */
const SCENE_LINES: readonly Line[] = [
  { description: 'ไม้อัด 10 มม.', quantity: '20', uom: 'แผ่น', unitPrice: '1500.00' },
  { description: 'ตะปู 2 นิ้ว', quantity: '100', uom: 'กล่อง', unitPrice: '120.00' },
]
/** 21,000.00 baht before VAT: still above PR-01's limit, so the VP of the line approves (PR-02) */
const SMALL_LINES: readonly Line[] = [{ description: 'ไม้อัด 10 มม.', quantity: '14', uom: 'แผ่น', unitPrice: '1500.00' }]

const netOf = (lines: readonly Line[]) => lines.reduce((sum, l) => sum + BigInt(l.quantity) * BigInt(l.unitPrice.replace('.', '')), 0n)

/** A draft of the member's, made from LIFF on a CON line with room for it; returns its id */
async function drafted(memberId: string, title: string, lines: readonly Line[]) {
  const [line, place] = await Promise.all([conLineWithRoom(netOf(lines)), site('SITE-A')])
  const draft = await createDraft(ctxOf(memberId, 'LIFF'), { requestTypeCode: 'BUY_GOODS', priceIncludesVat: false, title, budgetLineId: line.id, deliverySiteId: place.id, lines: lines.map((l) => ({ ...l })) }, key())
  if (!draft.ok) throw new Error(`draft failed: ${draft.error.code} ${JSON.stringify(draft.error.details ?? {})}`)
  return draft.data.requestId
}

/** A request the member drafts and sends from LIFF; returns its id and number */
async function sent(memberId: string, title: string, lines: readonly Line[]) {
  const requestId = await drafted(memberId, title, lines)
  const submitted = await submitRequest(ctxOf(memberId, 'LIFF'), { requestId }, key())
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.error.code} ${JSON.stringify(submitted.error.details ?? {})}`)
  return { requestId, number: submitted.data.number }
}

async function openTask(requestId: string) {
  return prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: requestId } } }, select: { id: true, assigneeMemberId: true } })
}

/** The open approval task's assignee approves it in the LINE chat (the card's postback runs this command on LINE_CHAT) */
async function approveInChat(requestId: string) {
  const task = await openTask(requestId)
  const decided = await decideTask(ctxOf(task.assigneeMemberId, 'LINE_CHAT'), { taskId: task.id, decision: 'APPROVE' }, key())
  if (!decided.ok) throw new Error(`approval failed: ${decided.error.code} ${JSON.stringify(decided.error.details ?? {})}`)
}

/** The approver asks the requester a question from the LIFF decision page */
async function ask(requestId: string) {
  const task = await openTask(requestId)
  const asked = await requestInfo(ctxOf(task.assigneeMemberId, 'LIFF'), { taskId: task.id, question: 'ขอใบเสนอราคาไม้อัดจากผู้ขายอีกราย' }, key())
  if (!asked.ok) throw new Error(`question failed: ${asked.error.code}`)
}

/** The approver returns the request for changes from the LIFF decision page, with a reason */
async function giveBack(requestId: string) {
  const task = await openTask(requestId)
  const returned = await decideTask(ctxOf(task.assigneeMemberId, 'LIFF'), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการไม้อัดตามความหนาก่อนส่งอีกครั้ง' }, key())
  if (!returned.ok) throw new Error(`return failed: ${returned.error.code} ${JSON.stringify(returned.error.details ?? {})}`)
}

/** The one line of a history request, 100.00 before VAT, and its budget line */
const HISTORY = {
  CON: { budgetLine: 'CON-OPEX-2569', line: { description: 'ถุงมือผ้า', quantity: '1', uom: 'โหล', unitPrice: '100.00' } },
  IT: { budgetLine: 'IT-OPEX-2569', line: { description: 'เมาส์ไร้สาย', quantity: '1', uom: 'ชิ้น', unitPrice: '100.00' } },
} as const satisfies Record<'CON' | 'IT', { budgetLine: string; line: Line }>

/**
 * A request of the member's sent and cancelled at once: it leaves no task with anyone and gives its budget back
 * (FR-INT-009 AC1), and it is the latest request of its type the member sent — on CON-OPEX-2569 to SITE-A for CON, an IT
 * purchase of hardware on IT-OPEX-2569 for IT (no personal data, no system or site access: no DPA asked). Its line has
 * room for it first (tests/e2e/budget-room.ts): other specs of the run may have left the line nothing
 */
async function history(memberId: string, departmentCode: 'CON' | 'IT', tag: string) {
  const { budgetLine, line } = HISTORY[departmentCode]
  const { id: budgetLineId } = await lineWithRoom([budgetLine], netOf([line]))
  const draft =
    departmentCode === 'CON'
      ? await createDraft(
          ctxOf(memberId, 'WEB'),
          { requestTypeCode: 'BUY_GOODS', priceIncludesVat: false, title: `คำขอก่อนหน้า ${tag}`, budgetLineId, deliverySiteId: (await site('SITE-A')).id, lines: [{ ...line }] },
          key(),
        )
      : await createDraft(
          ctxOf(memberId, 'WEB'),
          {
            requestTypeCode: 'IT_PURCHASE',
            priceIncludesVat: false,
            title: `คำขอก่อนหน้า ${tag}`,
            budgetLineId,
            formData: { category: 'HARDWARE', processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' },
            lines: [{ ...line }],
          },
          key(),
        )
  if (!draft.ok) throw new Error(`draft failed: ${draft.error.code} ${JSON.stringify(draft.error.details ?? {})}`)
  const submitted = await submitRequest(ctxOf(memberId, 'WEB'), { requestId: draft.data.requestId }, key())
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.error.code} ${JSON.stringify(submitted.error.details ?? {})}`)
  const cancelled = await cancelRequest(ctxOf(memberId, 'WEB'), { requestId: draft.data.requestId, reason: 'ส่งซ้ำ ยกเลิกใบนี้' }, key())
  if (!cancelled.ok) throw new Error(`cancel failed: ${cancelled.error.code}`)
}

async function sceneMember(tag: string | undefined, lineUserId: string | undefined) {
  const member = await freshMember(tagOf(tag), 'CON')
  await link(member.id, lineUserOf(lineUserId))
  return member
}

let result: unknown
switch (command) {
  case 'requester': {
    const [tag, lineUserId, department, withHistory] = args
    if (department !== 'CON' && department !== 'IT') throw new Error('the requester is of CON or IT')
    if (withHistory !== undefined && withHistory !== 'history') throw new Error('the last argument of requester is "history" or nothing')
    const member = await freshMember(tagOf(tag), department)
    await link(member.id, lineUserOf(lineUserId))
    if (withHistory) await history(member.id, department, tagOf(tag))
    result = { member }
    break
  }
  case 'approved': {
    const [tag, lineUserId] = args
    const member = await sceneMember(tag, lineUserId)
    const request = await sent(member.id, `ไม้อัดและตะปู ${tag}`, SCENE_LINES)
    await approveInChat(request.requestId)
    result = { member, ...request }
    break
  }
  case 'asked': {
    const [tag, lineUserId] = args
    const member = await sceneMember(tag, lineUserId)
    const request = await sent(member.id, `ไม้อัดและตะปู ${tag}`, SCENE_LINES)
    await ask(request.requestId)
    result = { member, ...request }
    break
  }
  case 'returned': {
    const [tag, lineUserId] = args
    const member = await sceneMember(tag, lineUserId)
    const request = await sent(member.id, `ไม้อัดและตะปู ${tag}`, SCENE_LINES)
    await giveBack(request.requestId)
    result = { member, ...request }
    break
  }
  case 'states': {
    const [tag, lineUserId] = args
    const member = await sceneMember(tag, lineUserId)
    const approved = await sent(member.id, `ไม้อัด อนุมัติแล้ว ${tag}`, SMALL_LINES)
    await approveInChat(approved.requestId)
    const asked = await sent(member.id, `ไม้อัด มีคำถาม ${tag}`, SMALL_LINES)
    await ask(asked.requestId)
    const returned = await sent(member.id, `ไม้อัด ตีกลับ ${tag}`, SMALL_LINES)
    await giveBack(returned.requestId)
    const draft = await drafted(member.id, `ไม้อัด ร่าง ${tag}`, SMALL_LINES)
    result = { member, approved, asked, returned, draft: { requestId: draft } }
    break
  }
  case 'approve-in-chat': {
    await approveInChat(requestIdOf(args[0]))
    result = { approved: true }
    break
  }
  case 'channels': {
    const requestId = requestIdOf(args[0])
    const events = await prisma.event.findMany({
      where: { organizationId: org.id, aggregateType: 'Request', aggregateId: requestId, type: { in: ['request.drafted', 'request.submitted', 'request.resubmitted'] } },
      select: { type: true, channel: true },
      orderBy: { seq: 'asc' },
    })
    const of = (type: string) => events.filter((e) => e.type === type).map((e) => e.channel)
    result = { drafted: [...new Set(of('request.drafted'))], submitted: of('request.submitted'), resubmitted: of('request.resubmitted') }
    break
  }
  case 'drafts': {
    const member = await prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: employeeCodeOf(tagOf(args[0])) }, select: { id: true } })
    const drafts = await prisma.request.findMany({ where: { organizationId: org.id, requesterMemberId: member.id, status: 'DRAFT' }, select: { id: true, title: true }, orderBy: { createdAt: 'asc' } })
    const events = await prisma.event.findMany({ where: { organizationId: org.id, aggregateType: 'Request', aggregateId: { in: drafts.map((d) => d.id) }, type: 'request.drafted' }, select: { aggregateId: true, channel: true } })
    result = drafts.map((d) => ({ ...d, channels: [...new Set(events.filter((e) => e.aggregateId === d.id).map((e) => e.channel))] }))
    break
  }
  default:
    throw new Error(`unknown LIFF requests scene command ${command ?? '(none)'}`)
}
console.log(JSON.stringify(result))
await prisma.$disconnect()

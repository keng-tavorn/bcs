import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { MS_PER_DAY } from '@/lib/constants'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { cancelRequest, createDraft, submitRequest } from '../support/requests'
import { E2E_DB } from '../support/e2e-env'
import { lineWithRoom } from './budget-room'

// Run by tests/e2e/duplicates.spec.ts and liff-duplicates.spec.ts against the e2e database only (S6-13 · FR-INT-103 ·
// BR-DUP-05): a fresh requester of CON (employee code e2e-dup-<tag>, a plain member no other spec touches, so their
// requests never change another spec's counts) who sent a request yesterday and has a draft just like it. The items
// carry the tag, so no other request of CON shares a line with them (BR-DUP-04 stays quiet). Prints JSON on the last line.
//   requester <tag> [lineUserId]
//        the member (linked to that LINE account when one is given, as /liff/link does); their purchase of floor tiles
//        sent through the services and its sending moved to yesterday (within the window of BR-DUP-02), and a draft of
//        the same tiles in the same quantity, to be sent from the web or the LIFF form
//   task <tag>
//        the open task of the member's draft once sent: its id and its assignee (and whether they sign in with TOTP)
//   cleanup <tag>
//        cancels every request of the member that still waits, so no task of theirs stays with an approver
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the duplicates scene runs in the e2e database only')

const [command, tagArg, lineUserArg] = process.argv.slice(2)
const password = process.env.SEED_DEV_PASSWORD
if (!password) throw new Error('SEED_DEV_PASSWORD is needed')
if (!tagArg || !/^[a-z0-9-]{3,40}$/.test(tagArg)) throw new Error('the scene needs a tag of lower-case letters, digits and -')
const tag = tagArg

const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ctxOf = (memberId: string, channel: Ctx['channel'] = 'WEB') => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel, now: systemClock.now() })
const must = <T,>(what: string, r: { ok: true; data: T } | { ok: false; error: { code: string; details?: unknown } }): T => {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} ${JSON.stringify(r.error.details ?? {})}`)
  return r.data
}
const employeeCode = `e2e-dup-${tag}`
const email = `${employeeCode}@demo.bcs.local`

async function freshMember() {
  const nameTh = `ทดสอบ คำขอซ้ำ ${tag}`
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  return prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: nameTh, displayNameEn: `Duplicate ${tag}`, employeeCode, status: 'ACTIVE', primaryDepartmentId: department.id },
    update: {},
    select: { id: true },
  })
}

/** Links the member to the LINE account as the LIFF link page does: a code issued on the web, spent with an ID token */
async function link(memberId: string, lineUserId: string) {
  if (!/^U[0-9a-f]{32}$/.test(lineUserId)) throw new Error('the scene needs a LINE user id (U and 32 hexadecimal digits)')
  const issued = must('link code', await issueLineLinkCode(ctxOf(memberId), systemClock.now()))
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }),
  })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code}`)
}

const member = async () => prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode }, select: { id: true } })

let out: unknown
switch (command) {
  case 'requester': {
    const { id } = await freshMember()
    if (lineUserArg) await link(id, lineUserArg)
    const lines = [{ description: `กระเบื้องยางปูพื้น ${tag}`, quantity: '10', uom: 'กล่อง', unitPrice: '250.00' }]
    // Room for both: the one sent and the draft, each 2,500.00 before VAT
    const room = await lineWithRoom(['CON-CAPEX-2569', 'CON-OPEX-2569'], 600_000n)
    const site = await prisma.deliverySite.findFirstOrThrow({ where: { organizationId: org.id, code: 'SITE-A' }, select: { id: true } })
    const base = { requestTypeCode: 'BUY_GOODS', priceIncludesVat: false, budgetLineId: room.id, deliverySiteId: site.id, lines }
    const title = `กระเบื้องยางรอบก่อน ${tag}`
    const first = must('draft', await createDraft(ctxOf(id), { ...base, title }, key()))
    const sent = must('submit', await submitRequest(ctxOf(id), { requestId: first.requestId }, key()))
    // Sent yesterday: inside the window of BR-DUP-02 (the demo organization's duplicateWindowDays)
    await prisma.request.update({ where: { id: first.requestId }, data: { submittedAt: new Date(systemClock.now().getTime() - MS_PER_DAY) } })
    const draftTitle = `กระเบื้องยางเพิ่ม ${tag}`
    const draft = must('second draft', await createDraft(ctxOf(id), { ...base, title: draftTitle }, key()))
    out = { member: { id, employeeCode, email }, sent: { id: first.requestId, number: sent.number, title }, draft: { id: draft.requestId, title: draftTitle } }
    break
  }
  case 'task': {
    const { id } = await member()
    const latest = await prisma.request.findFirstOrThrow({ where: { organizationId: org.id, requesterMemberId: id, status: 'PENDING_APPROVAL' }, orderBy: { submittedAt: 'desc' }, select: { id: true, number: true } })
    const task = await prisma.approvalTask.findFirstOrThrow({
      where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: latest.id } } },
      select: { id: true, assignee: { select: { employeeCode: true, user: { select: { twoFactorEnabled: true } } } } },
    })
    const flags = await prisma.requestFlag.findMany({ where: { requestId: latest.id }, select: { kind: true, acknowledgedReason: true } })
    out = { requestId: latest.id, number: latest.number, taskId: task.id, approver: task.assignee.employeeCode, approverTotp: task.assignee.user?.twoFactorEnabled === true, flags }
    break
  }
  case 'cleanup': {
    const { id } = await member()
    const waiting = await prisma.request.findMany({ where: { organizationId: org.id, requesterMemberId: id, status: { in: ['PENDING_APPROVAL', 'RETURNED'] } }, select: { id: true } })
    for (const r of waiting) must('cancel', await cancelRequest(ctxOf(id), { requestId: r.id, reason: 'จบการทดสอบคำขอซ้ำ' }, key()))
    out = { cancelled: waiting.length }
    break
  }
  default:
    throw new Error(`unknown duplicates scene command ${command ?? '(none)'}`)
}
await prisma.$disconnect()
console.log(JSON.stringify(out))

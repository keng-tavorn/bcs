import { randomUUID } from 'node:crypto'
import { agreementDay } from '@/core/pricing'
import { systemClock } from '@/lib/clock'
import { MS_PER_DAY } from '@/lib/constants'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { cancelRequest, createDraft, submitRequest } from '@/server/services/requests'
import { E2E_DB } from '../support/e2e-env'
import { lineWithRoom } from './budget-room'

// Run by tests/e2e/reorder.spec.ts against the e2e database only (S6-12 · FR-INT-101): a fresh requester of CON (employee
// code e2e-reorder-<tag>, a plain member no other spec touches, so the drafts a reorder makes never change another
// spec's counts) and their requests, built through the services as the workspace would. Prints JSON on the last line.
//   requester <tag> [lineUserId]
//        the member (linked to that LINE account when one is given, as /liff/link does) with a purchase of plywood and
//        nails sent and cancelled at once — a sent request that leaves no task with anyone and gives its budget back
//   service <tag>
//        the member's hire of a service (HIRE_SERVICE) whose line ends in 30 days: sent, approved by everyone on its
//        route, then marked ORDERED directly (the PO and its sending are not the point here)
//   drafts <tag>
//        the member's drafts with their lines, newest first, and what each was made from
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the reorder scene runs in the e2e database only')

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
const employeeCode = `e2e-reorder-${tag}`
const email = `${employeeCode}@demo.bcs.local`

async function freshMember() {
  const nameTh = `ทดสอบ ขอซ้ำ ${tag}`
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'CON' }, select: { id: true } })
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: password! })
  return prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: nameTh, displayNameEn: `Reorder ${tag}`, employeeCode, status: 'ACTIVE', primaryDepartmentId: department.id },
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
    const lines = [
      { description: `ไม้อัด 10 มม. ${tag}`, quantity: '4', uom: 'แผ่น', unitPrice: '150.00' },
      { description: `ตะปู 2 นิ้ว ${tag}`, quantity: '2', uom: 'กล่อง', unitPrice: '120.00' },
    ]
    const room = await lineWithRoom(['CON-CAPEX-2569', 'CON-OPEX-2569'], 84_000n)
    const site = await prisma.deliverySite.findFirstOrThrow({ where: { organizationId: org.id, code: 'SITE-A' }, select: { id: true } })
    const title = `ไม้อัดรอบก่อน ${tag}`
    const draft = must('draft', await createDraft(ctxOf(id), { requestTypeCode: 'BUY_GOODS', priceIncludesVat: false, title, budgetLineId: room.id, deliverySiteId: site.id, lines }, key()))
    const sent = must('submit', await submitRequest(ctxOf(id), { requestId: draft.requestId }, key()))
    must('cancel', await cancelRequest(ctxOf(id), { requestId: draft.requestId, reason: 'ส่งซ้ำ ยกเลิกใบนี้' }, key()))
    out = { member: { id, employeeCode, email }, requestId: draft.requestId, number: sent.number, title, lines: lines.map((l) => l.description) }
    break
  }
  case 'service': {
    const { id } = await member()
    const room = await lineWithRoom(['CON-CAPEX-2569', 'CON-OPEX-2569'], 120_000n)
    const ends = new Date(Date.parse(`${agreementDay(systemClock.now())}T00:00:00Z`) + 30 * MS_PER_DAY).toISOString().slice(0, 10)
    const description = `บริการดูแลเครื่องปั่นไฟ ${tag}`
    const title = `บริการดูแลเครื่องปั่นไฟ ${tag}`
    const draft = must(
      'service draft',
      await createDraft(
        ctxOf(id),
        {
          requestTypeCode: 'HIRE_SERVICE',
          priceIncludesVat: false,
          title,
          budgetLineId: room.id,
          formData: { scopeOfWork: 'ตรวจและบำรุงรักษาเครื่องปั่นไฟทุกเดือน', servicePeriod: '12 เดือน', processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'Y' },
          lines: [{ description, quantity: '1', uom: 'งาน', unitPrice: '1200.00', serviceEndDate: ends }],
        },
        key(),
      ),
    )
    const sent = must('service submit', await submitRequest(ctxOf(id), { requestId: draft.requestId }, key()))
    // Everyone on its route approves, one open task after another
    for (let guard = 0; guard < 10; guard++) {
      const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: draft.requestId } } }, select: { id: true, assigneeMemberId: true } })
      if (!task) break
      must('approval', await decideTask(ctxOf(task.assigneeMemberId), { taskId: task.id, decision: 'APPROVE' }, key()))
    }
    const approved = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, select: { status: true, lines: { select: { id: true } } } })
    if (approved.status !== 'APPROVED') throw new Error(`the service request is ${approved.status}, not APPROVED`)
    await prisma.request.update({ where: { id: draft.requestId }, data: { status: 'ORDERED' } })
    out = { requestId: draft.requestId, number: sent.number, title, lineId: approved.lines[0]!.id, description, ends }
    break
  }
  case 'drafts': {
    const { id } = await member()
    out = await prisma.request.findMany({
      where: { organizationId: org.id, requesterMemberId: id, status: 'DRAFT' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, sourceRequestId: true, renewalOfRequestLineId: true, lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, serviceEndDate: true } } },
    })
    break
  }
  default:
    throw new Error(`unknown reorder scene command ${command ?? '(none)'}`)
}
await prisma.$disconnect()
console.log(JSON.stringify(out))

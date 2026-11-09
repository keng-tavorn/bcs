import { randomUUID } from 'node:crypto'
import { systemClock } from '@/lib/clock'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { decideTask } from '@/server/services/approvals/decide'
import { issueLineLinkCode, linkLineAccount } from '@/server/services/line-link'
import { closeRfxAt, submitBid } from '@/server/services/sourcing'
import { E2E_DB } from '../support/e2e-env'
import { ensureTestPin, stepUpForTask } from '../support/pin'
import { createDraft, submitRequest } from '../support/requests'
import { lineWithRoom } from './budget-room'

// Run by tests/e2e/sourcing.spec.ts against the e2e database only (S10-12 · the internal side of scene 9 of S10.md):
// the demo organization with SUPPLIER and SOURCING switched on while the spec runs (rows only, as a platform admin
// would leave them), two approved requests of CON whose steel lines wait in the pool without a supplier, three steel
// suppliers of the portal with a contact each, and a fresh approver of the run linked to a LINE account and holding a
// PIN, to whom a rule RA-E2E-<tag> sends the awards of the demo DOA version (the demo DOA has no RA rule · S10-02).
// Prints JSON on the last line.
//   setup <tag> <lineUserId>   all of the above; prints the lines' words, the suppliers, the evaluators' and approver's names
//   bids <tag> <rfxEventId>    the three suppliers bid from the portal (23,150.00 · 23,500.00 · 23,364.49 a ton before VAT),
//                              then the RFx closes at its closesAt as its job runs it
//   task <rfxEventId>          the open approval task of the RFx's award
//   result <rfxEventId>        the award's status, the POs it drafted and how the task was decided
//   cleanup <tag>              the rule RA-E2E-<tag> removed, SUPPLIER and SOURCING of the demo organization back off
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the sourcing scene runs in the e2e database only')
setDefaultOutboxSender(null)
const [command, arg = '', arg2 = ''] = process.argv.slice(2)
const org = await prisma.organization.findFirstOrThrow({ where: { code: 'DEMO' }, select: { id: true } })
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
function ok<T>(what: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`)
  return r.data
}
const member = async (code: string) => prisma.member.findFirstOrThrow({ where: { organizationId: org.id, employeeCode: code }, select: { id: true, displayNameTh: true } })
const ctxOf = (memberId: string, now = systemClock.now()) => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now })
const PRICES = ['23150.00', '23500.00', '23364.49'] as const
const NAMES = ['ชลบุรีภัณฑ์สตีล', 'สหมิตรวัสดุสตีล', 'บางนาวัสดุสตีล'] as const

async function modules(enabled: boolean) {
  const at = new Date()
  for (const code of ['SUPPLIER', 'SOURCING'] as const) {
    await prisma.orgModule.upsert({
      where: { organizationId_module: { organizationId: org.id, module: code } },
      create: { organizationId: org.id, module: code, enabled, enabledAt: enabled ? at : null, contractRef: 'E2E-S10-12', reason: 'ทดสอบหน้าจัดหาใน e2e' },
      update: enabled ? { enabled, enabledAt: at, disabledAt: null } : { enabled, disabledAt: at },
    })
  }
}

let seq = 0
function taxId(tag: string): string {
  const base = Number.parseInt(tag.replace(/[^0-9a-f]/g, '').slice(0, 5) || '1', 16) % 90000
  const body = `01075${String(base * 3 + seq++).padStart(7, '0')}`
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (13 - i), 0)
  return body + String((11 - (sum % 11)) % 10)
}

/** Decides every open task of a document with its assignee (with the PIN when the amount asks it) until none is left */
async function approveAll(subjectId: string) {
  for (let i = 0; i < 6; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } }, select: { id: true, assigneeMemberId: true } })
    if (!task) return
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok('approve', await decideTask(ctxOf(task.assigneeMemberId), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** An approved request of CON with one steel line at a site and no supplier: a line of the pool */
async function poolLine(tag: string, quantity: string, site: string) {
  const requester = await member('req_con')
  const room = await lineWithRoom(['CON-CAPEX-2569', 'CON-OPEX-2569'], 21_000_000n)
  const siteRow = await prisma.deliverySite.findFirstOrThrow({ where: { organizationId: org.id, code: site }, select: { id: true } })
  const description = `เหล็กข้ออ้อย DB12 ${site} ${tag}`
  const draft = ok(
    'draft',
    await createDraft(ctxOf(requester.id), { requestTypeCode: 'BUY_GOODS', priceIncludesVat: false, title: `เหล็กเส้น ${site} ${tag}`, budgetLineId: room.id, deliverySiteId: siteRow.id, lines: [{ description, quantity, uom: 'ตัน', unitPrice: '23800.00', categoryCode: 'STEEL' }] }, key()),
  )
  ok('submit', await submitRequest(ctxOf(requester.id), { requestId: draft.requestId }, key()))
  await approveAll(draft.requestId)
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, select: { status: true } })
  if (request.status !== 'APPROVED') throw new Error(`the request is ${request.status}`)
  return description
}

/** A fresh approver of the run (no other spec touches it), linked to the LINE account as /liff/link does, with a PIN */
async function approver(tag: string, lineUserId: string) {
  const email = `e2e-src-${tag}@demo.bcs.local`
  const nameTh = `ผู้อนุมัติจัดหา ${tag}`
  const department = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: 'PROC' }, select: { id: true } }).catch(() => prisma.department.findFirstOrThrow({ where: { organizationId: org.id }, select: { id: true } }))
  const userId = await upsertUserWithPassword({ email, name: nameTh, password: process.env.SEED_DEV_PASSWORD! })
  const row = await prisma.member.upsert({
    where: { organizationId_email: { organizationId: org.id, email } },
    create: { organizationId: org.id, userId, email, displayNameTh: nameTh, displayNameEn: `Sourcing approver ${tag}`, employeeCode: `e2e-src-${tag}`, status: 'ACTIVE', primaryDepartmentId: department.id },
    update: {},
    select: { id: true },
  })
  await ensureTestPin(row.id)
  const issued = await issueLineLinkCode(ctxOf(row.id), systemClock.now())
  if (!issued.ok) throw new Error(`no link code: ${issued.error.code}`)
  const answer = await fetch(`${process.env.LINE_API_BASE_URL}/__fake/id-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: lineUserId, aud: process.env.LINE_LIFF_CHANNEL_ID }) })
  const { idToken } = (await answer.json()) as { idToken: string }
  const linked = await linkLineAccount({ code: issued.data.code, idToken }, { sender: null, requestId: randomUUID() })
  if (!linked.ok) throw new Error(`not linked: ${linked.error.code}`)
  return { id: row.id, name: nameTh }
}

/** RA-E2E-<tag>: the awards of the demo DOA version go to the run's approver (removed by cleanup) */
async function awardRule(tag: string, memberId: string | null) {
  const code = `RA-E2E-${tag}`
  await prisma.doaRule.deleteMany({ where: { organizationId: org.id, code: { startsWith: 'RA-E2E' } } })
  if (!memberId) return
  const now = new Date()
  const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.id, status: 'PUBLISHED', effectiveFrom: { lte: now } }, orderBy: { effectiveFrom: 'desc' }, select: { id: true } })
  await prisma.doaRule.create({ data: { organizationId: org.id, doaVersionId: version.id, code, documentType: 'RFX_AWARD', priority: 100, when: {}, steps: [{ approver: { kind: 'MEMBER', memberId }, slaBusinessMinutes: 960, mode: 'SEQUENTIAL' }] } })
}

async function setup(tag: string, lineUserId: string) {
  await modules(true)
  const lines = [await poolLine(tag, '8', 'SITE-A'), await poolLine(tag, '5', 'SITE-B')]
  const suppliers: Array<{ code: string; name: string }> = []
  for (const [n, name] of NAMES.entries()) {
    const code = `E2E-SRC-${tag}-${n}`
    const nameTh = `บริษัท ${name} ${tag} จำกัด`
    const supplier = await prisma.supplier.create({ data: { organizationId: org.id, code, nameTh, taxId: taxId(tag), isVatRegistered: true, branchCode: '00000', portalEnabled: true, category: 'STEEL' } })
    await prisma.supplierContact.create({ data: { organizationId: org.id, supplierId: supplier.id, nameTh: `ติดต่อ ${name}`, email: `src.${tag}.${n}@supplier.test`, isPrimary: true } })
    suppliers.push({ code, name: nameTh })
  }
  const who = await approver(tag, lineUserId)
  await awardRule(tag, who.id)
  return { lines, suppliers, evaluators: [(await member('dm_proc')).displayNameTh, (await member('dm_it')).displayNameTh], approver: who.name }
}

async function bids(tag: string, rfxEventId: string) {
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { closesAt: true, lines: { orderBy: { lineNo: 'asc' }, select: { id: true } } } })
  if (!rfx.closesAt) throw new Error('the RFx is not open')
  const now = systemClock.now()
  for (const [n, unitPrice] of PRICES.entries()) {
    const contact = await prisma.supplierContact.findFirstOrThrow({ where: { organizationId: org.id, supplier: { code: `E2E-SRC-${tag}-${n}` } }, select: { id: true, supplierId: true, applicationId: true } })
    ok('bid', await submitBid(portalCtx(org.id, contact, now), { rfxEventId, lines: rfx.lines.map((l) => ({ rfxLineId: l.id, offered: true, unitPrice })) }, key()))
  }
  // the close as its job runs it at closesAt
  await closeRfxAt(org.id, rfxEventId, rfx.closesAt.toISOString(), rfx.closesAt)
  return { closed: true }
}

async function task(rfxEventId: string) {
  const award = await prisma.awardDecision.findFirstOrThrow({ where: { rfxEventId, status: 'PENDING_APPROVAL' }, select: { id: true, number: true } })
  const open = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'AWARD_DECISION', subjectId: award.id } } }, select: { id: true } })
  return { taskId: open.id, awardNumber: award.number }
}

async function result(rfxEventId: string) {
  const award = await prisma.awardDecision.findFirstOrThrow({ where: { rfxEventId, status: { notIn: ['REJECTED', 'CANCELLED'] } }, select: { id: true, status: true, grossSatang: true } })
  const pos = await prisma.purchaseOrder.findMany({ where: { awardDecisionId: award.id }, select: { status: true, netSatang: true } })
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { route: { subjectType: 'AWARD_DECISION', subjectId: award.id } } }, orderBy: { assignedAt: 'desc' }, select: { id: true } })
  const event = await prisma.event.findFirst({ where: { organizationId: org.id, aggregateType: 'ApprovalTask', aggregateId: task.id, type: 'approval_task.decided' }, select: { channel: true, data: true } })
  const data = (event?.data ?? {}) as { stepUpGrantId?: unknown }
  return { status: award.status, gross: award.grossSatang.toString(), pos: pos.map((p) => ({ status: p.status, net: p.netSatang.toString() })).sort((a, b) => a.net.localeCompare(b.net)), channel: event?.channel ?? null, stepUp: typeof data.stepUpGrantId === 'string' }
}

const out =
  command === 'setup' && arg && arg2
    ? await setup(arg, arg2)
    : command === 'bids' && arg && arg2
      ? await bids(arg, arg2)
      : command === 'task' && arg
        ? await task(arg)
        : command === 'result' && arg
          ? await result(arg)
          : command === 'cleanup' && arg
            ? (await awardRule(arg, null), await modules(false), { cleaned: true })
            : null
if (!out) throw new Error('usage: sourcing-scene.ts setup <tag> <lineUserId> | bids <tag> <rfxEventId> | task <rfxEventId> | result <rfxEventId> | cleanup <tag>')
console.log(JSON.stringify(out))
await prisma.$disconnect()

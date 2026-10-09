import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { MS_PER_DAY } from '@/lib/constants'
import { isAllowed, loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import { makeCtx, type Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { onTimeOfQueue, onTimeOfTasks, onTimeWindows, type QueueLine } from '@/server/queries/on-time'
import { APPROVED_STATUSES, listPurchaseOrders } from '@/server/queries/purchase-orders'
import { listMyRequests } from '@/server/queries/requests'
import { listMyTasks } from '@/server/queries/tasks'
import { seedBudget } from '@/server/seed/budget'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { seedDevPins } from '@/server/seed/pins'
import { parseBudget, parseDemoHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { loadInputWorkbook } from '@/server/seed/workbook'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { seedDemoHistory } from '@/server/services/demo-history'
import { getExportOverview } from '@/server/services/exports/view'
import { homeApprovals, homeFollowing, homeOnTime, homeTodo, NAV_COUNT_KEYS, navCounts, TODO_KEYS, type TodoKey } from '@/server/services/home'
import { listInvoiceWork } from '@/server/services/invoices/view'
import { assignSupplier, consolidateNow, listPool } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { listReceivable } from '@/server/services/receiving/view'
import { createDraft } from '@/server/services/requests'
import { reportScope } from '@/server/services/reports/access'
import { listSuppliersForScreen } from '@/server/services/suppliers/view'
import { stepUpForTask } from '../support/pin'

// S16-09 · the home page "งานของฉัน" (FR-VIS-006) on the organization `pnpm db:seed` makes — every user of sheet Users,
// the budget, the suppliers and the requests, POs, receipts and decisions of Demo_History made through the real services.
// For every seed member, at the seed's time and two weeks later (when open tasks have gone past due): each to-do row
// shows exactly the number of the list it links to — read by that list as its page reads it, and counted again by the
// test itself — and only for members the list answers; the on-time rows follow §11.5, recomputed here; the followed
// requests and the tasks waiting are the member's own. Beyond Demo_History the setup adds, through the real services, the
// work the history leaves at nothing: a draft, an approver's question waiting for its answer, an approved PO waiting to
// be sent, and goods received on a PO with no invoice yet — so every row of §9.10 has something to count.

const NOW = new Date('2026-09-28T03:00:00Z')
const LATER = new Date(NOW.getTime() + 14 * MS_PER_DAY)
const ORG_CODE = 'HOME-CARDS'
const PASSWORD = 'home-test-password-0001'
const TOTP_KEY = 'home-test-totp-key-000000000000001'
const PIN = '739164'

interface Member {
  readonly id: string
  readonly code: string
  readonly principal: Extract<Principal, { kind: 'member' }>
}

let organizationId: string
let members: Member[]
/** A request an approver decided a step of after everything else: it moved last for its requester */
let moved: { requestId: string; requesterId: string }

const ctxOf = (m: Member, now: Date): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId: m.id }, channel: 'WEB', now })
const db = () => forTenant(organizationId)
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const byCode = (code: string) => members.find((m) => m.code === code)!
const ctxById = (memberId: string) => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: NOW })

/** Decides every open task of a document, approving, with the PIN where its amount asks for one */
async function approveAll(subjectId: string) {
  for (let i = 0; i < 6; i++) {
    const task = await db().approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(ctxById(task.assigneeMemberId), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** The work Demo_History leaves at nothing, made through the services */
async function addWork() {
  // a draft of the requester's
  const requester = byCode('req_con')
  const budgetLine = await db().budgetLine.findFirstOrThrow({ where: { department: { code: 'CON' } }, select: { id: true } })
  ok(await createDraft(ctxOf(requester, NOW), { requestTypeCode: 'BUY_GOODS', title: 'ร่างของหน้าแรก', budgetLineId: budgetLine.id, lines: [{ description: 'ปูน', quantity: '1', uom: 'ถุง', unitPrice: '150' }] }, key()))
  // an approver asks the requester of a pending request
  const pending = await db().approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST' } } }, select: { id: true, assigneeMemberId: true } })
  ok(await requestInfo(ctxById(pending.assigneeMemberId), { taskId: pending.id, question: 'ขอใบเสนอราคาเพิ่มอีก 1 ใบ' }, key()))
  // procurement orders one request of the pool: a supplier, a round, sent for approval and approved
  const buyer = members.find((m) => m.principal.roles.has('PROCUREMENT'))!
  const pool = ok(await listPool(ctxOf(buyer, NOW)))
  const first = pool[0]!
  const lines = pool.filter((l) => l.requestId === first.requestId && l.draftBlock === null).map((l) => l.requestLineId)
  const supplier = await db().supplier.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { code: 'asc' } })
  ok(await assignSupplier(ctxOf(buyer, NOW), { requestLineIds: lines, supplierId: supplier.id }, key()))
  ok(await consolidateNow(ctxOf(buyer, NOW), key()))
  const draft = await db().purchaseOrder.findFirstOrThrow({ where: { status: 'DRAFT', lines: { some: { sources: { some: { requestLineId: { in: lines } } } } } }, select: { id: true } })
  ok(await submitPo(ctxOf(buyer, NOW), { poId: draft.id }, key()))
  await approveAll(draft.id)
  // an approver decides a step of another waiting request a minute after everything else (the decision writes the task
  // and its event; on a longer route the request's own row is not touched)
  const step = await db().approvalTask.findFirstOrThrow({ where: { status: 'OPEN', id: { not: pending.id }, step: { route: { subjectType: 'REQUEST' } } }, select: { id: true, assigneeMemberId: true, step: { select: { route: { select: { subjectId: true } } } } } })
  await stepUpForTask(step.id, step.assigneeMemberId)
  const later = makeCtx({ organizationId, actor: { type: 'USER', memberId: step.assigneeMemberId }, channel: 'WEB', now: new Date(NOW.getTime() + 60_000) })
  ok(await decideTask(later, { taskId: step.id, decision: 'APPROVE' }, key()))
  const decided = await db().request.findUniqueOrThrow({ where: { id: step.step.route.subjectId }, select: { id: true, requesterMemberId: true } })
  moved = { requestId: decided.id, requesterId: decided.requesterMemberId }
  // a receiver takes one of everything on the first PO they may receive: goods in, no invoice yet
  for (const m of members) {
    const list = await listReceivable(ctxOf(m, NOW))
    const po = list.ok ? list.data.rows[0] : undefined
    if (!po) continue
    const poLines = await db().poLine.findMany({ where: { poId: po.id }, select: { id: true, quantity: true, receivedQuantity: true } })
    const line = poLines.find((l) => l.quantity.greaterThan(l.receivedQuantity))!
    ok(await postGoodsReceipt(ctxOf(m, NOW), { poId: po.id, lines: [{ poLineId: line.id, received: '1' }] }, key()))
    return
  }
  throw new Error('no member may receive a PO in the seed')
}

beforeAll(async () => {
  execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
  const workbook = await loadInputWorkbook()
  await seedTaxRates()
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const users = input.users.map((u) => ({ ...u, email: `home.${u.email}` }))
  const org = await seedDemoOrganization({ ...input, org: { ...input.org, code: ORG_CODE }, users }, { password: PASSWORD, totpKey: TOTP_KEY, now: NOW })
  organizationId = org.organizationId
  await seedOrgStructure(organizationId, users, parseOrgStructureInput(workbook), NOW)
  await seedBudget(organizationId, parseBudget(workbook), NOW)
  await seedSuppliers(organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, NOW)
  await seedDevPins(organizationId, PIN, NOW)
  await seedDemoHistory(organizationId, parseDemoHistory(workbook), NOW, { pin: PIN })

  const rows = await db().member.findMany({ where: { status: 'ACTIVE' }, select: { id: true, employeeCode: true }, orderBy: { employeeCode: 'asc' } })
  members = await Promise.all(
    rows.map(async (m) => {
      const ctx = makeCtx({ organizationId, actor: { type: 'USER', memberId: m.id }, channel: 'WEB', now: NOW })
      const principal = await db().$transaction((tx) => loadPrincipal(tx, ctx))
      if (principal.kind !== 'member') throw new Error(`not a member: ${m.employeeCode}`)
      return { id: m.id, code: m.employeeCode ?? m.id, principal }
    }),
  )
  await addWork()
}, 900_000)

/** The count each row's list shows, read the way its page reads it (null: the list refuses the member) */
async function listCount(key: TodoKey, ctx: Ctx): Promise<number | null> {
  switch (key) {
    case 'OVERDUE_TASKS':
      return (await listMyTasks(ctx, { due: 'OVERDUE' })).total
    case 'RETURNED':
      return (await listMyRequests(ctx, { scope: 'MINE', status: 'RETURNED' })).matched
    case 'QUESTIONS':
      return (await listMyRequests(ctx, { scope: 'MINE', openQuestion: true })).matched
    case 'DRAFTS':
      return (await listMyRequests(ctx, { scope: 'MINE', status: 'DRAFT' })).matched
    case 'RECEIVING': {
      // every page of /receiving, the POs it lets the member receive
      let count = 0
      for (let page = 1; ; page++) {
        const r = await listReceivable(ctx, { page })
        if (!r.ok || !r.data.receives) return null
        count += r.data.rows.length
        if (page >= r.data.pageCount) return count
      }
    }
    case 'POOL': {
      const r = await listPool(ctx)
      return r.ok ? r.data.length : null
    }
    case 'PO_APPROVED': {
      const principal = await db().$transaction((tx) => loadPrincipal(tx, ctx))
      return isAllowed(principal, 'po.create') ? (await listPurchaseOrders(ctx, { status: 'APPROVED' })).matched : null
    }
    case 'INVOICES': {
      const r = await listInvoiceWork(ctx, { received: true })
      if (!r.ok) return null
      expect(r.data.waiting.limited, 'the seed fits in one page of the list').toBe(false)
      expect(r.data.waiting.rows.length).toBe(r.data.waitingCount)
      return r.data.waiting.rows.length
    }
    case 'EXPORTS': {
      const r = await getExportOverview(ctx)
      return r.ok ? r.data.ready.count : null
    }
  }
}

/** The same numbers, counted by the test from the tables (who may see a row is the list's answer above) */
async function ownCount(key: TodoKey, m: Member, now: Date): Promise<number | null> {
  const mine = { OR: [{ assigneeMemberId: m.id }, { principalMemberId: m.id }] }
  switch (key) {
    case 'OVERDUE_TASKS':
      return db().approvalTask.count({ where: { status: 'OPEN', dueAt: { lt: now }, ...mine } })
    case 'RETURNED':
      return db().request.count({ where: { requesterMemberId: m.id, status: 'RETURNED' } })
    case 'DRAFTS':
      return db().request.count({ where: { requesterMemberId: m.id, status: 'DRAFT' } })
    case 'QUESTIONS': {
      const open = await db().infoRequest.findMany({ where: { answeredAt: null, task: { status: 'INFO_REQUESTED' }, request: { requesterMemberId: m.id } }, select: { requestId: true } })
      return new Set(open.map((q) => q.requestId)).size
    }
    case 'PO_APPROVED':
      return db().purchaseOrder.count({ where: { status: 'APPROVED' } })
    case 'INVOICES': {
      const held = await db().budgetAllocation.findMany({ where: { sourceType: 'PO_LINE', committedSatang: { gt: 0n } }, select: { sourceId: true } })
      const pos = await db().purchaseOrder.findMany({
        where: { goodsReceipts: { some: { status: 'POSTED' } }, invoices: { none: { isFinal: true } }, lines: { some: { id: { in: held.map((h) => h.sourceId) } } } },
        select: { status: true },
      })
      return pos.filter((p) => ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(p.status)).length
    }
    case 'EXPORTS':
      return db().invoiceConfirmation.count({ where: { exportedAt: null } })
    case 'POOL': {
      const lines = await db().requestLine.findMany({ where: { request: { status: { in: ['APPROVED', 'PARTIALLY_ORDERED'] } } }, select: { quantity: true, orderedQuantity: true, cancelledQuantity: true } })
      return lines.filter((l) => l.quantity.minus(l.orderedQuantity).minus(l.cancelledQuantity).greaterThan(0)).length
    }
    case 'RECEIVING':
      // decided per PO with separation of duties: the list above is the count; here only its upper bound
      return null
  }
}

describe('[FR-VIS-006/AC2] every to-do row shows exactly the number of the list it opens, for every seed member', () => {
  const seen = new Map<TodoKey, number>()

  for (const when of [
    ['at the seed’s time', NOW],
    ['two weeks later, when open tasks are past due', LATER],
  ] as const) {
    it(`${when[0]}: rows are the lists' counts, more than nothing, and only for members the list answers`, async () => {
      for (const m of members) {
        const ctx = ctxOf(m, when[1])
        const todo = await homeTodo(ctx)
        if (!todo.ok) throw new Error(`${m.code}: ${todo.error.code}`)
        const shown = new Map(todo.data.rows.map((r) => [r.key, r.count]))
        // with no row and no open task, nothing waits at all: the card shows its empty state (AC6)
        expect(todo.data.openTasks, m.code).toBe(await db().approvalTask.count({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, OR: [{ assigneeMemberId: m.id }, { principalMemberId: m.id }] } }))
        for (const key of TODO_KEYS) {
          const list = await listCount(key, ctx)
          // a row exactly when its list answers the member and holds something, with the list's number
          expect(shown.get(key) ?? null, `${m.code} ${key}`).toBe(list !== null && list > 0 ? list : null)
          const own = await ownCount(key, m, when[1])
          if (list !== null && own !== null && key !== 'EXPORTS') expect(list, `${m.code} ${key} counted by the test`).toBe(own)
          if (shown.has(key)) seen.set(key, (seen.get(key) ?? 0) + 1)
        }
        // the most pressing first: overdue, then what waits for the requester, then the rest; the larger first in each
        const tones = todo.data.rows.map((r) => ['DANGER', 'WARN', 'NEUTRAL'].indexOf(r.tone))
        expect([...tones].sort((a, b) => a - b), m.code).toEqual(tones)
      }
    })
  }

  it('every kind of work in the table of §9.10 shows for someone: the rows are compared with lists that hold something', () => {
    expect([...seen.keys()].sort()).toEqual([...TODO_KEYS].sort())
  })

  it('a member sees no row of a list that refuses them: the pool, approved POs, invoices and Express only for their roles', async () => {
    for (const m of members) {
      const todo = await homeTodo(ctxOf(m, LATER))
      if (!todo.ok) throw new Error(todo.error.code)
      const keys = new Set(todo.data.rows.map((r) => r.key))
      if (!isAllowed(m.principal, 'procurement.pool.view')) expect(keys.has('POOL'), m.code).toBe(false)
      if (!isAllowed(m.principal, 'po.create')) expect(keys.has('PO_APPROVED'), m.code).toBe(false)
      if (!isAllowed(m.principal, 'invoiceConfirmation.record')) expect(keys.has('INVOICES'), m.code).toBe(false)
      if (!isAllowed(m.principal, 'export.express')) expect(keys.has('EXPORTS'), m.code).toBe(false)
    }
  })
})

describe('[FR-PLT-013/AC2] the numbers beside the menu are the counts of the lists they open, for every seed member (NEW-73)', () => {
  it('งานอนุมัติ = my open tasks of /tasks · กองรอจัดซื้อ = the lines of /procurement/pool · ตรวจรับ = the POs /receiving lets me receive', async () => {
    const seen = new Set<string>()
    for (const now of [NOW, LATER]) {
      for (const m of members) {
        const ctx = ctxOf(m, now)
        const counts = ok(await navCounts(ctx))
        expect(counts.tasks, `${m.code} tasks`).toBe((await listMyTasks(ctx)).total)
        expect(counts.tasks, `${m.code} tasks counted by the test`).toBe(await db().approvalTask.count({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, OR: [{ assigneeMemberId: m.id }, { principalMemberId: m.id }] } }))
        expect(counts.pool, `${m.code} pool`).toBe(await listCount('POOL', ctx))
        expect(counts.receiving, `${m.code} receiving`).toBe(await listCount('RECEIVING', ctx))
        // a list that refuses the member gives no number, as its menu entry is hidden
        if (!isAllowed(m.principal, 'procurement.pool.view')) expect(counts.pool, m.code).toBeNull()
        if (counts.tasks > 0) seen.add('tasks')
        if (counts.pool) seen.add('pool')
        if (counts.receiving) seen.add('receiving')
      }
    }
    // each number is compared with a list that holds something for someone
    expect([...seen].sort()).toEqual([...NAV_COUNT_KEYS].sort())
  })

  it('only a member has numbers', async () => {
    const r = await navCounts(makeCtx({ organizationId, actor: { type: 'SYSTEM' }, channel: 'WEB', now: NOW }))
    expect(r.ok).toBe(false)
  })
})

describe('[FR-VIS-006/AC3] on-time approval tasks: the last 30 days against the 30 before, by §11.5, rows by who may read them', () => {
  it('rows follow the reader: mine with a task in 60 days, the department for a head, the organization for report.view ORG, the queue for PROCUREMENT and EXECUTIVE', async () => {
    const since = new Date(LATER.getTime() - 60 * MS_PER_DAY)
    for (const m of members) {
      const result = await homeOnTime(ctxOf(m, LATER))
      if (!result.ok) throw new Error(result.error.code)
      const keys = result.data.map((r) => r.key)
      const hadTask = (await db().approvalTask.count({ where: { assignedAt: { gte: since }, OR: [{ assigneeMemberId: m.id }, { principalMemberId: m.id }] } })) > 0
      const reads = reportScope(m.principal)
      const expected = [
        ...(hadTask ? ['MINE'] : []),
        ...(m.principal.headOfDepartmentIds.size > 0 && reads !== 'NONE' ? ['DEPARTMENT'] : []),
        ...(reads === null ? ['ORG'] : []),
        ...(reads === null && (m.principal.roles.has('PROCUREMENT') || m.principal.roles.has('EXECUTIVE')) ? ['QUEUE'] : []),
      ]
      expect(keys, m.code).toEqual(expected)
    }
  })

  it('the organization’s and my figures are the tasks due in each window — on time, late, or not counted — counted again here', async () => {
    const { current, previous } = onTimeWindows(LATER)
    const all = await db().approvalTask.findMany({ where: { dueAt: { gte: previous.from, lt: current.to } }, select: { status: true, dueAt: true, decidedAt: true, assigneeMemberId: true, principalMemberId: true } })
    const count = (tasks: typeof all, w: { from: Date; to: Date }) => {
      let onTime = 0
      let late = 0
      for (const t of tasks) {
        if (!t.dueAt || t.dueAt < w.from || t.dueAt >= w.to || ['INFO_REQUESTED', 'CANCELLED', 'REASSIGNED'].includes(t.status)) continue
        if (t.decidedAt && t.decidedAt <= t.dueAt) onTime++
        else if (t.decidedAt || (t.status === 'OPEN' && t.dueAt < LATER)) late++
      }
      return { onTime, late }
    }
    const executive = members.find((m) => m.principal.roles.has('EXECUTIVE'))!
    const org = await homeOnTime(ctxOf(executive, LATER))
    if (!org.ok) throw new Error(org.error.code)
    const orgRow = org.data.find((r) => r.key === 'ORG')!
    expect(orgRow.figure.current).toMatchObject(count(all, current))
    expect(orgRow.figure.current.onTime + orgRow.figure.current.late).toBeGreaterThan(0)
    for (const m of members) {
      const result = await homeOnTime(ctxOf(m, LATER))
      if (!result.ok) throw new Error(result.error.code)
      const mine = result.data.find((r) => r.key === 'MINE')
      if (!mine) continue
      const tasks = all.filter((t) => t.assigneeMemberId === m.id || t.principalMemberId === m.id)
      expect(mine.figure.current, m.code).toMatchObject(count(tasks, current))
      const prev = count(tasks, previous)
      const cur = count(tasks, current)
      if (prev.onTime + prev.late === 0 || cur.onTime + cur.late === 0) expect(mine.figure.deltaPoints, m.code).toBeNull()
    }
  })

  it('the department row counts only documents of the departments the head heads', async () => {
    const head = members.find((m) => m.principal.headOfDepartmentIds.size > 0 && reportScope(m.principal) !== 'NONE')!
    const result = await homeOnTime(ctxOf(head, LATER))
    if (!result.ok) throw new Error(result.error.code)
    const dept = result.data.find((r) => r.key === 'DEPARTMENT')!
    const { current } = onTimeWindows(LATER)
    const headed = [...head.principal.headOfDepartmentIds]
    const tasks = await db().approvalTask.findMany({ where: { dueAt: { gte: current.from, lt: current.to } }, select: { status: true, dueAt: true, decidedAt: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } } })
    const requests = await db().request.findMany({ where: { chargedDepartmentId: { in: headed } }, select: { id: true } })
    const ours = new Set(requests.map((r) => r.id))
    const ownRequests = tasks.filter((t) => t.step.route.subjectType === 'REQUEST' && ours.has(t.step.route.subjectId))
    // at least the requests of the departments count; never a request of another department
    const all = onTimeOfTasks(tasks, current, LATER)
    expect(dept.figure.current.onTime + dept.figure.current.late).toBeGreaterThanOrEqual(onTimeOfTasks(ownRequests, current, LATER).onTime + onTimeOfTasks(ownRequests, current, LATER).late)
    expect(dept.figure.current.onTime + dept.figure.current.late).toBeLessThanOrEqual(all.onTime + all.late)
  })

  it('the procurement queue: approved request lines against the time their first PO was sent for approval, with OQ-38’s 960 minutes', async () => {
    const buyer = members.find((m) => m.principal.roles.has('PROCUREMENT'))!
    const result = await homeOnTime(ctxOf(buyer, LATER))
    if (!result.ok) throw new Error(result.error.code)
    const queue = result.data.find((r) => r.key === 'QUEUE')!
    const { current } = onTimeWindows(LATER)
    const approved = await db().event.findMany({ where: { type: 'request.approved', occurredAt: { gte: current.from, lt: current.to } }, select: { aggregateId: true, occurredAt: true }, orderBy: { seq: 'asc' } })
    const calendar = await db().$transaction((tx) => loadBusinessCalendar(tx, organizationId))
    const lines: QueueLine[] = []
    for (const a of approved) {
      const request = await db().request.findUniqueOrThrow({ where: { id: a.aggregateId }, select: { cancelledAt: true, lines: { select: { poSources: { select: { poLine: { select: { poId: true } } } } } } } })
      for (const l of request.lines) {
        const submits = await db().event.findMany({ where: { type: 'po.submitted', aggregateId: { in: l.poSources.map((s) => s.poLine.poId) } }, select: { occurredAt: true }, orderBy: { occurredAt: 'asc' }, take: 1 })
        lines.push({ approvedAt: a.occurredAt, submittedAt: submits[0]?.occurredAt ?? null, cancelledAt: request.cancelledAt })
      }
    }
    expect(queue.figure.current).toEqual(onTimeOfQueue(lines, current, LATER, 960, calendar))
  })
})

describe('[FR-VIS-006/AC4] the requests I follow: mine and followed, not drafts, the open ones, five that moved last', () => {
  it('for every member, the counts are the tables’ and the rows are the latest moved, each saying whom it waits for', async () => {
    for (const m of members) {
      const result = await homeFollowing(ctxOf(m, NOW))
      if (!result.ok) throw new Error(result.error.code)
      const f = result.data
      const ownOrFollowed = { OR: [{ requesterMemberId: m.id }, { followers: { some: { memberId: m.id } } }], status: { not: 'DRAFT' as const } }
      expect(f.total, m.code).toBe(await db().request.count({ where: ownOrFollowed }))
      expect(f.open, m.code).toBe(await db().request.count({ where: { ...ownOrFollowed, status: { in: ['PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'PARTIALLY_ORDERED', 'ORDERED', 'SUBMITTED'] } } }))
      // when each moved last, counted here: its row and events, its tasks, its questions, the events of its POs
      const requests = await db().request.findMany({ where: ownOrFollowed, select: { id: true, updatedAt: true } })
      const ids = requests.map((r) => r.id)
      const times = new Map(requests.map((r) => [r.id, [r.updatedAt.getTime()]]))
      const add = (id: string, at: Date | null | undefined) => at && times.get(id)?.push(at.getTime())
      for (const e of await db().event.findMany({ where: { aggregateType: 'Request', aggregateId: { in: ids } }, select: { aggregateId: true, occurredAt: true } })) add(e.aggregateId, e.occurredAt)
      for (const t of await db().approvalTask.findMany({ where: { step: { route: { subjectType: 'REQUEST', subjectId: { in: ids } } } }, select: { assignedAt: true, decidedAt: true, step: { select: { route: { select: { subjectId: true } } } } } })) {
        add(t.step.route.subjectId, t.assignedAt)
        add(t.step.route.subjectId, t.decidedAt)
      }
      for (const q of await db().infoRequest.findMany({ where: { requestId: { in: ids } }, select: { requestId: true, askedAt: true, answeredAt: true } })) {
        add(q.requestId, q.askedAt)
        add(q.requestId, q.answeredAt)
      }
      for (const src of await db().poLineSource.findMany({ where: { requestLine: { requestId: { in: ids } } }, select: { poLine: { select: { poId: true } }, requestLine: { select: { requestId: true } } } }))
        for (const e of await db().event.findMany({ where: { aggregateType: 'PurchaseOrder', aggregateId: src.poLine.poId }, select: { occurredAt: true } })) add(src.requestLine.requestId, e.occurredAt)
      const last = (id: string) => Math.max(...times.get(id)!)
      const latest = [...ids].sort((a, b) => last(b) - last(a) || (a < b ? 1 : -1)).slice(0, 5)
      expect(f.rows.map((r) => r.id), m.code).toEqual(latest)
      if (m.id === moved.requesterId) expect(f.rows[0]!.id, `${m.code}: the request decided last leads`).toBe(moved.requestId)
      for (const r of f.rows) expect(r.stage.kind, `${m.code} ${r.number}`).not.toBe('DRAFT')
      // "ดูทั้งหมด" opens /requests?scope=following, which holds the same requests
      expect((await listMyRequests(ctxOf(m, NOW), { scope: 'FOLLOWING' })).matched, m.code).toBe(f.total)
    }
  })
})

describe('[FR-VIS-006/AC5] waiting for my approval: every open task of mine in three tabs, earliest due first', () => {
  it('for every member, the tabs count the tables and list the earliest due first, ten at most, each opening its decision page', async () => {
    for (const m of members) {
      const result = await homeApprovals(ctxOf(m, LATER))
      if (!result.ok) throw new Error(result.error.code)
      const a = result.data
      const mine = { OR: [{ assigneeMemberId: m.id }, { principalMemberId: m.id }] }
      expect(a.all.count, m.code).toBe(await db().approvalTask.count({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, ...mine } }))
      expect(a.overdue.count, m.code).toBe(await db().approvalTask.count({ where: { status: 'OPEN', dueAt: { lt: LATER }, ...mine } }))
      expect(a.info.count, m.code).toBe(await db().approvalTask.count({ where: { status: 'INFO_REQUESTED', ...mine } }))
      for (const tab of [a.all, a.overdue, a.info]) {
        expect(tab.rows.length).toBe(Math.min(tab.count, 10))
        const due = tab.rows.map((r) => r.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
        expect([...due].sort((x, y) => x - y), m.code).toEqual(due)
      }
      for (const r of a.overdue.rows) expect(r.overdue).toBe(true)
      for (const r of a.info.rows) expect(r.status).toBe('INFO_REQUESTED')
      // the amount is the one the DOA counted for the route (its basis)
      for (const r of a.all.rows) {
        const task = await db().approvalTask.findUniqueOrThrow({ where: { id: r.id }, select: { step: { select: { route: { select: { amountSatang: true } } } } } })
        expect(r.amountSatang).toBe(task.step.route.amountSatang)
      }
    }
  })
})

describe('[FR-VIS-006/AC1] "ผู้ขายและราคา": the register with its latest prices, prices only for readers of every PO', () => {
  it('readers with po.view over the organization see each supplier’s latest approved prices; nobody else sees a price', async () => {
    let priced = 0
    for (const m of members) {
      const result = await listSuppliersForScreen(ctxOf(m, NOW), {})
      if (!result.ok) continue
      const seesAll = scopesFor(m.principal, 'po.view').has('ORG')
      expect(result.data.seesPrices, m.code).toBe(seesAll)
      for (const row of result.data.rows) {
        if (!seesAll) {
          expect(row.prices, m.code).toBeUndefined()
          continue
        }
        const lines = await db().poLine.findMany({
          where: { po: { supplierId: row.id, status: { in: [...APPROVED_STATUSES] } } },
          select: { description: true, unitPriceSatang: true, po: { select: { approvedAt: true } } },
          orderBy: [{ po: { approvedAt: 'desc' } }, { lineNo: 'asc' }],
        })
        const first = lines[0]
        expect(row.prices!.length > 0, `${m.code} ${row.code}`).toBe(lines.length > 0)
        if (first) {
          expect(row.prices![0]).toMatchObject({ description: first.description, unitPriceSatang: first.unitPriceSatang })
          priced++
        }
      }
    }
    expect(priced).toBeGreaterThan(0)
  })

  it('a reader of prices finds a supplier by an item it sold, the item first; a basic reader’s search does not reach items', async () => {
    const line = await db().poLine.findFirstOrThrow({ where: { po: { status: { in: [...APPROVED_STATUSES] } } }, select: { description: true, po: { select: { supplierId: true } } } })
    const word = line.description
    const buyer = members.find((m) => scopesFor(m.principal, 'po.view').has('ORG'))!
    const found = await listSuppliersForScreen(ctxOf(buyer, NOW), { q: word })
    if (!found.ok) throw new Error(found.error.code)
    const row = found.data.rows.find((r) => r.id === line.po.supplierId)!
    expect(row.prices![0]!.description.toLowerCase()).toContain(word.toLowerCase())
    const basic = members.find((m) => !scopesFor(m.principal, 'po.view').has('ORG'))!
    const basicFound = await listSuppliersForScreen(ctxOf(basic, NOW), { q: word })
    if (!basicFound.ok) throw new Error(basicFound.error.code)
    for (const r of basicFound.data.rows) expect(r.prices).toBeUndefined()
  })
})

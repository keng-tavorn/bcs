import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { TZDate } from '@date-fns/tz'
import { beforeAll, describe, expect, it } from 'vitest'
import { BP_PER_WHOLE } from '@/core/money/constants'
import { amountToSatang } from '@/core/money/dto'
import { addBusinessMinutes, businessMinutesBetween, type BusinessCalendar } from '@/core/sla'
import { MS_PER_DAY } from '@/lib/constants'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization, type DemoOrgInput } from '@/server/seed/demo-org'
import { seedBudget } from '@/server/seed/budget'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { parseBudget, parseDemoHistory, parseSites, parseSuppliers, type DemoHistoryRow } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { INPUT_WORKBOOK_PATH, loadInputWorkbook, type InputWorkbook } from '@/server/seed/workbook'
import { pendingBoard } from '@/server/services/board'
import { budgetDashboard, type BudgetDashboardDto } from '@/server/services/budget/dashboard'
import { DemoHistoryIncompleteError, DemoHistoryOutOfYearError, lineChatRefusal, seedDemoHistory, type DemoHistoryReport } from '@/server/services/demo-history'
import { computeKpis } from '@/server/services/reports/kpi'

// D-01: the requests of sheet Demo_History are made through the real services with the business clock set back by
// `daysAgo`, and end in their status with POs, receipts and invoices. The board of pending work, the budget dashboard
// and the KPIs then show what the line "ข้อมูลพอสำหรับฉาก dashboard" of `pnpm inputs:check` promises the demo: the
// requests waiting past their SLA, the budget lines running low, and the share of purchase-request decisions made on
// LINE (G-5). The expected values are read from that line itself (scripts/validate_inputs.py) and from the sheets,
// never from the code under test. The demo organization is seeded under its own code and e-mail addresses so it
// never meets the one tests/integration/seed.test.ts seeds at the same time.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
/** A Monday 10:00 in Bangkok inside the sheets' fiscal year, before today's date so no step lies ahead of the real clock */
const NOW = new Date('2026-09-28T03:00:00Z')
const ORG_CODE = 'DEMO-HISTORY'
const PASSWORD = 'history-test-password-0001'
const TOTP_KEY = 'history-test-totp-key-000000000001'
const MINUTES_PER_HOUR = 60
const PERCENT = 100
/** The KPI period: long enough to hold every row of the sheet */
const KPI_DAYS = 365
/** Tenths of a percent in a whole */
const TENTHS_OF_PERCENT = 1000n
const DECIDED = new Set(['COMPLETED', 'ORDERED', 'APPROVED', 'RETURNED', 'REJECTED'])

interface DashboardLine {
  readonly overdue: string[]
  readonly low: string[]
  readonly linePercent: number
}

/** The dashboard line of `pnpm inputs:check`, e.g. ค้างเกิน SLA: ['H12 ค้าง 18 ชม. ที่ vp_ops (SLA 8)'] · งบใกล้หมด: [...] · อนุมัติผ่าน LINE 76% */
function inputsCheckDashboardLine(): DashboardLine {
  const run = spawnSync(process.execPath, ['scripts/py.mjs', 'scripts/validate_inputs.py', INPUT_WORKBOOK_PATH, '--spec', 'spec.md'], { cwd: ROOT, encoding: 'utf8' })
  const line = run.stdout.split(/\r?\n/).find((l) => l.includes('ข้อมูลพอสำหรับฉาก dashboard'))
  if (run.status !== 0 || !line) throw new Error(`pnpm inputs:check did not pass:\n${run.stdout}\n${run.stderr}`)
  const match = /^PASS\s+ข้อมูลพอสำหรับฉาก dashboard — ค้างเกิน SLA: \[(.*)\] · งบใกล้หมด: \[(.*)\] · อนุมัติผ่าน LINE (\d+)%$/.exec(line.trim())
  if (!match) throw new Error(`unexpected dashboard line: ${line}`)
  const items = (list: string) => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
  return { overdue: items(match[1]!), low: items(match[2]!), linePercent: Number(match[3]) }
}

/** The demo organization of the sheets under another code, its users under other addresses */
function historyOrgInput(workbook: InputWorkbook, code: string, emailPrefix: string): DemoOrgInput {
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  return { ...input, org: { ...input.org, code }, users: input.users.map((u) => ({ ...u, email: `${emailPrefix}${u.email}` })) }
}

/** What pnpm db:seed makes before the history: the organization, its structure, budget, suppliers and sites */
async function seedOrganization(workbook: InputWorkbook, code: string, emailPrefix: string): Promise<string> {
  const input = historyOrgInput(workbook, code, emailPrefix)
  const org = await seedDemoOrganization(input, { password: PASSWORD, totpKey: TOTP_KEY, now: NOW })
  await seedOrgStructure(org.organizationId, input.users, parseOrgStructureInput(workbook), NOW)
  await seedBudget(org.organizationId, parseBudget(workbook), NOW)
  await seedSuppliers(org.organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, NOW)
  return org.organizationId
}

interface Seeded {
  readonly organizationId: string
  readonly report: DemoHistoryReport
  readonly sheet: ReadonlyArray<Readonly<Record<string, string | null>>>
  readonly budgetSheet: ReadonlyArray<Readonly<Record<string, string | null>>>
  readonly calendar: BusinessCalendar
  readonly memberOf: ReadonlyMap<string, string>
  readonly codeOf: ReadonlyMap<string, string>
  readonly requestOf: ReadonlyMap<string, { id: string; status: string; submittedAt: Date | null }>
  readonly refOf: ReadonlyMap<string, string>
}

let expected: DashboardLine
let seeded: Seeded
let workbook: InputWorkbook

async function seedHistory(): Promise<DemoHistoryReport> {
  return seedDemoHistory(seeded.organizationId, parseDemoHistory(workbook), NOW)
}

beforeAll(async () => {
  expected = inputsCheckDashboardLine()
  workbook = await loadInputWorkbook()
  await seedTaxRates()
  const organizationId = await seedOrganization(workbook, ORG_CODE, 'history.')
  const report = await seedDemoHistory(organizationId, parseDemoHistory(workbook), NOW)

  const db = forTenant(organizationId)
  const members = await db.member.findMany({ select: { id: true, employeeCode: true } })
  const sheet = workbook.table('Demo_History').map((r) => r.values)
  const requests = await db.request.findMany({ select: { id: true, title: true, status: true, submittedAt: true } })
  const byTitle = new Map(requests.map((r) => [r.title, r]))
  seeded = {
    organizationId,
    report,
    sheet,
    budgetSheet: workbook.table('Budget').map((r) => r.values),
    calendar: await db.$transaction((tx) => loadBusinessCalendar(tx, organizationId)),
    memberOf: new Map(members.map((m) => [m.employeeCode ?? '', m.id])),
    codeOf: new Map(members.map((m) => [m.id, m.employeeCode ?? ''])),
    requestOf: new Map(sheet.map((row) => [row.ref!, byTitle.get(row.title!)!])),
    refOf: new Map(sheet.map((row) => [byTitle.get(row.title!)?.id ?? '', row.ref!])),
  }
}, 900_000)

const ctxOf = (code: string): Ctx => makeCtx({ organizationId: seeded.organizationId, actor: { type: 'USER', memberId: seeded.memberOf.get(code)! }, channel: 'WEB', now: NOW })

/** A member who holds `role` in the seeded organization (who that is comes from the Users sheet) */
async function holderOf(role: 'EXECUTIVE' | 'FINANCE' | 'BUDGET_ADMIN'): Promise<string> {
  const held = await prisma.roleAssignment.findFirstOrThrow({ where: { organizationId: seeded.organizationId, role, revokedAt: null }, select: { memberId: true }, orderBy: { memberId: 'asc' } })
  return seeded.codeOf.get(held.memberId)!
}

/** The calendar day of an instant in the organization's time zone */
function localDay(at: Date, calendar: BusinessCalendar): string {
  const local = new TZDate(at.getTime(), calendar.timezone)
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
}

describe('[FR-PLT-001/AC1] D-01 the demo history: every row of Demo_History ends in its status through the real services, once', () => {
  it('makes one request per row in the status the sheet gives, with its PO, receipt and invoice', async () => {
    expect(seeded.report.seeded).toBe(true)
    const db = forTenant(seeded.organizationId)
    // Who receives (ADR-038 item 13): the RECEIVER of the requester's department in the Users sheet, else the requester
    const users = workbook.table('Users').map((r) => r.values)
    const departmentOf = new Map(users.map((u) => [u.code!, u.department!]))
    const receiversIn = (department: string) => users.filter((u) => u.department === department && (u.roles ?? '').split(/[,;\s]+/).includes('RECEIVER')).map((u) => u.code!)
    for (const row of seeded.sheet) {
      const request = seeded.requestOf.get(row.ref!)
      expect(request, row.ref!).toBeDefined()
      expect(request!.status, row.ref!).toBe(row.status)
      const pos = await db.purchaseOrder.findMany({ where: { lines: { some: { sources: { some: { requestLine: { requestId: request!.id } } } } } }, select: { id: true, status: true } })
      const receipts = await db.goodsReceipt.count({ where: { poId: { in: pos.map((p) => p.id) }, status: 'POSTED' } })
      const invoices = await db.invoiceConfirmation.count({ where: { poId: { in: pos.map((p) => p.id) }, isFinal: true } })
      const want = { ORDERED: ['SENT', 0, 0], COMPLETED: ['CLOSED', 1, 1] }[row.status as 'ORDERED' | 'COMPLETED'] ?? null
      expect({ pos: pos.map((p) => p.status), receipts, invoices }, row.ref!).toEqual(want ? { pos: [want[0]], receipts: want[1], invoices: want[2] } : { pos: [], receipts: 0, invoices: 0 })
      if (row.status === 'COMPLETED') {
        const gr = await db.goodsReceipt.findFirstOrThrow({ where: { poId: { in: pos.map((p) => p.id) }, status: 'POSTED' }, select: { receiverMemberId: true } })
        const receivers = receiversIn(departmentOf.get(row.requester!)!)
        const receivedBy = seeded.codeOf.get(gr.receiverMemberId)
        if (receivers.length) expect(receivers, row.ref!).toContain(receivedBy)
        else expect(receivedBy, row.ref!).toBe(row.requester)
      }
    }
    expect(Object.values(seeded.report.byStatus).reduce((a, b) => a + b, 0)).toBe(seeded.sheet.length)
  })

  it('sends each decided request on the business day `daysAgo` days back and decides it `hours` business hours later on its channel', async () => {
    const db = forTenant(seeded.organizationId)
    for (const row of seeded.sheet.filter((r) => DECIDED.has(r.status!))) {
      const request = seeded.requestOf.get(row.ref!)!
      const back = new TZDate(NOW.getTime() - Number(row.daysAgo) * MS_PER_DAY, seeded.calendar.timezone)
      const midnight = new Date(new TZDate(back.getFullYear(), back.getMonth(), back.getDate(), 0, 0, seeded.calendar.timezone).getTime())
      expect(localDay(request.submittedAt!, seeded.calendar), row.ref!).toBe(localDay(addBusinessMinutes(midnight, 1, seeded.calendar), seeded.calendar))
      const decided = await db.event.findFirstOrThrow({ where: { type: 'approval_task.decided', data: { path: ['subjectId'], equals: request.id } }, select: { occurredAt: true, channel: true } })
      expect(businessMinutesBetween(request.submittedAt!, decided.occurredAt, seeded.calendar), row.ref!).toBe(Number(row.hours) * MINUTES_PER_HOUR)
      expect(decided.channel, row.ref!).toBe(row.channel)
    }
  })

  it('refuses a row decided in the chat that the chat button cannot decide (§9.3, BR-TOK-05)', () => {
    const chat = { ref: 'H99', channel: 'LINE_CHAT' as const }
    expect(lineChatRefusal({ ...chat, status: 'APPROVED' }, 99_999_00n, 100_000_00n)).toBeNull()
    expect(lineChatRefusal({ ...chat, status: 'APPROVED' }, 100_000_00n, 100_000_00n)).toContain('PIN')
    expect(lineChatRefusal({ ...chat, status: 'REJECTED' }, 1_000_00n, 100_000_00n)).toContain('LIFF')
    expect(lineChatRefusal({ ...chat, status: 'APPROVED' }, 1_000_000_00n, null)).toBeNull()
    expect(lineChatRefusal({ ref: 'H99', channel: 'LIFF', status: 'APPROVED' }, 1_000_000_00n, 100_000_00n)).toBeNull()
    // The sheet itself is refused before anything is made
    const rows = workbook.table('Demo_History')
    const returned = rows.find((r) => r.values.status === 'RETURNED')!
    const edited: InputWorkbook = { ...workbook, table: (sheet) => (sheet === 'Demo_History' ? rows.map((r) => (r === returned ? { ...r, values: { ...r.values, channel: 'LINE_CHAT' } } : r)) : workbook.table(sheet)) }
    expect(() => parseDemoHistory(edited)).toThrow(`Demo_History ${returned.values.ref}: a returned request is decided in LIFF or on the web`)
  })

  it('a second run finds the history made and adds nothing', async () => {
    const count = () => Promise.all([prisma.request.count({ where: { organizationId: seeded.organizationId } }), prisma.event.count({ where: { organizationId: seeded.organizationId } })])
    const before = await count()
    expect(await seedHistory()).toEqual({ seeded: false, byStatus: {} })
    expect(await count()).toEqual(before)
  })
})

describe('[FR-VIS-001/AC3] D-01 the board shows the requests waiting past their SLA as pnpm inputs:check expects', () => {
  it('lists exactly the overdue tasks of the dashboard line, with their approver, business hours waited and SLA', async () => {
    expect(expected.overdue.length).toBeGreaterThan(0)
    const board = await pendingBoard(ctxOf(await holderOf('EXECUTIVE')))
    if (!board.ok) throw new Error(JSON.stringify(board.error))
    const overdue = board.data.flatMap((row) =>
      row.tasks
        .filter((t) => t.overdue)
        .map((t) => {
          const hours = t.ageMinutes / MINUTES_PER_HOUR
          const sla = businessMinutesBetween(new Date(t.assignedAt), new Date(t.dueAt!), seeded.calendar) / MINUTES_PER_HOUR
          return `${seeded.refOf.get(t.subjectId)} ค้าง ${hours} ชม. ที่ ${seeded.codeOf.get(row.memberId)} (SLA ${sla})`
        }),
    )
    expect(overdue.sort()).toEqual([...expected.overdue].sort())
    // The requests still waiting have waited the hours of the sheet; only the ones past their SLA are flagged
    const waiting = board.data.flatMap((row) => row.tasks.filter((t) => t.subjectType === 'REQUEST').map((t) => [seeded.refOf.get(t.subjectId), t.ageMinutes] as const))
    const pending = seeded.sheet.filter((r) => r.status === 'PENDING_APPROVAL').map((r) => [r.ref, Number(r.hours) * MINUTES_PER_HOUR] as const)
    expect(waiting.sort()).toEqual([...pending].sort())
  })

  it('shows per approver the open tasks, those past their SLA, and the oldest and average waits of the tasks and the sheet', async () => {
    const board = await pendingBoard(ctxOf(await holderOf('EXECUTIVE')))
    if (!board.ok) throw new Error(JSON.stringify(board.error))
    const open = await prisma.approvalTask.findMany({ where: { organizationId: seeded.organizationId, status: 'OPEN' }, select: { assigneeMemberId: true, dueAt: true } })
    expect(board.data.map((r) => r.memberId).sort()).toEqual([...new Set(open.map((t) => t.assigneeMemberId))].sort())
    for (const row of board.data) {
      const code = seeded.codeOf.get(row.memberId)!
      const mine = open.filter((t) => t.assigneeMemberId === row.memberId)
      const waits = seeded.sheet.filter((r) => r.status === 'PENDING_APPROVAL' && r.expectedApprover === code).map((r) => Number(r.hours) * MINUTES_PER_HOUR)
      expect({ open: row.open, overdue: row.overdue, oldest: row.oldestMinutes, average: row.averageMinutes }, code).toEqual({
        open: mine.length,
        overdue: mine.filter((t) => t.dueAt !== null && t.dueAt < NOW).length,
        oldest: Math.max(...waits),
        average: Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
      })
    }
  })
})

describe('[FR-BUD-005/AC1] D-01 the budget dashboard shows the demo budget as pnpm inputs:check expects', () => {
  let dashboard: BudgetDashboardDto
  beforeAll(async () => {
    const result = await budgetDashboard(ctxOf(await holderOf('FINANCE')))
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    dashboard = result.data
  })

  it('flags exactly the budget lines of the dashboard line as low, at the share left it prints', () => {
    expect(expected.low.length).toBeGreaterThan(0)
    const printed = new Map(
      expected.low.map((text) => {
        const m = /^(\S+) เหลือ (\d+)\.(\d)%$/.exec(text)
        if (!m) throw new Error(`unexpected low line: ${text}`)
        return [m[1]!, BigInt(`${m[2]}${m[3]}`)] as const
      }),
    )
    expect(dashboard.lines.filter((l) => l.low).map((l) => l.code).sort()).toEqual([...printed.keys()].sort())
    for (const line of dashboard.lines.filter((l) => l.low)) {
      // The printed share left (tenths of a percent) is the exact share, rounded: within half a tenth of it
      const available = amountToSatang(line.available.amount)
      const planned = amountToSatang(line.planned.amount)
      const gap = printed.get(line.code)! * planned - available * TENTHS_OF_PERCENT
      expect((gap < 0n ? -gap : gap) * 2n <= planned, line.code).toBe(true)
    }
  })

  it('shows on every line the amount the Budget sheet says is used and remains', () => {
    expect(dashboard.scope).toBe('ORG')
    expect(dashboard.lines.map((l) => l.code).sort()).toEqual(seeded.budgetSheet.map((b) => b.code).sort())
    for (const sheetLine of seeded.budgetSheet) {
      const line = dashboard.lines.find((l) => l.code === sheetLine.code)!
      const used = amountToSatang(line.reserved.amount) + amountToSatang(line.committed.amount) + amountToSatang(line.actual.amount)
      expect({ planned: amountToSatang(line.planned.amount), used, available: amountToSatang(line.available.amount) }, sheetLine.code!).toEqual({
        planned: amountToSatang(sheetLine.planned!),
        used: amountToSatang(sheetLine.usedDemo!),
        available: amountToSatang(sheetLine.remaining!),
      })
    }
  })

  it('adds the lines up per department and in all, and gives each line the shares used and held the sheets give', () => {
    const plannedOf = (lines: typeof seeded.budgetSheet) => lines.reduce((sum, b) => sum + amountToSatang(b.planned!), 0n)
    expect(dashboard.departments.map((d) => d.code).sort()).toEqual([...new Set(seeded.budgetSheet.map((b) => b.department!))].sort())
    for (const d of dashboard.departments) expect(amountToSatang(d.planned.amount), d.code).toBe(plannedOf(seeded.budgetSheet.filter((b) => b.department === d.code)))
    expect(amountToSatang(dashboard.total.planned.amount)).toBe(plannedOf(seeded.budgetSheet))
    // held = what the sheet counts against the budget; used = what was ordered or invoiced (one PO per request, at its price)
    const halfUpBp = (part: bigint, whole: bigint) => Number((part * BP_PER_WHOLE * 2n + whole) / (whole * 2n))
    for (const sheetLine of seeded.budgetSheet) {
      const line = dashboard.lines.find((l) => l.code === sheetLine.code)!
      const planned = amountToSatang(sheetLine.planned!)
      const ordered = seeded.sheet.filter((r) => r.budgetLine === sheetLine.code && (r.status === 'ORDERED' || r.status === 'COMPLETED')).reduce((sum, r) => sum + amountToSatang(r.net!), 0n)
      expect({ heldBp: line.heldBp, usedBp: line.usedBp }, sheetLine.code!).toEqual({ heldBp: halfUpBp(amountToSatang(sheetLine.usedDemo!), planned), usedBp: halfUpBp(ordered, planned) })
    }
  })

  it('matches the ledger to the satang on every line, every department and in all', async () => {
    const entries = await prisma.budgetLedgerEntry.findMany({ where: { organizationId: seeded.organizationId }, select: { budgetLineId: true, fromBucket: true, toBucket: true, amountSatang: true } })
    const buckets = ['AVAILABLE', 'RESERVED', 'COMMITTED', 'ACTUAL'] as const
    const fromLedger = (lineIds: ReadonlySet<string>) =>
      Object.fromEntries(
        buckets.map((b) => [
          b,
          entries.filter((e) => lineIds.has(e.budgetLineId)).reduce((sum, e) => sum + (e.toBucket === b ? e.amountSatang : 0n) - (e.fromBucket === b ? e.amountSatang : 0n), 0n),
        ]),
      )
    const shown = (f: BudgetDashboardDto['total']) => ({ AVAILABLE: amountToSatang(f.available.amount), RESERVED: amountToSatang(f.reserved.amount), COMMITTED: amountToSatang(f.committed.amount), ACTUAL: amountToSatang(f.actual.amount) })
    for (const line of dashboard.lines) expect(shown(line), line.code).toEqual(fromLedger(new Set([line.id])))
    for (const department of dashboard.departments) expect(shown(department), department.code).toEqual(fromLedger(new Set(dashboard.lines.filter((l) => l.departmentId === department.id).map((l) => l.id))))
    expect(shown(dashboard.total)).toEqual(fromLedger(new Set(dashboard.lines.map((l) => l.id))))
  })

  it('shows a department head the lines of their departments only, and a requester nothing', async () => {
    const head = await budgetDashboard(ctxOf('dm_con'))
    if (!head.ok) throw new Error(JSON.stringify(head.error))
    const con = await prisma.department.findFirstOrThrow({ where: { organizationId: seeded.organizationId, code: 'CON' }, select: { id: true } })
    expect(head.data.scope).toBe('DEPT')
    expect(head.data.lines.length).toBeGreaterThan(0)
    expect(head.data.lines.every((l) => l.departmentId === con.id)).toBe(true)
    expect(await budgetDashboard(ctxOf('req_con'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-VIS-003/AC1] D-01 the KPIs give the share of purchase-request decisions on LINE that pnpm inputs:check expects', () => {
  it('G-5 for purchase requests: decisions in LINE chat or LIFF out of every decision of the sheet', async () => {
    const from = new Date(NOW.getTime() - KPI_DAYS * MS_PER_DAY)
    const kpi = await forTenant(seeded.organizationId).$transaction((tx) => computeKpis(tx, seeded.organizationId, { from, to: NOW, now: NOW }, null))
    const requests = kpi.g5.bySubject.PURCHASE_REQUEST!
    const decided = seeded.sheet.filter((r) => DECIDED.has(r.status!))
    expect(requests).toEqual({ numerator: decided.filter((r) => r.channel === 'LINE_CHAT' || r.channel === 'LIFF').length, denominator: decided.length })
    // The printed percent is the exact share, rounded: within half a percent of it
    expect(Math.abs(expected.linePercent * decided.length - requests.numerator * PERCENT) * 2 <= decided.length).toBe(true)
  })
})

describe('[FR-PLT-001/AC1] D-01 a history an earlier seed stopped half way is refused; a row CANCELLED is taken back by its requester', () => {
  it('refuses, before it makes anything, a history that would leave the fiscal year of its budget lines', async () => {
    const organizationId = await seedOrganization(workbook, `${ORG_CODE}-2`, 'history2.')
    const year = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId }, orderBy: { endsOn: 'desc' }, select: { endsOn: true } })
    const afterTheYear = new Date(year.endsOn.getTime() + 4 * MS_PER_DAY)
    await expect(seedDemoHistory(organizationId, parseDemoHistory(workbook), afterTheYear)).rejects.toBeInstanceOf(DemoHistoryOutOfYearError)
    expect(await prisma.request.count({ where: { organizationId } })).toBe(0)
    expect(await prisma.commandLog.count({ where: { organizationId, idempotencyKey: { contains: 'demo-history:' } } })).toBe(0)
  })

  it('stops at a row it cannot make, keeps what was made before it, and the next seed refuses to go on', async () => {
    const organizationId = await seedOrganization(workbook, `${ORG_CODE}-2`, 'history2.')
    const rows = parseDemoHistory(workbook)
    const cheapest = (status: DemoHistoryRow['status']) => rows.filter((r) => r.status === status).sort((a, b) => Number(amountToSatang(a.net) - amountToSatang(b.net)))[0]!
    const completed = cheapest('COMPLETED')
    const pending = cheapest('PENDING_APPROVAL')
    // The same request as the one still waiting, sent a week ago (a Monday, as NOW is), taken back an hour later
    const cancelled: DemoHistoryRow = { ...pending, ref: 'H98', title: `${pending.title} (ยกเลิก)`, status: 'CANCELLED', channel: null, daysAgo: 7, hours: 1, note: 'ซื้อจากร้านใกล้ไซต์งานแทน' }

    // The last row names a budget line the organization does not have: the seed stops before making it
    await expect(seedDemoHistory(organizationId, [completed, cancelled, { ...pending, budgetLine: 'NO-SUCH-LINE' }], NOW)).rejects.toThrow(`Demo_History ${pending.ref}: unknown`)
    const db = forTenant(organizationId)
    const made = new Map((await db.request.findMany({ select: { id: true, title: true, status: true } })).map((r) => [r.title, r]))
    expect([completed, cancelled, pending].map((r) => made.get(r.title)?.status ?? null)).toEqual(['COMPLETED', 'CANCELLED', null])
    // Taking the request back gave its reservation back (BR-BUD-03)
    const lines = await db.requestLine.findMany({ where: { requestId: made.get(cancelled.title)!.id }, select: { id: true } })
    const moves = await db.budgetLedgerEntry.findMany({ where: { sourceId: { in: lines.map((l) => l.id) } }, select: { fromBucket: true, toBucket: true, amountSatang: true } })
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.reduce((held, m) => held + (m.toBucket === 'RESERVED' ? m.amountSatang : 0n) - (m.fromBucket === 'RESERVED' ? m.amountSatang : 0n), 0n)).toBe(0n)

    const again = seedDemoHistory(organizationId, [completed, cancelled, pending], NOW)
    await expect(again).rejects.toBeInstanceOf(DemoHistoryIncompleteError)
    await expect(again).rejects.toMatchObject({ lastRef: pending.ref })
  })
})

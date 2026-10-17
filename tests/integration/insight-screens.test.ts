import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPrincipal } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { runCommand } from '@/server/services/_pipeline'
import { decideTask } from '@/server/services/approvals/decide'
import { auditView, exportAudit, searchAudit } from '@/server/services/audit'
import { boardView, pendingBoard, remindTask } from '@/server/services/board'
import { createDelegation } from '@/server/services/delegations'
import { getDownloadUrl } from '@/server/services/files'
import { grantRole, revokeRole } from '@/server/services/members/roles'
import { createReportSchedule, exportReport, kpiMeasureTh, scheduledReportCommand } from '@/server/services/reports'
import { reportFileReadable } from '@/server/services/reports/access'
import { computeKpis } from '@/server/services/reports/kpi'
import { kpiDetail, kpiView, reportCatalog, scheduleReport } from '@/server/services/reports/screens'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// Unit i (S4-10, S4-11, S5-12): what the board, audit, report and KPI screens read beyond the services of S4 — the
// board's scope and when a document may be reminded again, who may remind (the AUDITOR reads only, BR-AUTH-04) and two
// reminders pressed at once, the audit trail of a document by its number with its DOA version and its budget
// movements, the export file's columns in every row (with a delegated decision), the report catalogue and schedules
// whose recipients must be able to read the report themselves, report files readable only within their scope, the KPI
// page's organization-only reading with no baseline invented, the documents behind every KPI figure, and the KPI CSV of
// a 60-day review with each measure named in Thai. Real Postgres; every permission check has its refusal here.

const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`)
const MON = '2026-10-05'
const TUE = '2026-10-06'
const WED = '2026-10-07'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let budgetLineId: string
let inactiveId: string
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

/** A request of `requester` sent at `when`, with its open task */
async function sent(title: string, netBaht: string, when: Date, requester: string | Ctx = 'req_con') {
  const ctxAt = (t: Date): Ctx => (typeof requester === 'string' ? org.ctxOf(requester, t) : { ...requester, now: t })
  const draft = ok(await createDraft(ctxAt(when), { requestTypeCode: 'BUY_GOODS', title, budgetLineId, lines: [{ description: title, quantity: '1', uom: 'ชิ้น', unitPrice: netBaht }] }, key()))
  const done = ok(await submitRequest(ctxAt(when), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  return { requestId: draft.requestId, number: done.number, taskId: task.id }
}

/** An active member of CON made for one test, acting through the services like anyone else */
async function freshMember(nameTh: string): Promise<{ id: string; ctxAt: (when: Date) => Ctx }> {
  const id = (await prisma.member.create({ data: { organizationId: org.organizationId, displayNameTh: nameTh, email: `fresh-${randomUUID()}@test.bcs.local`, status: 'ACTIVE', primaryDepartmentId: org.department.CON! } })).id
  return { id, ctxAt: (when) => ({ ...org.ctxOf('req_con', when), actor: { type: 'USER', memberId: id } }) }
}

const principalOf = (code: string, now: Date) => forTenant(org.organizationId).$transaction((tx) => loadPrincipal(tx, org.ctxOf(code, now)))

/** RFC 4180 rows of a UTF-8 file with a byte order mark */
function csvRows(bytes: Uint8Array): string[][] {
  const text = new TextDecoder().decode(bytes).replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

async function download(code: string, now: Date, fileId: string): Promise<Uint8Array> {
  const url = ok(await getDownloadUrl(org.ctxOf(code, now), { fileId })).url
  return new Uint8Array(await (await fetch(url)).arrayBuffer())
}

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: at(MON, '08:00') },
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: at(MON, '08:00') },
      { organizationId: org.organizationId, memberId: org.member.ceo!, role: 'EXECUTIVE', grantedAt: at(MON, '08:00') },
      { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: at(MON, '08:00') },
    ],
  })
  const con = org.department.CON!
  inactiveId = (await prisma.member.create({ data: { organizationId: org.organizationId, displayNameTh: 'ผู้ใช้ที่ยังไม่รับคำเชิญ', email: `invited-${randomUUID()}@test.bcs.local`, status: 'INVITED', primaryDepartmentId: con } })).id
})

describe('[FR-VIS-001/AC1] the board page says what each viewer’s board covers and filters by the holder’s department', () => {
  it('ORG for an executive, DEPT for a head, OWN for a requester; a department filter keeps that department’s holders; an invited member is refused', async () => {
    await sent('ไม้แบบ', '30000.00', at(MON, '09:00')) // PR-02: the VP of OPS
    await sent('ตะปู', '1000.00', at(MON, '09:00')) // PR-01: the DM of CON
    const now = at(TUE, '11:00')
    const executive = ok(await boardView(org.ctxOf('ceo', now)))
    expect(executive.scope).toBe('ORG')
    expect(executive.asOf).toBe(now.toISOString())
    // the same rows the board service gives
    expect(executive.rows).toEqual(ok(await pendingBoard(org.ctxOf('ceo', now))))
    expect(ok(await boardView(org.ctxOf('dm_con', now))).scope).toBe('DEPT')
    expect(ok(await boardView(org.ctxOf('req_con', now))).scope).toBe('OWN')
    const ops = ok(await boardView(org.ctxOf('ceo', now), { departmentId: org.department.OPS! }))
    expect(ops.rows.map((r) => r.memberId)).toEqual([org.member.vp_ops])
    const con = ok(await boardView(org.ctxOf('ceo', now), { departmentId: org.department.CON! }))
    expect(con.rows.map((r) => r.memberId)).toEqual([org.member.dm_con])
    const invited = { ...org.ctxOf('req_con', now), actor: { type: 'USER' as const, memberId: inactiveId } }
    expect(await boardView(invited)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-VIS-001/AC2] the board says when a document may be reminded again, and the refusal says when', () => {
  it('the requester’s reminder at 13:00 makes 14:00 the next allowed time, on the board and in the refusal; after it, the document may be reminded at once', async () => {
    const t = await sent('เหล็กเส้น', '2500.00', at(MON, '09:30'))
    const first = at(MON, '13:00')
    ok(await remindTask(org.ctxOf('req_con', first), { taskId: t.taskId }, key()))
    const next = new Date(first.getTime() + 3_600_000).toISOString()
    const board = ok(await boardView(org.ctxOf('ceo', at(MON, '13:20'))))
    const task = board.rows.flatMap((r) => r.tasks).find((x) => x.taskId === t.taskId)!
    expect(task).toMatchObject({ remindAgainAt: next, poId: null })
    expect(await remindTask(org.ctxOf('proc_officer', at(MON, '13:30')), { taskId: t.taskId }, key())).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { reason: 'REMINDED_WITHIN_HOUR', nextAt: next } } })
    const later = ok(await boardView(org.ctxOf('ceo', at(MON, '14:05'))))
    expect(later.rows.flatMap((r) => r.tasks).find((x) => x.taskId === t.taskId)).toMatchObject({ remindAgainAt: null })
  })

  it('two reminders pressed at the same moment send one: the document is locked before the last reminder is read', async () => {
    const t = await sent('ท่อพีวีซี', '1500.00', at(TUE, '09:30'))
    const when = at(TUE, '14:00')
    const both = await Promise.all([remindTask(org.ctxOf('req_con', when), { taskId: t.taskId }, key()), remindTask(org.ctxOf('proc_officer', when), { taskId: t.taskId }, key())])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { reason: 'REMINDED_WITHIN_HOUR' } } })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'approval_task.reminded', data: { path: ['subjectId'], equals: t.requestId } } })).toBe(1)
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'task.reminder', subjectId: t.requestId } })).toBe(1)
  })

  it('BR-AUTH-04: the auditor reads the board but reminds nobody; seen otherwise than as AUDITOR — their own request — a task may be reminded', async () => {
    const t = await sent('สายไฟ', '1800.00', at(TUE, '10:00'))
    const when = at(TUE, '15:00')
    // the auditor sees every open task (ORG) and may remind none of them
    const auditorBoard = ok(await boardView(org.ctxOf('auditor', when)))
    expect(auditorBoard.scope).toBe('ORG')
    const seen = auditorBoard.rows.flatMap((r) => r.tasks)
    expect(seen.find((x) => x.taskId === t.taskId)).toMatchObject({ status: 'OPEN', canRemind: false })
    expect(seen.every((x) => !x.canRemind)).toBe(true)
    expect(await remindTask(org.ctxOf('auditor', when), { taskId: t.taskId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'READ_ONLY' } } })
    // the requester and procurement may (their own document; an organization-wide role that is not read-only)
    for (const who of ['req_con', 'proc_officer']) expect(ok(await boardView(org.ctxOf(who, when))).rows.flatMap((r) => r.tasks).find((x) => x.taskId === t.taskId), who).toMatchObject({ canRemind: true })
    // a task waiting for the requester's answer is reminded by nobody
    expect(ok(await boardView(org.ctxOf('ceo', when))).rows.flatMap((r) => r.tasks).filter((x) => x.status === 'INFO_REQUESTED' && x.canRemind)).toEqual([])

    // an AUDITOR who sends a request of their own may remind its approver, and still none of the others
    const auditing = await freshMember('ผู้ตรวจสอบที่ขอซื้อเอง')
    ok(await grantRole(org.ctxOf('admin', at(TUE, '08:00')), { memberId: auditing.id, role: 'AUDITOR' }, key()))
    const own = await sent('กระดาษถ่ายเอกสาร', '900.00', at(TUE, '10:30'), auditing.ctxAt(at(TUE, '10:30')))
    const theirs = ok(await boardView(auditing.ctxAt(when))).rows.flatMap((r) => r.tasks)
    expect(theirs.find((x) => x.taskId === own.taskId)).toMatchObject({ canRemind: true })
    expect(theirs.find((x) => x.taskId === t.taskId)).toMatchObject({ canRemind: false })
    expect(await remindTask(auditing.ctxAt(when), { taskId: t.taskId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'READ_ONLY' } } })
    ok(await remindTask(auditing.ctxAt(when), { taskId: own.taskId }, key()))
  })
})

describe('[FR-VIS-004/AC1] the audit page finds a document’s trail by its number, with the DOA version of each decision and its budget movements', () => {
  it('the request’s own events, its task’s and the budget it reserved, newest first; a number nobody has finds nothing; only AUDITOR and ORG_ADMIN may look', async () => {
    const t = await sent('ปูนซีเมนต์', '4200.00', at(TUE, '09:00'))
    ok(await decideTask(org.ctxOf('dm_con', at(TUE, '10:00'), 'LINE_CHAT'), { taskId: t.taskId, decision: 'APPROVE' }, key()))
    const trail = ok(await searchAudit(org.ctxOf('auditor', at(TUE, '11:00')), { document: t.number }))
    expect(trail.rows.map((r) => r.type)).toEqual(expect.arrayContaining(['request.drafted', 'request.submitted', 'approval_task.assigned', 'approval_task.decided', 'request.approved', 'budget.reserved']))
    // the request's own events and its task's name the request; its budget movements name the budget line they moved
    const budget = trail.rows.filter((r) => r.aggregateType === 'BudgetLine')
    expect(budget.length).toBeGreaterThanOrEqual(1)
    for (const r of budget) expect(r).toMatchObject({ document: { type: 'BUDGET_LINE', id: budgetLineId }, data: { documentType: 'REQUEST', documentId: t.requestId } })
    const own = trail.rows.filter((r) => r.aggregateType !== 'BudgetLine')
    expect(new Set(own.map((r) => r.document?.id))).toEqual(new Set([t.requestId]))
    expect(own.every((r) => r.document?.type === 'REQUEST' && r.document.label.startsWith(t.number))).toBe(true)
    // nothing of another request's budget comes with it
    const others = await prisma.event.count({ where: { organizationId: org.organizationId, aggregateType: 'BudgetLine', NOT: { data: { path: ['documentId'], equals: t.requestId } } } })
    expect(others).toBeGreaterThan(0)
    const decided = trail.rows.find((r) => r.type === 'approval_task.decided')!
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: t.requestId }, select: { doaVersionId: true, doaVersion: { select: { code: true } } } })
    expect(decided).toMatchObject({ channel: 'LINE_CHAT', doaRuleCode: 'PR-01', doaVersionId: route.doaVersionId, doaVersion: { code: route.doaVersion.code, versionNo: 1 }, aggregateId: t.taskId })
    // newest first
    expect(trail.rows.map((r) => BigInt(r.seq))).toEqual([...trail.rows.map((r) => BigInt(r.seq))].sort((a, b) => (a > b ? -1 : 1)))
    expect(ok(await searchAudit(org.ctxOf('auditor', at(TUE, '11:00')), { document: 'PR-2569-99999' })).rows).toEqual([])

    const page = ok(await auditView(org.ctxOf('auditor', at(TUE, '11:00')), { document: t.number }))
    expect(page).toMatchObject({ canExport: true, nextBeforeSeq: null })
    expect(page.rows).toHaveLength(trail.rows.length)
    expect(page.eventTypes).toEqual(expect.arrayContaining(['approval_task.decided', 'audit.exported', 'request.submitted']))
    expect(page.members.map((m) => m.id)).toEqual(expect.arrayContaining([org.member.dm_con, org.member.auditor]))
    expect(ok(await auditView(org.ctxOf('admin', at(TUE, '11:00')), {})).canExport).toBe(false)
    for (const who of ['ceo', 'req_con', 'fin_officer']) expect(await auditView(org.ctxOf(who, at(TUE, '11:00')), {}), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-DOA-005/AC3] [FR-VIS-004/AC2] [FR-VIS-004/AC3] the exported audit file has the DOA version, rule, channel, actor and on-behalf-of in every row', () => {
  it('a decision by the acting approver names whom they acted for, in Excel and in CSV, with the file’s checksum; the export is an event; the CEO is refused', async () => {
    // dm_con is away on Wednesday: asst_con acts for them (BR-DLG-04)
    ok(await createDelegation(org.ctxOf('dm_con', at(TUE, '17:00')), { delegateMemberId: org.member.asst_con!, startsAt: at(WED, '00:00').toISOString(), endsAt: at(WED, '23:59').toISOString(), reason: 'ลาพักร้อน' }, key()))
    const t = await sent('ทรายถม', '6000.00', at(WED, '09:00'))
    const task = await prisma.approvalTask.findUniqueOrThrow({ where: { id: t.taskId } })
    expect(task).toMatchObject({ assigneeMemberId: org.member.asst_con, principalMemberId: org.member.dm_con })
    ok(await decideTask(org.ctxOf('asst_con', at(WED, '10:00'), 'LIFF'), { taskId: t.taskId, decision: 'APPROVE' }, key()))
    const exportAt = at(WED, '11:00')
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: t.requestId }, select: { doaVersionId: true } })
    const names = Object.fromEntries((await prisma.member.findMany({ where: { id: { in: [org.member.asst_con!, org.member.dm_con!] } }, select: { id: true, displayNameTh: true } })).map((m) => [m.id, m.displayNameTh]))
    const columns = ['doaVersionId', 'doaRuleCode', 'channel', 'actor', 'onBehalfOf'] as const

    // a refusal for everyone but the AUDITOR (ADR-038 ข้อ 5)
    for (const who of ['ceo', 'admin']) expect(await exportAudit(org.ctxOf(who, exportAt), { filter: { document: t.number } }, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    for (const format of ['xlsx', 'csv'] as const) {
      const file = ok(await exportAudit(org.ctxOf('auditor', exportAt), { filter: { document: t.number }, format }, key()))
      const bytes = await download('auditor', exportAt, file.fileId)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.checksum)
      let rows: string[][]
      if (format === 'csv') rows = csvRows(bytes).filter((r) => r.length > 1)
      else {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
        rows = []
        workbook.worksheets[0]!.eachRow({ includeEmpty: true }, (row) => rows.push(Array.from({ length: 12 }, (_, i) => String(row.getCell(i + 1).value ?? ''))))
      }
      const [header, ...body] = rows
      const at_ = (name: string) => header!.indexOf(name)
      for (const c of columns) expect(at_(c), `${format} ${c}`).toBeGreaterThanOrEqual(0)
      expect(body).toHaveLength(file.rowCount)
      // every row has every column (a value, or empty where the event has none)
      for (const r of body) expect(r.length, format).toBe(header!.length)
      const decision = body.find((r) => r[at_('type')] === 'approval_task.decided')!
      expect(columns.map((c) => decision[at_(c)])).toEqual([route.doaVersionId, 'PR-01', 'LIFF', names[org.member.asst_con!], names[org.member.dm_con!]])
      expect(await prisma.event.findFirstOrThrow({ where: { type: 'audit.exported', aggregateId: file.exportJobId } })).toMatchObject({ actorMemberId: org.member.auditor, data: { rowCount: file.rowCount, checksum: file.checksum, format } })
    }
  })
})

describe('[FR-VIS-002/AC1] the report catalogue offers the KPI report with its filters and columns, and a schedule is written in the organization’s time zone', () => {
  it('FINANCE sees the report, may schedule it to members who read the whole organization, and the schedule lists; others are refused', async () => {
    const now = at(WED, '12:00')
    const catalog = ok(await reportCatalog(org.ctxOf('fin_officer', now)))
    expect(catalog).toMatchObject({ scope: 'ORG', canSchedule: true, timezone: 'Asia/Bangkok' })
    // The KPI view, then the four workflow reports of S6-20 (FR-VIS-101), each over a period
    expect(catalog.reports.map((r) => r.code)).toEqual(['KPI', 'WF_CYCLE', 'WF_BOTTLENECKS', 'WF_WRONG_DOA', 'WF_HEATMAP'])
    expect(catalog.reports[0]).toEqual(expect.objectContaining({ code: 'KPI', params: [{ key: 'from', kind: 'date' }, { key: 'to', kind: 'date' }] }))
    expect(catalog.reports[0]!.columns.map((c) => c.key)).toEqual(['kpi', 'name', 'value', 'unit', 'numerator', 'denominator', 'measure'])
    // the unit and the code are the file's: the screen says them in its own words
    expect(catalog.reports[0]!.columns.filter((c) => c.fileOnly).map((c) => c.key)).toEqual(['unit', 'measure'])
    const recipients = catalog.recipients.map((r) => r.id)
    expect(recipients).toEqual(expect.arrayContaining([org.member.fin_officer, org.member.ceo, org.member.auditor, org.member.proc_officer]))
    expect(recipients).not.toContain(org.member.req_con)
    expect(recipients).not.toContain(org.member.admin)

    const made = ok(await scheduleReport(org.ctxOf('fin_officer', now), { reportCode: 'KPI', cadence: 'MONTHLY', format: 'csv', recipientMemberIds: [org.member.fin_officer!, org.member.ceo!] }, key()))
    expect(await prisma.reportSchedule.findUniqueOrThrow({ where: { id: made.scheduleId } })).toMatchObject({ cron: 'TZ=Asia/Bangkok 0 8 1 * *', format: 'CSV', reportCode: 'KPI' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'report_schedule.created', aggregateId: made.scheduleId } })).toMatchObject({ actorMemberId: org.member.fin_officer })
    expect(ok(await reportCatalog(org.ctxOf('ceo', now))).schedules).toEqual(expect.arrayContaining([expect.objectContaining({ id: made.scheduleId, cadence: 'MONTHLY', format: 'CSV', recipientCount: 2 })]))
    expect(await scheduleReport(org.ctxOf('fin_officer', now), { reportCode: 'KPI', cadence: 'HOURLY', format: 'csv', recipientMemberIds: [org.member.ceo!] }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'cadence' } } })
    // report.schedule is FINANCE's and EXECUTIVE's; a head reads reports but schedules none
    expect(await scheduleReport(org.ctxOf('dm_con', now), { reportCode: 'KPI', cadence: 'WEEKLY', format: 'xlsx', recipientMemberIds: [org.member.dm_con!] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await reportCatalog(org.ctxOf('req_con', now))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-VIS-002/AC3] the report catalogue reads in the viewer’s scope', () => {
  it('a department head reads their departments and sees no schedules or recipients', async () => {
    const head = ok(await reportCatalog(org.ctxOf('dm_con', at(WED, '12:00'))))
    expect(head).toMatchObject({ scope: 'DEPT', canSchedule: false, schedules: [], recipients: [] })
  })
})

describe('[FR-VIS-002/AC3] a scheduled report goes only to recipients who may read it themselves', () => {
  it('a schedule naming a requester or a department head is refused; a recipient whose role is taken away receives nothing at the next run', async () => {
    const now = at(WED, '12:30')
    const weekly = 'TZ=Asia/Bangkok 0 8 * * 1'
    // the file holds the creator's whole-organization figures: a requester and a head of one department may not read it
    for (const who of ['req_con', 'dm_con']) {
      expect(await createReportSchedule(org.ctxOf('fin_officer', now), { reportCode: 'KPI', cron: weekly, recipientMemberIds: [org.member.fin_officer!, org.member[who]!] }, key()), who).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', details: { field: 'recipientMemberIds', reason: 'RECIPIENT_SCOPE', count: 1 } },
      })
    }
    // the screen's way in refuses the same
    expect(await scheduleReport(org.ctxOf('fin_officer', now), { reportCode: 'KPI', cadence: 'WEEKLY', format: 'csv', recipientMemberIds: [org.member.req_con!] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'RECIPIENT_SCOPE' } } })

    // a finance colleague receives the file while they are in finance, and nothing after leaving it
    const colleague = await freshMember('เพื่อนร่วมงานฝ่ายบัญชี')
    ok(await grantRole(org.ctxOf('admin', now), { memberId: colleague.id, role: 'FINANCE' }, key()))
    const schedule = ok(await createReportSchedule(org.ctxOf('fin_officer', now), { reportCode: 'KPI', cron: weekly, recipientMemberIds: [org.member.fin_officer!, colleague.id] }, key()))
    const emails = Object.fromEntries((await prisma.member.findMany({ where: { id: { in: [org.member.fin_officer!, colleague.id] } }, select: { id: true, email: true } })).map((m) => [m.id, m.email]))
    const run = async (slot: string) => ok(await runCommand(systemCtx(org.organizationId, new Date(slot), 'report-schedules'), scheduledReportCommand, { scheduleId: schedule.scheduleId, slot }, { idempotencyKey: `report-schedule:${schedule.scheduleId}:${slot}`, sender: null }))
    expect((await run('2026-10-12T01:00:00.000Z')).recipients.sort()).toEqual([emails[org.member.fin_officer!], emails[colleague.id]].sort())
    ok(await revokeRole(org.ctxOf('admin', at(WED, '13:00')), { memberId: colleague.id, role: 'FINANCE' }, key()))
    expect((await run('2026-10-19T01:00:00.000Z')).recipients).toEqual([emails[org.member.fin_officer!]])
  })
})

describe('[FR-VIS-002/AC3] a report file is readable only within the scope it was made for', () => {
  it('an organization-wide KPI file is for readers of the whole organization; a head’s file for readers of those departments', async () => {
    const now = at(WED, '14:00')
    const params = { from: MON, to: WED }
    const orgFile = ok(await exportReport(org.ctxOf('fin_officer', now), { reportCode: 'KPI', params, format: 'csv' }, key()))
    const headFile = ok(await exportReport(org.ctxOf('dm_con', now), { reportCode: 'KPI', params, format: 'csv' }, key()))
    const job = async (id: string) => (await prisma.exportJob.findUniqueOrThrow({ where: { id }, select: { params: true } })).params
    const [orgParams, headParams] = [await job(orgFile.exportJobId), await job(headFile.exportJobId)]
    expect(orgParams).toMatchObject({ scope: 'ORG' })
    expect((headParams as { scope: string[] }).scope).toEqual(expect.arrayContaining([org.department.CON]))
    const readable = async (code: string, p: unknown) => reportFileReadable(await principalOf(code, now), p)
    // the organization's file: finance and the CEO, never a head of one department or a requester
    expect(await readable('fin_officer', orgParams)).toBe(true)
    expect(await readable('ceo', orgParams)).toBe(true)
    expect(await readable('dm_con', orgParams)).toBe(false)
    expect(await readable('req_con', orgParams)).toBe(false)
    // CON's file: CON's head and the organization's readers, not the head of IT
    expect(await readable('dm_con', headParams)).toBe(true)
    expect(await readable('fin_officer', headParams)).toBe(true)
    expect(await readable('dm_it', headParams)).toBe(false)
    // a file whose scope cannot be read counts as the whole organization's
    expect(await readable('dm_con', {})).toBe(false)
  })
})

const period = { from: MON, to: WED }

describe('[FR-VIS-003/AC2] the executive’s KPI page shows the organization’s current figures and never invents a baseline', () => {
  it('the executive’s figures are computeKpis of the period with no baseline while none is recorded (NEW-36); a head and a requester are refused; a period that ends before it starts is refused', async () => {
    const now = at(WED, '15:00')
    const view = ok(await kpiView(org.ctxOf('ceo', now), period))
    const expected = await forTenant(org.organizationId).$transaction((tx) => computeKpis(tx, org.organizationId, { from: at(MON, '00:00'), to: new Date(at(WED, '00:00').getTime() + 86_400_000), now }, null))
    expect(view).toMatchObject({ period, kpi: expected, baseline: null, asOf: now.toISOString() })
    expect(view.kpi.g5.bySubject.PURCHASE_REQUEST!.denominator).toBeGreaterThanOrEqual(2)
    expect(await kpiView(org.ctxOf('dm_con', now), period)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'ORG_SCOPE' } } })
    expect(await kpiView(org.ctxOf('req_con', now), period)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await kpiView(org.ctxOf('ceo', now), { from: WED, to: MON })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'PERIOD' } } })
  })

  it('every figure opens the documents it counts: the lists have as many items as the figures', async () => {
    const now = at(WED, '15:00')
    const { kpi } = ok(await kpiView(org.ctxOf('ceo', now), period))
    const g5 = ok(await kpiDetail(org.ctxOf('ceo', now), period, 'g5'))
    expect({ items: g5.items.length, total: g5.total, counted: g5.counted }).toEqual({ items: kpi.g5.total.denominator, total: kpi.g5.total.denominator, counted: kpi.g5.total.numerator })
    expect(g5.items.filter((i) => i.mark === 'MOBILE').map((i) => i.channel).sort()).toEqual(['LIFF', 'LINE_CHAT'])
    const delegated = g5.items.find((i) => i.channel === 'LIFF')!
    expect(delegated).toMatchObject({ document: { type: 'REQUEST' }, decision: 'APPROVE', doaRef: { ruleCode: 'PR-01', versionNo: 1 } })
    expect(delegated.onBehalfOf).not.toBeNull()
    const requests = ok(await kpiDetail(org.ctxOf('ceo', now), period, 'g5', 'PURCHASE_REQUEST'))
    expect({ items: requests.items.length, counted: requests.counted }).toEqual({ items: kpi.g5.bySubject.PURCHASE_REQUEST!.denominator, counted: kpi.g5.bySubject.PURCHASE_REQUEST!.numerator })
    const g2b = ok(await kpiDetail(org.ctxOf('ceo', now), period, 'g2b'))
    expect(g2b.counted).toBe(kpi.g2.withDoaReference.numerator)
    // G-2 (a): every decision checked again with the DOA engine, the misrouted ones counted, so "0 รายการ (ตรวจแล้ว n
    // การตัดสิน)" opens the n decisions it checked (§9.9)
    expect(kpi.g2.checked).toBeGreaterThan(0)
    const g2a = ok(await kpiDetail(org.ctxOf('ceo', now), period, 'g2a'))
    expect({ items: g2a.items.length, total: g2a.total, counted: g2a.counted }).toEqual({ items: kpi.g2.checked, total: kpi.g2.checked, counted: kpi.g2.misrouted })
    expect(g2a.items.filter((i) => i.mark === 'MISROUTED')).toHaveLength(kpi.g2.misrouted)
    expect(g2a.items.filter((i) => i.mark !== 'MISROUTED').every((i) => i.mark === 'DOA_MATCHED')).toBe(true)
    const g3c = ok(await kpiDetail(org.ctxOf('ceo', now), period, 'g3c'))
    expect(g3c.items).toHaveLength(kpi.g3.pastDue.numerator)
    expect(g3c.items.every((i) => i.mark === 'PAST_DUE_OPEN' || i.mark === 'PAST_DUE_DECIDED')).toBe(true)
    // "1 จาก 37 ขั้น": every step G-3 (c) divides by, in the same scope and period, the past-due ones counted and first,
    // each marked why it is counted or not (§9.9 every number opens its list)
    expect(kpi.g3.pastDue.denominator).toBeGreaterThan(0)
    const steps = ok(await kpiDetail(org.ctxOf('ceo', now), period, 'g3c-steps'))
    expect({ items: steps.items.length, total: steps.total, counted: steps.counted }).toEqual({ items: kpi.g3.pastDue.denominator, total: kpi.g3.pastDue.denominator, counted: kpi.g3.pastDue.numerator })
    const pastDue = (i: { mark: string | null }) => i.mark === 'PAST_DUE_OPEN' || i.mark === 'PAST_DUE_DECIDED'
    expect(steps.items.slice(0, steps.counted).every(pastDue)).toBe(true)
    expect(steps.items.slice(steps.counted).some(pastDue)).toBe(false)
    expect(steps.items.slice(steps.counted).every((i) => ['DECIDED_ON_TIME', 'OPEN_NOT_DUE', 'NO_DUE_TIME', 'CLOSED_UNDECIDED'].includes(i.mark ?? ''))).toBe(true)
    // the counted steps are the steps of the value's own list
    expect(steps.items.filter(pastDue).map((i) => i.key).sort()).toEqual(g3c.items.map((i) => i.key).sort())
    // every step names its document and who holds it
    expect(steps.items.every((i) => i.document !== null && i.person !== null)).toBe(true)
    expect(await kpiDetail(org.ctxOf('dm_con', now), period, 'g3c-steps')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const g3b = ok(await kpiDetail(org.ctxOf('ceo', now), period, 'g3b'))
    expect(g3b.items.map((i) => i.minutes)).not.toContain(null)
    expect(await kpiDetail(org.ctxOf('ceo', now), period, 'g9')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await kpiDetail(org.ctxOf('dm_con', now), period, 'g5')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

/** The report page's Thai words for a measure code (messages/src/th/reports.json), the words the file must use too */
function screenWords(code: string): string {
  const th = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../messages/src/th/reports.json'), 'utf8')) as { measures: Record<string, string>; kinds: Record<string, string> }
  if (th.measures[code]) return th.measures[code]
  return th.measures.decisionsOnLineOf!.replace('{kind}', th.kinds[code.replace('DECISIONS_ON_LINE_', '')]!)
}

describe('[FR-VIS-003/AC3] G-5 names every kind of document a decision can be about', () => {
  it('each subject of an approval route (the kinds of phase 1 too) has words in the file, on the report page and on the KPI page, never its code (P1-09)', () => {
    const schema = readFileSync(path.resolve(import.meta.dirname, '../../prisma/schema.prisma'), 'utf8')
    const subjects = /enum ApprovalSubjectType \{([^}]*)\}/.exec(schema)![1]!.split(/\s+/).filter(Boolean)
    expect(subjects.length).toBeGreaterThanOrEqual(12)
    const kpiKinds = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../messages/src/th/kpi.json'), 'utf8')) as { kinds: Record<string, string> }).kinds
    for (const subject of subjects) {
      const kind = subject === 'REQUEST' ? 'PURCHASE_REQUEST' : subject
      const code = `DECISIONS_ON_LINE_${kind}`
      expect(kpiMeasureTh(code), code).not.toBe(code)
      expect(kpiMeasureTh(code), code).toBe(screenWords(code))
      expect(kpiKinds[kind], `kpi.kinds.${kind}`).toBeTruthy()
    }
  })
})

describe('[FR-VIS-003/AC3] the KPI CSV of a 60-day review has every measure with its numerator and denominator', () => {
  it('the executive exports 60 days as CSV: each measure named in Thai as the screens name it, with its unit and code; G-5 of purchase requests as the page shows it; a checksum', async () => {
    const now = at(WED, '16:00')
    const review = { from: '2026-08-09', to: WED }
    const { kpi } = ok(await kpiView(org.ctxOf('ceo', now), review))
    const file = ok(await exportReport(org.ctxOf('ceo', now), { reportCode: 'KPI', params: review, format: 'csv' }, key()))
    const bytes = await download('ceo', now, file.fileId)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.checksum)
    const [header, ...rows] = csvRows(bytes).filter((r) => r.length > 1)
    expect(header).toEqual(['ตัวชี้วัด', 'สิ่งที่วัด', 'ค่า', 'หน่วย', 'ตัวตั้ง', 'ตัวหาร', 'รหัส'])
    expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining(['G-1', 'G-2', 'G-3', 'G-4', 'G-5']))
    // every measure in the same words as the screens, and those words come from one place in the service
    for (const r of rows) expect(r[1], r[6]).toBe(screenWords(r[6]!))
    for (const r of rows) expect(kpiMeasureTh(r[6]!)).toBe(r[1])
    const pr = kpi.g5.bySubject.PURCHASE_REQUEST!
    expect(rows.find((r) => r[6] === 'DECISIONS_ON_LINE_PURCHASE_REQUEST')).toEqual(['G-5', 'การตัดสินใน LINE ของคำขอซื้อ', expect.stringMatching(/^\d+\.\d$/), '%', String(pr.numerator), String(pr.denominator), 'DECISIONS_ON_LINE_PURCHASE_REQUEST'])
    // times in business hours with one decimal, as the KPI page shows them (not h:mm)
    const decisionTime = rows.find((r) => r[6] === 'MEDIAN_DECISION_HOURS')!
    expect(decisionTime.slice(2, 4)).toEqual([expect.stringMatching(/^\d+\.\d$/), 'ชั่วโมงทำการ'])
    expect(Number(decisionTime[2]) * 60).toBeCloseTo(kpi.g3.decisionMedianMinutes!, -1)
    expect(await prisma.exportJob.findUniqueOrThrow({ where: { id: file.exportJobId } })).toMatchObject({ kind: 'REPORT', checksum: file.checksum, params: { reportCode: 'KPI', from: review.from, to: review.to, format: 'csv' } })
  })
})

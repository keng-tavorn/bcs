import { createHash, randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { exportAudit, searchAudit } from '@/server/services/audit'
import { pendingBoard, remindTask } from '@/server/services/board'
import { getDownloadUrl } from '@/server/services/files'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-10 (spec §11.1, §4.5, FR-VIS-001 AC1 AC2, FR-VIS-004 AC1–AC3): the board shows the open tasks per assignee with
// their age in business hours and how many are past their SLA, within what each viewer may see; a task can be
// reminded by hand once an hour per document. The AUDITOR searches the events and exports them with the DOA version,
// rule, channel and on whose behalf, and the file's checksum; the export is an event of its own.

const MONDAY = new Date('2026-10-05T02:00:00Z') // 09:00 Bangkok
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let budgetLineId: string
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' } })).id
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: MONDAY },
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: MONDAY },
      { organizationId: org.organizationId, memberId: org.member.ceo!, role: 'EXECUTIVE', grantedAt: MONDAY },
    ],
  })
})

/** A request submitted at `at`: under 20,000 it waits for the DM of CON, from 20,000 for the VP of OPS */
async function submitted(netBaht: string, at: Date, requester = 'req_con') {
  const draft = ok(await createDraft(org.ctxOf(requester, at), { requestTypeCode: 'BUY_GOODS', title: `ซื้อ ${netBaht}`, budgetLineId, lines: [{ description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice: netBaht }] }, key()))
  ok(await submitRequest(org.ctxOf(requester, at), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  return { requestId: draft.requestId, taskId: task.id }
}

describe('[FR-VIS-001/AC1] the board counts open tasks per person, their age in business hours and those past SLA, within the viewer scope', () => {
  it('rows for the DM and the VP; the requester sees their own documents only; PROCUREMENT sees everything', async () => {
    // Monday 09:00 and 10:00: two to the DM (SLA 8 business hours) and one to the VP
    await submitted('1000.00', MONDAY)
    const second = await submitted('2000.00', new Date('2026-10-05T03:00:00Z'))
    await submitted('30000.00', MONDAY)
    // the DM asks the requester about the second one: it waits for the requester
    ok(await requestInfo(org.ctxOf('dm_con', new Date('2026-10-05T04:00:00Z')), { taskId: second.taskId, question: 'ขอรายละเอียดเพิ่ม' }, key()))
    // Tuesday 11:00 Bangkok: the first task is 8.5 + 2.5 business hours old (08:30–17:30 days), past its SLA
    const now = new Date('2026-10-06T04:00:00Z')
    const board = ok(await pendingBoard(org.ctxOf('proc_officer', now)))
    const dm = board.find((r) => r.memberId === org.member.dm_con)!
    expect(dm).toMatchObject({ open: 1, waitingForRequester: 1, overdue: 1 })
    expect(dm.oldestMinutes).toBe(11 * 60)
    const vp = board.find((r) => r.memberId === org.member.vp_ops)!
    expect(vp).toMatchObject({ open: 1, waitingForRequester: 0 })
    // dm_con sees their own tasks; another member's documents stay hidden from the requester of others
    const mine = ok(await pendingBoard(org.ctxOf('dm_con', now)))
    expect(mine.map((r) => r.memberId)).toEqual([org.member.dm_con])
    const other = await submitted('500.00', MONDAY, 'asst_con')
    const requesterView = ok(await pendingBoard(org.ctxOf('req_con', now)))
    expect(requesterView.flatMap((r) => r.tasks.map((t) => t.subjectId))).not.toContain(other.requestId)
    expect(requesterView.flatMap((r) => r.tasks).length).toBeGreaterThan(0)
    // filtered by document type
    expect(ok(await pendingBoard(org.ctxOf('proc_officer', now), { subjectType: 'PURCHASE_ORDER' }))).toEqual([])
  })
})

describe('[FR-VIS-001/AC2] the board lists each person’s documents and reminds by hand at most once an hour per document', () => {
  it('reminds, refuses a second reminder within the hour, and reminds again after it', async () => {
    const t = await submitted('3000.00', MONDAY)
    const at = new Date('2026-10-05T05:00:00Z')
    const row = ok(await pendingBoard(org.ctxOf('proc_officer', at))).find((r) => r.memberId === org.member.dm_con)!
    expect(row.tasks.some((x) => x.taskId === t.taskId && x.label.startsWith('PR-'))).toBe(true)
    ok(await remindTask(org.ctxOf('proc_officer', at), { taskId: t.taskId }, key()))
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.reminder', subjectId: t.requestId } })).toMatchObject({ recipientMemberId: org.member.dm_con })
    expect(await remindTask(org.ctxOf('req_con', new Date('2026-10-05T05:30:00Z')), { taskId: t.taskId }, key())).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } })
    ok(await remindTask(org.ctxOf('req_con', new Date('2026-10-05T06:01:00Z')), { taskId: t.taskId }, key()))
    expect(await prisma.event.count({ where: { type: 'approval_task.reminded', aggregateId: t.taskId } })).toBe(2)
    // a task outside what the viewer may see is not found
    expect(await remindTask(org.ctxOf('fin_officer', new Date('2026-10-05T08:00:00Z')), { taskId: t.taskId }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-VIS-004/AC1] the AUDITOR searches events by document, actor, period, type and channel', () => {
  it('finds the decision of a request with its DOA reference, and only AUDITOR and ORG_ADMIN may search', async () => {
    const t = await submitted('4000.00', MONDAY)
    const decidedAt = new Date('2026-10-05T06:00:00Z')
    ok(await decideTask(org.ctxOf('dm_con', decidedAt, 'LINE_CHAT'), { taskId: t.taskId, decision: 'APPROVE' }, key()))
    const byDocument = ok(await searchAudit(org.ctxOf('auditor', decidedAt), { aggregateId: t.taskId }))
    // the task was assigned, then decided: newest first
    expect(byDocument.rows.map((r) => r.type)).toEqual(['approval_task.decided', 'approval_task.assigned'])
    expect(byDocument.rows[0]).toMatchObject({ channel: 'LINE_CHAT', doaRuleCode: 'PR-01', actorName: expect.any(String) })
    expect(byDocument.rows[0]!.doaVersionId).toBeTruthy()
    const filtered = ok(await searchAudit(org.ctxOf('admin', decidedAt), { actorMemberId: org.member.dm_con!, types: ['approval_task.decided'], channel: 'LINE_CHAT', from: '2026-10-05T05:00:00Z', to: '2026-10-05T07:00:00Z' }))
    expect(filtered.rows.map((r) => r.aggregateId)).toContain(t.taskId)
    expect(ok(await searchAudit(org.ctxOf('auditor', decidedAt), { actorMemberId: org.member.dm_con!, channel: 'WEB', types: ['approval_task.decided'], from: '2026-10-05T05:00:00Z', to: '2026-10-05T07:00:00Z' })).rows).toEqual([])
    for (const who of ['req_con', 'ceo', 'fin_officer']) expect(await searchAudit(org.ctxOf(who, decidedAt), {}), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // pages continue from the last row
    const page = ok(await searchAudit(org.ctxOf('auditor', decidedAt), {}, { limit: 2 }))
    expect(page.rows).toHaveLength(2)
    const next = ok(await searchAudit(org.ctxOf('auditor', decidedAt), {}, { limit: 2, beforeSeq: page.nextBeforeSeq! }))
    expect(BigInt(next.rows[0]!.seq) < BigInt(page.rows[1]!.seq)).toBe(true)
  })
})

describe('[FR-VIS-004/AC2] [FR-VIS-004/AC3] the AUDITOR exports with the DOA reference, channel and on-behalf-of, a checksum and an event', () => {
  it('writes the file the search shows, records audit.exported, and refuses the CEO (ADR-038 ข้อ 5)', async () => {
    const t = await submitted('5000.00', MONDAY)
    const at = new Date('2026-10-05T07:00:00Z')
    ok(await decideTask(org.ctxOf('dm_con', at), { taskId: t.taskId, decision: 'APPROVE' }, key()))
    const filter = { aggregateId: t.taskId, types: ['approval_task.decided'] }
    for (const who of ['ceo', 'admin']) expect(await exportAudit(org.ctxOf(who, at), { filter }, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const exported = ok(await exportAudit(org.ctxOf('auditor', at), { filter, format: 'xlsx' }, key()))
    expect(exported.rowCount).toBe(1)
    const url = ok(await getDownloadUrl(org.ctxOf('auditor', at), { fileId: exported.fileId })).url
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(exported.checksum)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes.buffer as ArrayBuffer)
    const rows: string[][] = []
    workbook.worksheets[0]!.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ''))))
    expect(rows[0]).toEqual(['seq', 'occurredAt', 'type', 'aggregateType', 'aggregateId', 'actorType', 'actor', 'onBehalfOf', 'channel', 'doaVersionId', 'doaRuleCode', 'data'])
    expect(rows[1]).toEqual(expect.arrayContaining(['approval_task.decided', t.taskId, 'WEB', 'PR-01']))
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'audit.exported', aggregateId: exported.exportJobId } })).toMatchObject({ actorMemberId: org.member.auditor, data: { rowCount: 1, checksum: exported.checksum } })
    expect(await prisma.exportJob.findUniqueOrThrow({ where: { id: exported.exportJobId } })).toMatchObject({ kind: 'AUDIT', rowCount: 1, checksum: exported.checksum })
    expect(await getDownloadUrl(org.ctxOf('ceo', at), { fileId: exported.fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

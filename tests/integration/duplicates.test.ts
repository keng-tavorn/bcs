import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { approvalCardMessage } from '@/server/line/postback-cards'
import { createDraft, submitRequest } from '@/server/services/requests'
import { listRequestFlags } from '@/server/services/requests/duplicates'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S6-13 (FR-INT-103 · BR-DUP-01 to BR-DUP-05 · OQ-103): duplicates and splits at the submit against Postgres, on the
// fixture's DOA-DEMO version 1 (GROSS; PR-01 up to 20,000.00, PR-02 above). A request like one the same requester sent
// yesterday needs a reason, on the web and from LIFF alike; given, it is sent with a DUPLICATE flag and the route is the
// one it would have had anyway. Two requests of one department and supplier that together reach PR-02 get a SPLIT flag
// without blocking. The approver reads the flags; the LINE card says so in a few words, naming nothing bought.

const YESTERDAY = new Date('2026-10-05T03:00:00Z')
const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let budgetLineId: string
let supplier: string

async function draft(title: string, line: { description: string; quantity: string; unitPrice: string }, at: Date, withSupplier = false) {
  return ok(
    await createDraft(
      org.ctxOf('req_con', at),
      { requestTypeCode: 'BUY_GOODS', title, budgetLineId, ...(withSupplier ? { suggestedSupplierId: supplier } : {}), lines: [{ ...line, uom: 'กก.' }] },
      key(),
    ),
  ).requestId
}
const routeOf = (requestId: string) => prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: requestId }, select: { ruleCode: true, routeNo: true } })

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW } })
  budgetLineId = await p2p(org, YESTERDAY).fundedLine(1_000_000n)
  supplier = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-DUP', nameTh: 'ผู้ขายเหล็ก', isForeign: true } })).id
})

describe('[FR-INT-103/AC1] [FR-INT-103/AC2] a duplicate needs a reason, on every channel; the route does not change (GC-DUP-01)', () => {
  it('refused without a reason on the web and from LIFF, sent with one with a DUPLICATE flag of its route', async () => {
    const first = await draft('ลวดผูกเหล็ก รอบแรก', { description: 'ลวดผูกเหล็ก', quantity: '500', unitPrice: '62.00' }, YESTERDAY)
    ok(await submitRequest(org.ctxOf('req_con', YESTERDAY), { requestId: first }, key()))
    const again = await draft('ลวดผูกเหล็ก อีกครั้ง', { description: '  ลวดผูกเหล็ก ', quantity: '500', unitPrice: '62.00' }, NOW)
    for (const channel of ['WEB', 'LIFF'] as const) {
      expect(await submitRequest(org.ctxOf('req_con', NOW, channel), { requestId: again }, key()), channel).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', details: { reason: 'DUPLICATE_UNACKNOWLEDGED', field: 'duplicateReason', matched: [{ id: first }] } },
      })
    }
    expect(await prisma.request.findUniqueOrThrow({ where: { id: again } })).toMatchObject({ status: 'DRAFT' })
    ok(await submitRequest(org.ctxOf('req_con', NOW, 'LIFF'), { requestId: again, duplicateReason: 'ของรอบแรกไม่พอใช้ หน้างานเพิ่ม' }, key()))
    const flag = await prisma.requestFlag.findFirstOrThrow({ where: { requestId: again } })
    expect(flag).toMatchObject({ kind: 'DUPLICATE', matchedRequestIds: [first], routeNo: (await routeOf(again)).routeNo, acknowledgedReason: 'ของรอบแรกไม่พอใช้ หน้างานเพิ่ม', acknowledgedById: org.member.req_con })
    // Same rule as the first one of the same amount: a flag never reroutes (OQ-103)
    expect((await routeOf(again)).ruleCode).toBe((await routeOf(first)).ruleCode)
    expect(await prisma.event.findFirst({ where: { type: 'request.flagged', aggregateId: again } })).toMatchObject({ data: { kind: 'DUPLICATE', matchedRequestIds: [first] } })
    expect(await prisma.notification.count({ where: { templateKey: 'audit.request_flagged', recipientMemberId: org.member.auditor!, subjectId: again } })).toBe(1)
  })
})

describe('[FR-INT-103/AC1] [FR-INT-103/AC3] a split is flagged without blocking, and the approver sees it (GC-DUP-05)', () => {
  it('two requests of one department and supplier together past 20,000.00: SPLIT on the second, PR-01 kept; the card says so briefly', async () => {
    const first = await draft('ไม้อัด ชุดแรก', { description: 'ไม้อัดยางทำแบบหล่อ 10 มม.', quantity: '46', unitPrice: '395.00' }, YESTERDAY, true)
    ok(await submitRequest(org.ctxOf('req_con', YESTERDAY), { requestId: first }, key()))
    const second = await draft('ไม้อัด ชุดสอง', { description: 'ไม้อัดยางทำแบบหล่อ 10 มม.', quantity: '47', unitPrice: '395.00' }, NOW, true)
    ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: second }, key()))
    expect((await routeOf(second)).ruleCode).toBe('PR-01')
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: second } } } })
    const assignee = Object.entries(org.member).find(([, id]) => id === task.assigneeMemberId)![0]
    const flags = ok(await listRequestFlags(org.ctxOf(assignee, NOW), second))
    expect(flags).toEqual([expect.objectContaining({ kind: 'SPLIT', matched: [expect.objectContaining({ id: first })], individualRule: 'PR-01', combinedRule: 'PR-02', reason: null })])
    const card = JSON.stringify(await approvalCardMessage(org.organizationId, { taskId: task.id, memberId: task.assigneeMemberId, fallbackLabel: 'x' }, NOW, { locale: 'th', liffId: null, appUrl: 'https://bcs.test' }))
    expect(card).toContain('อาจแตกยอดเลี่ยงวงเงิน')
    expect(card).not.toContain('ไม้อัด')
    // The AUDITOR reads every request; someone without request.view of it is refused
    expect(await listRequestFlags(org.ctxOf('auditor', NOW), second)).toMatchObject({ ok: true })
    expect(await listRequestFlags(org.ctxOf('dm_it', NOW), second)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

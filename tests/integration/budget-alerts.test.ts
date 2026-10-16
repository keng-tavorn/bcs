import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { prisma } from '@/server/db/client'
import { budgetDashboard } from '@/server/services/budget/dashboard'
import { runBudgetAlerts } from '@/server/services/budget/alerts'
import { runDailyDigest, type DigestData } from '@/server/services/sla'
import type { DoaOrg } from '../support/doa-org'
import { createP1Org } from '../support/p1-org'
import { p2p } from '../support/p2p'

// S6-18 (FR-BUD-104 · BR-BUD-17 · OQ-113): budget alerts against Postgres. A CON line of 1,000,000.00 with a PO of
// 950,000.00 has used 95% (USED_8000) and has 5% left (low under the demo's 10%). The job raises each alert once per
// line, alert and fiscal year — a second run raises nothing; the dashboard shows the burn of the line, the department
// and the total; the daily summary names the line once with both reasons to the CON department head, and to the
// BUDGET_ADMIN (budget lines only, no approvals).

const NOW = new Date('2026-10-06T03:00:00Z')
let org: DoaOrg
let line: string
let code: string

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP1Org({ modules: [] })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
  const flow = p2p(org, NOW)
  line = await flow.fundedLine(1_000_000n)
  code = (await prisma.budgetLine.findUniqueOrThrow({ where: { id: line } })).code
  const request = await flow.approvedRequest(line, [{ quantity: '1', unitPrice: '950000.00' }])
  const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012' } })
  await flow.approvedPo(request.lines.map((l) => l.id), supplier.id)
}, 120_000)

describe('[FR-BUD-104/AC1] [FR-BUD-104/AC2] budget alerts once per line, alert and fiscal year', () => {
  it('raises USED_8000 once; the job run again raises nothing', async () => {
    const first = await runBudgetAlerts(org.organizationId, NOW)
    expect(first.ok).toBe(true)
    const raised = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'budget.alert_raised', aggregateId: line } })
    const alerts = raised.map((e) => (e.data as { alert: string }).alert)
    expect(alerts).toContain('USED_8000')
    expect(alerts).not.toContain('USED_10000')
    expect(raised.find((e) => (e.data as { alert: string }).alert === 'USED_8000')?.data).toMatchObject({ usedBp: 9500 })
    // Again the next day: nothing new
    expect(await runBudgetAlerts(org.organizationId, new Date(NOW.getTime() + 86_400_000))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'budget.alert_raised', aggregateId: line } })).toBe(raised.length)
  })

  it('the dashboard shows the burn of the line, its department and the total', async () => {
    const board = await budgetDashboard(org.ctxOf('fin_officer', NOW))
    if (!board.ok) throw new Error(JSON.stringify(board.error))
    const shown = board.data.lines.find((l) => l.id === line)!
    expect(shown.burn).toMatchObject({ usedBp: 9500 })
    expect(shown.burn.alerts).toContain('USED_8000')
    // A department and the total are burned on their own sums (BR-BUD-17): floor((committed + actual) × 10000 ÷ funded)
    const burnOf = (f: { planned: { amount: string }; committed: { amount: string }; actual: { amount: string } }) => {
      const satang = (m: { amount: string }) => BigInt(m.amount.replace('.', ''))
      return Number(((satang(f.committed) + satang(f.actual)) * 10_000n) / satang(f.planned))
    }
    const con = board.data.departments.find((d) => d.id === org.department.CON)!
    expect(con.burn.usedBp).toBe(burnOf(con))
    expect(board.data.total.burn.usedBp).toBe(burnOf(board.data.total))
  })

  it('the daily summary names the line once with every reason: the CON head, and the BUDGET_ADMIN without approvals', async () => {
    const sent = await runDailyDigest(org.organizationId, NOW)
    expect(sent.reason).toBeNull()
    const digestOf = async (member: string) =>
      (await prisma.notification.findFirstOrThrow({ where: { organizationId: org.organizationId, templateKey: 'digest.daily', recipientMemberId: org.member[member]! } })).data as unknown as DigestData
    const head = await digestOf('dm_con')
    const flags = head.scope!.budgetLineFlags.filter((f) => f.code === code)
    expect(flags).toHaveLength(1)
    expect(flags[0]!.reasons).toEqual(expect.arrayContaining(['LOW', 'USED_8000']))
    expect(head.scope).toMatchObject({ kind: 'DEPT', lowBudgetLines: 1 })
    const admin = await digestOf('fin_officer')
    expect(admin.scope).toMatchObject({ kind: 'BUDGET', pending: 0, overdue: 0 })
    expect(admin.scope!.budgetLineFlags.map((f) => f.code)).toContain(code)
  })
})

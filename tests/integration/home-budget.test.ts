import { randomUUID } from 'node:crypto'
import { createTranslator } from 'next-intl'
import { beforeAll, describe, expect, it } from 'vitest'
import type { HomeBudgetView } from '@/app/(workspace)/_tracking/home-budget'
import { loadHomeBudget } from '@/app/(workspace)/_tracking/home-budget-load'
import type { HomeT } from '@/app/(workspace)/_tracking/pool-row'
import type { BudgetsT } from '@/app/(workspace)/budgets/_present'
import { reserve } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import th from '../../messages/th.json'

// §9.1 "/" (D-05 round 5): the home's budget summary reads the dashboard of /budgets — the same service, the same
// figures — within the member's budget.view scope, decided on the server with the departments the member heads: an
// organization-wide role (EXECUTIVE, AUDITOR …) sees what is left in the whole organization and every line running low;
// a department head what is left in the departments they head and their lines only, never another department's line
// even when it runs low; a member without budget.view (a requester, procurement) gets no summary at all. Every amount
// leads to what makes it up within that scope. Real Postgres (ADR-027): the organization of tests/support/doa-org.ts,
// whose seven departments each have one line of 10,000,000.00 baht; IT's runs low and PROC's is used up here.

const NOW = new Date('2026-10-06T03:00:00Z')
const t = createTranslator({ locale: 'th', messages: th, namespace: 'home' }) as unknown as HomeT
const tb = createTranslator({ locale: 'th', messages: th, namespace: 'budgets' }) as unknown as BudgetsT

let org: DoaOrg
let fiscalYearId: string
const lineOf: Record<string, string> = {}

/** A reservation written through the ledger, as a request's submission would: `satang` held on the line */
async function reserveOn(budgetLineId: string, satang: bigint) {
  const ctx = systemCtx(org.organizationId, NOW, 'seed')
  const requestId = randomUUID()
  await forTenant(org.organizationId).$transaction(async (tx) => {
    const r = await applyBudget(tx, ctx, [{ budgetLineId, document: { type: 'REQUEST' as const, id: requestId }, run: (s) => reserve(s, [{ requestLineId: randomUUID(), amount: satang }]) }])
    if (!r.ok) throw new Error(r.error.code)
    await appendEvents(tx, ctx, r.events)
  })
}

const summaryOf = async (member: string) => loadHomeBudget(org.ctxOf(member, NOW), t, tb)

function figures(view: HomeBudgetView | null) {
  if (view?.kind !== 'FIGURES') throw new Error(`expected the budget's figures, got ${view ? view.kind : 'no summary'}`)
  return view
}

beforeAll(async () => {
  org = await createDoaOrg()
  const organizationId = org.organizationId
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId, memberId: org.member.ceo!, role: 'EXECUTIVE', grantedAt: NOW },
      { organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW },
    ],
  })
  const lines = await prisma.budgetLine.findMany({ where: { organizationId }, select: { id: true, code: true, fiscalYearId: true } })
  for (const l of lines) lineOf[l.code] = l.id
  fiscalYearId = lines[0]!.fiscalYearId
  // IT's line runs low (500,000.00 of 10,000,000.00 left, 5 %), PROC's is used up (nothing left)
  await reserveOn(lineOf['IT-OPEX-2569']!, 950_000_000n)
  await reserveOn(lineOf['PROC-OPEX-2569']!, 1_000_000_000n)
}, 120_000)

describe('[§9.1] [FR-BUD-005/AC1] the home’s budget summary is the member’s budget.view scope of /budgets', () => {
  it('an organization-wide role: what is left in the whole organization, and every line running low or used up', async () => {
    for (const member of ['ceo', 'auditor']) {
      const view = figures(await summaryOf(member))
      expect(view.scopeLine, member).toBe(`ปีงบ FY2569 · ${tb('scope.ORG')}`)
      // Seven lines of 10,000,000.00, less 9,500,000.00 held on IT's and 10,000,000.00 on PROC's
      expect(view.planned.text, member).toBe('งบตั้งต้น 70,000,000.00 บาท')
      expect(view.available, member).toEqual({ text: '50,500,000.00', href: `/budgets/total?fy=${fiscalYearId}#movements`, label: tb('table.availableLink', { amount: '50,500,000.00', code: tb('scope.ORG') }) })
      expect(view.low.map((l) => [l.title, l.warning, l.out]), member).toEqual([
        ['IT-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน IT', tb('low.badge', { left: '5.0' }), false],
        ['PROC-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน PROC', tb('low.out', { amount: '0.00' }), true],
      ])
    }
  })

  it('a department head: what is left in the departments they head, and their own lines only, each leading to its page', async () => {
    const head = figures(await summaryOf('dm_it'))
    expect(head.scopeLine).toBe(`ปีงบ FY2569 · ${tb('scope.DEPT')}`)
    expect(head.totalLabel).toBe(tb('table.total.DEPT'))
    expect(head.planned.text).toBe('งบตั้งต้น 10,000,000.00 บาท')
    expect(head.available.text).toBe('500,000.00')
    const itLine = lineOf['IT-OPEX-2569']!
    expect(head.low).toEqual([
      {
        id: itLine,
        title: 'IT-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน IT',
        href: `/budgets/${itLine}`,
        warning: tb('low.badge', { left: '5.0' }),
        out: false,
        available: { text: '500,000.00', href: `/budgets/${itLine}#movements`, label: tb('table.availableLink', { amount: '500,000.00', code: 'IT-OPEX-2569' }) },
      },
    ])
    // The VP of OPS heads OPS, CON and PROC: PROC's line used up is theirs, IT's running low is not
    const ops = figures(await summaryOf('vp_ops'))
    expect(ops.available.text).toBe('20,000,000.00')
    expect(ops.low.map((l) => l.id)).toEqual([lineOf['PROC-OPEX-2569']])
  })

  it('a head whose lines all have room sees none of the others’ lines running low, and says so', async () => {
    const con = figures(await summaryOf('dm_con'))
    expect(con.available.text).toBe('10,000,000.00')
    expect(con.low).toEqual([])
    expect(con.noneLow).toBe('ยังไม่มีบรรทัดงบที่ใกล้หมด')
  })

  it('no summary for a member without budget.view: a requester, procurement — the page shows them no budget at all', async () => {
    expect(await summaryOf('req_con')).toBeNull()
    expect(await summaryOf('proc_officer')).toBeNull()
  })
})

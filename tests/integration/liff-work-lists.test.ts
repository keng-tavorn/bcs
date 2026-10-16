import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { countPoolLines } from '@/server/services/procurement/pool-view'
import { PROCUREMENT_SUMMARY_PO_STATUSES, procurementSummary } from '@/server/services/procurement/summary'
import { listReceivable } from '@/server/services/receiving/view'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S17-04 · the services behind the pages the rich menu's role buttons open (FR-LINE-303 AC3 AC4), as LIFF calls them
// (channel LIFF): /liff/procurement reads procurementSummary, which checks procurement.pool.view itself — PROCUREMENT
// gets the numbers of the pool and the POs, anyone else FORBIDDEN and no number; /liff/gr reads the web's listReceivable,
// so someone without gr.post is told they receive nothing (an empty list). The page tests: tests/e2e/liff-work-lists.spec.ts.

const NOW = new Date('2026-10-06T03:00:00Z')
let org: DoaOrg

beforeAll(async () => {
  org = await createDoaOrg()
})

describe('[FR-LINE-303/AC4] /liff/procurement: numbers for PROCUREMENT only, checked in the service', () => {
  it('PROCUREMENT gets the pool count of /procurement/pool and the POs at each step', async () => {
    const summary = await procurementSummary(org.ctxOf('proc_officer', NOW, 'LIFF'))
    if (!summary.ok) throw new Error(JSON.stringify(summary.error))
    expect(summary.data.poolLines).toBe(await countPoolLines(org.ctxOf('proc_officer', NOW, 'LIFF')))
    expect(summary.data.urgentLines).toBeLessThanOrEqual(summary.data.poolLines)
    for (const status of PROCUREMENT_SUMMARY_PO_STATUSES) {
      expect(summary.data.posByStatus[status], status).toBe(await prisma.purchaseOrder.count({ where: { organizationId: org.organizationId, status } }))
    }
  })

  it.each(['req_con', 'receiver_con', 'dm_con', 'auditor'])('%s without procurement.pool.view: FORBIDDEN and no number', async (code) => {
    expect(await procurementSummary(org.ctxOf(code, NOW, 'LIFF'))).toEqual({ ok: false, error: expect.objectContaining({ code: 'FORBIDDEN' }) })
  })
})

describe('[FR-LINE-303/AC3] /liff/gr: the receiving list of gr.post, the same on LIFF as on the web', () => {
  it('a receiver receives; a requester of another department without gr.post receives nothing, an empty list', async () => {
    const receiver = await listReceivable(org.ctxOf('receiver_con', NOW, 'LIFF'))
    expect(receiver).toMatchObject({ ok: true, data: { receives: true } })
    expect(await listReceivable(org.ctxOf('receiver_con', NOW, 'WEB'))).toEqual(receiver)
    const none = await listReceivable(org.ctxOf('fin_officer', NOW, 'LIFF'))
    if (!none.ok) throw new Error(JSON.stringify(none.error))
    expect(none.data.rows).toEqual([])
    expect(none.data.blocked).toEqual([])
  })
})

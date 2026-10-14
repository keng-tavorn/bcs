import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { approvalCardMessage } from '@/server/line/postback-cards'
import { getPriceReference } from '@/server/services/price-reference'
import { createDraft, submitRequest } from '@/server/services/requests'
import { manageFollowers } from '@/server/services/requests/followers'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S6-11 (FR-DOA-101 · BR-PRC-01 to BR-PRC-07 · OQ-107 OQ-116): the price reference of a request against Postgres. Three
// POs of "สว่านไฟฟ้า" approved in the last days are its samples; a request at 2,700.00 against their median of 2,400.00
// is HIGH by 12.5%. Its approver and PROCUREMENT read the panel; the requester, a follower and the head of the paying
// department who has no task are refused. The approver's LINE card carries one price badge with counts and percents
// only — no item, no unit price.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let requestId: string
const DRILL = 'สว่านไฟฟ้า 18V'

beforeAll(async () => {
  org = await createDoaOrg()
  // An ORG_ADMIN reads every request, so may follow it, and still has no price reference
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const supplier = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-PRC', nameTh: 'ผู้ขายเครื่องมือ', isForeign: true } })).id
  for (const [day, price] of [
    ['2026-10-01T03:00:00Z', '2400.00'],
    ['2026-10-02T03:00:00Z', '2380.00'],
    ['2026-10-03T03:00:00Z', '2450.00'],
  ] as const) {
    const kit = p2p(org, new Date(day))
    const line = await kit.fundedLine(100_000n)
    const request = await kit.approvedRequest(line, [{ quantity: '1', unitPrice: price, description: DRILL }])
    await kit.approvedPo(request.lines.map((l) => l.id), supplier)
  }
  const line = await p2p(org, NOW).fundedLine(100_000n)
  const draft = ok(
    await createDraft(
      org.ctxOf('req_con', NOW),
      {
        requestTypeCode: 'BUY_GOODS',
        title: 'เครื่องมือช่าง',
        budgetLineId: line,
        lines: [
          { description: DRILL, quantity: '2', uom: 'ชิ้น', unitPrice: '2700.00' },
          { description: 'ตลับเมตร 5 ม.', quantity: '3', uom: 'อัน', unitPrice: '150.00' },
        ],
      },
      key(),
    ),
  )
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  requestId = draft.requestId
  ok(await manageFollowers(org.ctxOf('req_con', NOW), { requestId, memberId: org.member.admin!, follow: true }, key()))
}, 300_000)

describe('[FR-DOA-101/AC1] the price reference of each line', () => {
  it('the drill against three approved POs: lower median 2,400.00, HIGH by 1,250 Bp; a line never bought has few samples', async () => {
    const ref = ok(await getPriceReference(org.ctxOf('dm_con', NOW), { requestId }))
    expect(ref.lines[0]).toMatchObject({ count: 3, minSatang: '238000', medianSatang: '240000', maxSatang: '245000', lastSatang: '245000', status: 'OK', deviationBp: 1250, alert: 'HIGH' })
    expect(ref.lines[1]).toMatchObject({ count: 0, medianSatang: null, status: 'FEW_SAMPLES', deviationBp: null, alert: null })
    expect(ref.badge).toEqual({ high: { lines: 1, maxPct: 12 }, low: null })
    // PROCUREMENT reads every PO, so it reads the panel too
    expect((await getPriceReference(org.ctxOf('proc_officer', NOW), { requestId })).ok).toBe(true)
  })
})

describe('[FR-DOA-101/AC3] who may read it (BR-PRC-07 · OQ-116)', () => {
  it('the requester, a follower and the head of the paying department without a task are refused', async () => {
    for (const code of ['req_con', 'admin', 'vp_ops']) {
      expect(await getPriceReference(org.ctxOf(code, NOW), { requestId }), code).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await getPriceReference(org.ctxOf('dm_con', NOW), { requestId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-DOA-101/AC2] the LINE card carries one price badge, counts and percents only (BR-PRC-05)', () => {
  it('the approver\'s card says one line is above the past median by up to 12% and names no item and no unit price', async () => {
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })
    const card = await approvalCardMessage(org.organizationId, { taskId: task.id, memberId: task.assigneeMemberId, fallbackLabel: 'x' }, NOW, { locale: 'th', liffId: null, appUrl: 'https://bcs.test' })
    const json = JSON.stringify(card)
    expect(json).toContain('สูงกว่าค่ากลางย้อนหลัง 1 รายการ สูงสุด +12%')
    expect(json.match(/ค่ากลางย้อนหลัง/g)).toHaveLength(1)
    for (const words of [DRILL, 'ตลับเมตร', '2,700', '2700', '150.00', '2,400']) expect(json, words).not.toContain(words)
  })
})

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { positionHasAuthority } from '@/server/doa/policy'
import { listPurchaseOrders } from '@/server/queries/purchase-orders'
import { listMyRequests } from '@/server/queries/requests'
import { issuedDocumentNumbers } from '@/server/queries/settings'
import { searchSuppliers } from '@/server/queries/suppliers'
import { txNumberingReader } from '@/server/services/numbering/admin'
import { assignHolder, endHolder } from '@/server/services/org-structure'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// Prisma 7 puts the value of startsWith, contains and endsWith into a LIKE (ILIKE) pattern without escaping it, so a `_`
// matched any one character and a `%` any text (src/server/db/like.ts). Against Postgres, the paths that filter so find
// the text as it is written: the open tasks of a position (BR-DOA-17), the search boxes of the supplier register, of my
// requests and of the purchase orders, and the issued numbers a numbering rule is checked against (FR-ADM-004 AC3). That
// every such filter in src escapes its value is tests/unit/like-escape.test.ts.

const NOW = new Date('2026-10-05T03:00:00Z')
const HELD_SINCE = new Date('2026-01-05T03:00:00Z')
const NEXT_DAY = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
})

const admin = () => org.ctxOf('admin', NOW)
const inTx = <T>(run: (tx: TenantTx) => Promise<T>) => forTenant(org.organizationId).$transaction(run)

/** A draft request of the member with this title */
async function draft(code: string, title: string): Promise<string> {
  const made = await createDraft(org.ctxOf(code, NOW), { requestTypeCode: 'BUY_GOODS', title, priceIncludesVat: true, lines: [{ description: title, quantity: '1', uom: 'ชิ้น', unitPrice: '300.00' }] }, key())
  if (!made.ok) throw new Error(`draft failed: ${made.error.code}`)
  return made.data.requestId
}

describe('[BR-DOA-17] [FR-ADM-002/AC2] a position whose code has `_` is that position only', () => {
  it('open tasks of another position, whose code has another character there, give it no authority: its holder changes at once', async () => {
    // YARD_LEAD and YARDXLEAD of CON, held since the start of the year; open tasks came from YARDXLEAD only
    for (const code of ['YARD_LEAD', 'YARDXLEAD']) {
      const position = await prisma.position.create({ data: { organizationId: org.organizationId, code, nameTh: `ตำแหน่ง ${code}`, scope: 'DEPARTMENT' } })
      await prisma.positionAssignment.create({ data: { organizationId: org.organizationId, positionId: position.id, departmentId: org.department.CON!, memberId: org.member.asst_con!, validFrom: HELD_SINCE } })
    }
    const requestId = await draft('req_con', 'ถุงมือผ้า')
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({ ok: true })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })
    // A task an earlier DOA version gave the YARDXLEAD of CON (BR-DOA-13 keeps it on that route)
    await prisma.approvalTask.update({ where: { id: task.id }, data: { resolvedFrom: 'POSITION:YARDXLEAD@CON', assigneeMemberId: org.member.asst_con! } })

    expect(await inTx((tx) => positionHasAuthority(tx, 'YARDXLEAD', NOW))).toBe(true)
    expect(await inTx((tx) => positionHasAuthority(tx, 'YARD_LEAD', NOW))).toBe(false)
    // YARD_LEAD carries no authority: its holder changes at once, both ways (FR-ADM-002 AC2)
    expect(await assignHolder(admin(), { positionCode: 'YARD_LEAD', departmentId: org.department.CON!, memberId: org.member.receiver_con! }, key())).toMatchObject({ ok: true })
    expect(await endHolder(org.ctxOf('admin', NEXT_DAY), { positionCode: 'YARD_LEAD', departmentId: org.department.CON! }, key())).toMatchObject({ ok: true })
    // YARDXLEAD does: its open task must follow the new holder, through an authority change (BR-DOA-17)
    expect(await assignHolder(admin(), { positionCode: 'YARDXLEAD', departmentId: org.department.CON!, memberId: org.member.receiver_con! }, key())).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', details: { reason: 'USE_ORG_AUTHORITY_CHANGE', kind: 'POSITION_ASSIGN' } },
    })
  })
})

describe('[S4-02] the supplier register’s search finds `%`, `_` and `\\` as they are typed', () => {
  it('a search for them finds only the suppliers whose name or code holds them, and a plain search finds as before', async () => {
    const suppliers = [
      ['LK-1', 'ค้นทดสอบ ลด 50% ทุกชิ้น'],
      ['LK-2', 'ค้นทดสอบ เลข 500 ทุกชิ้น'],
      ['LK_3', 'ค้นทดสอบ ขีดล่าง'],
      ['LKX3', 'ค้นทดสอบ เอ็กซ์'],
      ['LK-5', 'ค้นทดสอบ C:\\คลัง'],
    ] as const
    for (const [i, [code, nameTh]] of suppliers.entries()) {
      await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh, taxId: '0999999000012', branchCode: String(i + 1).padStart(5, '0') } })
    }
    const found = async (q: string) => (await searchSuppliers(admin(), { q })).rows.map((r) => r.code).sort()
    expect(await found('50%')).toEqual(['LK-1'])
    expect(await found('%')).toEqual(['LK-1'])
    expect(await found('LK_')).toEqual(['LK_3'])
    expect(await found('_')).toEqual(['LK_3'])
    expect(await found('\\')).toEqual(['LK-5'])
    expect(await found('ค้นทดสอบ')).toEqual(['LK-1', 'LK-2', 'LK-5', 'LKX3', 'LK_3'].sort())
    expect((await searchSuppliers(admin(), { q: '%' })).matched).toBe(1)
  })
})

describe('[§9.1] my requests: the search finds `%` and `_` as they are typed', () => {
  it('a search for them finds only the requests whose title holds them, and a plain search finds as before', async () => {
    const titles = ['ค่าขนส่งลด 50% เดือนนี้', 'ค่าขนส่ง 500 บาท', 'ท่อ_PVC สี่หุน', 'ท่อXPVC สี่หุน']
    for (const title of titles) await draft('fin_officer', title)
    const found = async (q: string) => (await listMyRequests(org.ctxOf('fin_officer', NOW), { q })).rows.map((r) => r.title).sort()
    expect(await found('50%')).toEqual(['ค่าขนส่งลด 50% เดือนนี้'])
    expect(await found('%')).toEqual(['ค่าขนส่งลด 50% เดือนนี้'])
    expect(await found('ท่อ_')).toEqual(['ท่อ_PVC สี่หุน'])
    expect(await found('_')).toEqual(['ท่อ_PVC สี่หุน'])
    expect(await found('ค่าขนส่ง')).toEqual(['ค่าขนส่ง 500 บาท', 'ค่าขนส่งลด 50% เดือนนี้'].sort())
    expect((await listMyRequests(org.ctxOf('fin_officer', NOW), { q: '_' })).matched).toBe(1)
  })
})

describe('[§9.1] the purchase orders: the search finds `%` and `_` as they are typed', () => {
  it('finds no PO for them while no number, supplier name or code holds them; one that does is found', async () => {
    const kit = p2p(org, NOW)
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-PO', nameTh: 'ผู้ขายท่อประปา', taxId: '0999999000012', branchCode: '00099' } })
    const request = await kit.approvedRequest(await kit.fundedLine(100_000n), [{ quantity: '1', unitPrice: '1000.00' }])
    const po = await kit.approvedPo([request.lines[0]!.id], supplier.id)
    const matched = async (q: string) => (await listPurchaseOrders(org.ctxOf('proc_officer', NOW), { q })).matched
    expect(await matched(po.number!)).toBe(1)
    expect(await matched('%')).toBe(0)
    expect(await matched('_')).toBe(0)
    await prisma.supplier.update({ where: { id: supplier.id }, data: { nameTh: 'ผู้ขายท่อประปา ลด 100%' } })
    expect(await matched('%')).toBe(1)
    expect(await matched('_')).toBe(0)
  })
})

describe('[FR-ADM-004/AC3] the numbers a numbering rule is checked against hold its texts as they are written', () => {
  it('a `_` or `%` of a prefix or a suffix finds numbers with that very character there, in the query and in the save command’s reader', async () => {
    // Request.number holds PR and RQ: numbers of drafts, set here as an earlier pattern would have issued them
    const numbers = ['PR_69-0001', 'PRX69-0001', 'PR_69-0002_A', 'PR_69-0003XA', 'PR%69-0004', 'PR-69-0005']
    for (const number of numbers) await prisma.request.update({ where: { id: await draft('dm_it', `เลขที่ ${number}`) }, data: { number } })
    const issued = async (around: Array<{ prefix: string; suffix: string }>) => (await issuedDocumentNumbers(admin(), 'PR', around)).filter((n) => numbers.includes(n)).sort()
    expect(await issued([{ prefix: 'PR_69-', suffix: '' }])).toEqual(['PR_69-0001', 'PR_69-0002_A', 'PR_69-0003XA'])
    expect(await issued([{ prefix: 'PR_', suffix: '_A' }])).toEqual(['PR_69-0002_A'])
    expect(await issued([{ prefix: 'PR%', suffix: '' }])).toEqual(['PR%69-0004'])
    expect(await issued([{ prefix: 'PR', suffix: '' }])).toEqual([...numbers].sort())
    const inSave = await inTx((tx) => txNumberingReader(tx).issuedNumbers('PR', [{ prefix: 'PR_', suffix: '_A' }]))
    expect(inSave.filter((n) => numbers.includes(n))).toEqual(['PR_69-0002_A'])
  })
})

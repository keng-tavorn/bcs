import { createHash, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { purchaseOrderPrintable, requestPrintable } from '@/server/services/documents/pdf'
import { printedContentSha256, verifyDocument, verifyPage, VERIFY_RATE_PER_WINDOW } from '@/server/services/documents/verification'
import { cancelPurchaseOrder } from '@/server/services/purchase-orders'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'
import { stepUpForTask } from '../support/pin'
import { createDraft, editRequest, resubmitRequest, submitRequest } from '../support/requests'

// S6-19 (FR-DOA-102 · BR-QR-01 BR-QR-02 · ADR-109 · OQ-112): the verification QR of printed PRs and POs against Postgres.
// Sending a request issues a DocumentVerification row; its PDF prints the QR of that row's token, the same every time;
// the row keeps only sha256 of the token. Sending again with the same printed content issues nothing; after a change it
// issues a new row and the old token says a newer version exists. The public reading names the organization, the kind,
// the number and the current status — no amount, no person — and a wrong token reads as not found. Neither a PDF nor
// the reading adds or changes a row of the organization (every table, counted and hashed before and after). A PO
// cancelled shows CANCELLED at once.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const tokenOf = (url: string | null | undefined) => url!.split('/verify/')[1]!

let org: DoaOrg

/**
 * Every row of the organization in every table that has an organizationId column: its count and a hash of its rows.
 * (Tables of no organization belong to the other test files running alongside: the limiter's count, sessions.)
 */
async function snapshot(organizationId: string): Promise<Record<string, string>> {
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organizationId' ORDER BY table_name`,
  )
  const out: Record<string, string> = {}
  for (const { table_name } of tables) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: number; h: string | null }>>(
      `SELECT count(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM "${table_name}" t WHERE "organizationId" = $1::uuid`,
      organizationId,
    )
    out[table_name] = `${row!.n}:${row!.h ?? ''}`
  }
  return out
}

async function submitted(requester: string, unitPrice: string) {
  const draft = ok(await createDraft(org.ctxOf(requester, NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุงานโครงการ', lines: [{ description: 'ปูนซีเมนต์', quantity: '10', uom: 'ถุง', unitPrice }] }, key()))
  ok(await submitRequest(org.ctxOf(requester, NOW), { requestId: draft.requestId }, key()))
  return draft.requestId
}

beforeAll(async () => {
  org = await createDoaOrg()
})

describe('[FR-DOA-102/AC1] the QR of a printed request', () => {
  it('is issued by the submit, prints the same token every time, and the row keeps only its sha256', async () => {
    const requestId = await submitted('req_con', '150.00')
    const rows = await prisma.documentVerification.findMany({ where: { subjectType: 'REQUEST', subjectId: requestId } })
    expect(rows).toHaveLength(1)
    const first = ok(await requestPrintable(org.ctxOf('req_con', NOW), requestId))
    const again = ok(await requestPrintable(org.ctxOf('req_con', new Date(NOW.getTime() + 3_600_000)), requestId))
    expect(first.verifyUrl).toMatch(/\/verify\/[A-Za-z0-9_-]{43}$/)
    expect(again.verifyUrl).toBe(first.verifyUrl)
    const token = tokenOf(first.verifyUrl)
    expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'))
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0]!.contentSha256).toBe(printedContentSha256(first))
    // The token is nowhere in the database or the events
    const events = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'document_verification.issued' }, select: { data: true } })
    expect(JSON.stringify(events)).not.toContain(token)
  })

  it('a resend with the same content keeps the QR; after a change the old QR says a newer version exists', async () => {
    const requestId = await submitted('req_con', '120.00')
    const task = async () => prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })
    const returnIt = async () => {
      const t = await task()
      const code = Object.entries(org.member).find(([, id]) => id === t.assigneeMemberId)![0]
      await stepUpForTask(t.id, t.assigneeMemberId)
      ok(await decideTask(org.ctxOf(code, NOW), { taskId: t.id, decision: 'RETURN', reason: 'แนบรายละเอียดเพิ่ม' }, key()))
    }
    const token = tokenOf(ok(await requestPrintable(org.ctxOf('req_con', NOW), requestId)).verifyUrl)
    await returnIt()
    ok(await resubmitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    expect(await prisma.documentVerification.count({ where: { subjectId: requestId } })).toBe(1)
    expect(tokenOf(ok(await requestPrintable(org.ctxOf('req_con', NOW), requestId)).verifyUrl)).toBe(token)

    await returnIt()
    const line = await prisma.requestLine.findFirstOrThrow({ where: { requestId } })
    ok(await editRequest(org.ctxOf('req_con', NOW), { requestId, lines: [{ id: line.id, description: 'ปูนซีเมนต์', quantity: '12', uom: 'ถุง', unitPrice: '120.00' }] }, key()))
    ok(await resubmitRequest(org.ctxOf('req_con', NOW), { requestId }, key()))
    expect(await prisma.documentVerification.count({ where: { subjectId: requestId } })).toBe(2)
    const newer = tokenOf(ok(await requestPrintable(org.ctxOf('req_con', NOW), requestId)).verifyUrl)
    expect(newer).not.toBe(token)
    expect(await verifyDocument(token, null)).toMatchObject({ latest: false })
    expect(await verifyDocument(newer, null)).toMatchObject({ latest: true })
  })
})

describe('[FR-DOA-102/AC2] the public reading', () => {
  it('names the organization, kind, number and status, no amount and no person; a wrong token is not found', async () => {
    const requestId = await submitted('req_con', '150.00')
    const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, include: { requester: true } })
    const token = tokenOf(ok(await requestPrintable(org.ctxOf('req_con', NOW), requestId)).verifyUrl)
    const shown = await verifyDocument(token, null)
    expect(shown).toEqual({ organizationName: expect.any(String), kind: 'REQUEST', number: request.number, status: 'PENDING_APPROVAL', statusAt: NOW.toISOString(), latest: true, href: null })
    const text = JSON.stringify(shown)
    expect(text).not.toContain(request.requester.displayNameTh)
    expect(text).not.toContain('1500')
    // A member who may view it gets a link; another organization's member does not
    expect(await verifyDocument(token, (o) => (o === org.organizationId ? org.ctxOf('req_con', NOW) : null))).toMatchObject({ href: `/requests/${requestId}` })
    // Wrong, malformed or made-up: the same "not found"
    expect(await verifyDocument(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, null)).toBeNull()
    expect(await verifyDocument('not-a-token', null)).toBeNull()
    expect(await verifyDocument('', null)).toBeNull()
  })

  it('a PDF and the reading add or change no row of the organization (every table, counted and hashed)', async () => {
    const requestId = await submitted('req_con', '150.00')
    const before = await snapshot(org.organizationId)
    const printed = ok(await requestPrintable(org.ctxOf('req_con', NOW), requestId))
    await verifyDocument(tokenOf(printed.verifyUrl), (o) => (o === org.organizationId ? org.ctxOf('dm_con', NOW) : null))
    await verifyDocument('not-a-token', null)
    expect(await snapshot(org.organizationId)).toEqual(before)
  })

  it('a PO cancelled shows CANCELLED at once', async () => {
    const flow = p2p(org, NOW)
    const line = await flow.fundedLine(500_000n)
    const request = await flow.approvedRequest(line, [{ quantity: '1', unitPrice: '30000.00' }])
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012' } })
    const po = await flow.approvedPo(request.lines.map((l) => l.id), supplier.id)
    const token = tokenOf(ok(await purchaseOrderPrintable(org.ctxOf('proc_officer', NOW), po.id)).verifyUrl)
    expect(await verifyDocument(token, null)).toMatchObject({ kind: 'PURCHASE_ORDER', number: po.number, status: 'APPROVED', latest: true })
    ok(await cancelPurchaseOrder(org.ctxOf('proc_officer', NOW), { poId: po.id, reason: 'ผู้ขายแจ้งว่าไม่มีสินค้า', disposition: 'RETURN_TO_POOL' }, key()))
    expect(await verifyDocument(token, null)).toMatchObject({ status: 'CANCELLED' })
  })

  it('is limited per address', async () => {
    const address = `test-${randomUUID()}`
    for (let i = 0; i < VERIFY_RATE_PER_WINDOW; i++) expect((await verifyPage('not-a-token', address, NOW, null)).kind).toBe('NOT_FOUND')
    expect((await verifyPage('not-a-token', address, NOW, null)).kind).toBe('TOO_MANY')
  })
})

// S17-12 (FR-PLT-301 AC5 AC10, BR-APP-04, BR-APP-07, BR-APP-13): what /go/receive prepares and asks of the server.
// Copies of the POs the member may receive now hold nothing of money; a member who receives nothing gets an empty list;
// what a key recorded is read by its sender only; the routes take the queue's key and refuse a cross-site call; with
// module BCS_GO off nothing new is prepared, while a receipt already queued still goes (gr.post is CORE).
// S17-14 (FR-PLT-301 AC6 AC10, BR-APP-11): a QR scanned on site finds its PO by the sha256 of its token — the hash the
// page makes with WebCrypto is the one S6 recorded, older printings count, and every refusal reads as "not found".
import { createHash, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { GET as prepareRoute } from '@/app/api/go/receiving/prepare/route'
import { POST as completeRoute } from '@/app/api/go/files/complete/route'
import { POST as requestRoute } from '@/app/api/go/files/request/route'
import { GET as lookupRoute, POST as postRoute } from '@/app/api/go/receiving/gr/route'
import { GET as resolveRoute } from '@/app/api/go/resolve/route'
import { fund } from '@/core/budget'
import { putObject } from '@/integrations/storage'
import { getEnv } from '@/lib/env'
import { totp } from '@/lib/totp'
import { applyBudget } from '@/server/budget/ledger'
import { auth } from '@/server/auth/auth'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { prepareOfflineCopies, recordedReceipt, resolveScannedPo } from '@/server/services/receiving/offline-copies'
import { verificationKey, verificationToken, verificationTokenHash } from '@/server/verification/token'
import { tokenHashOf } from '@/ui/go-receive/scan'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createDraft, submitRequest } from '../support/requests'

const NOW = new Date('2026-10-06T03:00:00Z')
const APP_UA = 'Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 BCSGo/0.1.0'
const PASSWORD = 'receiver-password-123456'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let supplierId: string
const codeOf = (o: DoaOrg, memberId: string) => Object.entries(o.member).find(([, id]) => id === memberId)![0]

async function withModule(o: DoaOrg) {
  await prisma.orgModule.create({ data: { organizationId: o.organizationId, module: 'BCS_GO', enabled: true, enabledAt: NOW, contractRef: 'TEST-S17', reason: 'ทดสอบแอป BCS Go' } })
}

async function setupOrg(): Promise<DoaOrg> {
  const o = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: o.organizationId, memberId: o.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: o.department.CON!, grantedAt: NOW } })
  return o
}

beforeAll(async () => {
  org = await setupOrg()
  await withModule(org)
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายคอนกรีต', taxId: '0999999000012' } })).id
})

async function sentPo(o: DoaOrg, supplier: string) {
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: o.organizationId, code: 'FY2569' } })
  const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: o.organizationId, code: 'CC-CON' } })
  const line = await prisma.budgetLine.create({ data: { organizationId: o.organizationId, fiscalYearId: fy.id, departmentId: o.department.CON!, costCenterId: cc.id, code: `CON-${randomUUID().slice(0, 8)}`, nameTh: 'งบทดสอบ', plannedSatang: 0n } })
  await prisma.budgetLineBalance.create({ data: { organizationId: o.organizationId, budgetLineId: line.id } })
  const seedCtx = systemCtx(o.organizationId, NOW, 'seed')
  const importId = randomUUID()
  await forTenant(o.organizationId).$transaction(async (tx) => {
    const r = await applyBudget(tx, seedCtx, [{ budgetLineId: line.id, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, 100_000_000n, importId) }])
    if (!r.ok) throw new Error('fund failed')
    await appendEvents(tx, seedCtx, r.events)
  })
  const requester = o.ctxOf('req_con', NOW)
  const draft = ok(await createDraft(requester, { requestTypeCode: 'BUY_GOODS', title: 'คอนกรีตผสมเสร็จ', urgency: 'URGENT', budgetLineId: line.id, lines: [{ description: 'คอนกรีตผสมเสร็จ 240 ksc', quantity: '2', uom: 'ลบ.ม.', unitPrice: '2780.00' }] }, key()))
  ok(await submitRequest(requester, { requestId: draft.requestId }, key()))
  const approveAll = async (subjectId: string) => {
    for (let i = 0; i < 5; i++) {
      const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
      if (!task) return
      ok(await decideTask(o.ctxOf(codeOf(o, task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    }
  }
  await approveAll(draft.requestId)
  const requestLines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId } })
  const poId = ok(await assignSupplier(o.ctxOf('proc_officer', NOW), { requestLineIds: requestLines.map((l) => l.id), supplierId: supplier }, key())).purchaseOrderIds[0]!
  ok(await submitPo(o.ctxOf('proc_officer', NOW), { poId }, key()))
  await approveAll(poId)
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'SENT', sentAt: NOW } })
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: true } })
  return { poId, number: po.number!, version: po.version, lineId: po.lines[0]!.id }
}

const tokenHash = () => createHash('sha256').update(randomUUID()).digest('hex')

const TOTP_SECRET = 'R'.repeat(32)
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')

/** Signs the receiver in as the app's WebView does: the password, then the authenticator code (a role needs 2FA) */
async function cookieOf(o: DoaOrg, code: string): Promise<string> {
  const m = await prisma.member.findUniqueOrThrow({ where: { id: o.member[code]! } })
  const userId = await upsertUserWithPassword({ email: m.email, name: m.displayNameTh, password: PASSWORD })
  await enableTotpWithSecret(userId, TOTP_SECRET, [])
  await prisma.member.update({ where: { id: m.id }, data: { userId } })
  const env = getEnv()
  const headers = { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': '203.0.113.81' }
  const first = await auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers, body: JSON.stringify({ email: m.email, password: PASSWORD }) }))
  expect(first.status).toBe(200)
  const second = await auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth/two-factor/verify-totp`, { method: 'POST', headers: { ...headers, cookie: cookiesOf(first) }, body: JSON.stringify({ code: totp(TOTP_SECRET) }) }))
  expect(second.status).toBe(200)
  return cookiesOf(second)
}

describe('[FR-PLT-301/AC5] what the phone keeps: copies without money, for the receiver only (BR-APP-04)', () => {
  it('prepares the receivable POs with lines, version and every QR token hash — no price, amount or budget', async () => {
    const po = await sentPo(org, supplierId)
    const printed = [tokenHash(), tokenHash()]
    for (const [n, hash] of printed.entries()) {
      await prisma.documentVerification.create({ data: { organizationId: org.organizationId, subjectType: 'PURCHASE_ORDER', subjectId: po.poId, tokenHash: hash, keyId: 'k1', contentSha256: 'a'.repeat(64), issuedAt: new Date(NOW.getTime() + n), ...(n === 0 ? { supersededAt: NOW } : {}) } })
    }
    const prepared = ok(await prepareOfflineCopies(org.ctxOf('receiver_con', NOW, 'APP')))
    const copy = prepared.copies.find((c) => c.poId === po.poId)!
    expect(copy).toMatchObject({ number: po.number, version: po.version, status: 'SENT', supplier: 'ผู้ขายคอนกรีต', preparedAt: NOW.toISOString() })
    // Every printed copy's QR, the PDF of the PO's approval and the superseded print among them (OQ-163)
    expect(copy.tokenHashes).toEqual(expect.arrayContaining(printed))
    expect(copy.lines).toEqual([{ poLineId: po.lineId, description: 'คอนกรีตผสมเสร็จ 240 ksc', uom: 'ลบ.ม.', ordered: '2', received: '0', cancelled: '0' }])
    expect(prepared).toMatchObject({ truncated: false, retentionDays: 7 })
    const text = JSON.stringify(prepared)
    for (const word of ['2780', '2,780', '5560', '5,560', 'Satang', 'price', 'amount', 'budget', 'email']) expect(text, word).not.toContain(word)
  })

  it('a member who receives nothing gets an empty list; the organization caps how many a phone keeps', async () => {
    expect(ok(await prepareOfflineCopies(org.ctxOf('fin_officer', NOW, 'APP')))).toMatchObject({ copies: [], truncated: false })
    const capped = await setupOrg()
    await withModule(capped)
    const row = await prisma.organization.findUniqueOrThrow({ where: { id: capped.organizationId } })
    await prisma.organization.update({ where: { id: capped.organizationId }, data: { settings: { ...(row.settings as Record<string, unknown>), bcsGo: { maxPreparedPos: 1 } } } })
    const s = (await prisma.supplier.create({ data: { organizationId: capped.organizationId, code: 'S1', nameTh: 'ผู้ขาย', taxId: '0999999000012' } })).id
    await sentPo(capped, s)
    await sentPo(capped, s)
    const prepared = ok(await prepareOfflineCopies(capped.ctxOf('receiver_con', NOW, 'APP')))
    expect(prepared.copies).toHaveLength(1)
    expect(prepared.truncated).toBe(true)
  })

  it('leaves out a PO the receiver may not receive by separation of duties: they approved its request (BR-SOD-02)', async () => {
    const po = await sentPo(org, supplierId)
    const approver = await prisma.approvalTask.findFirstOrThrow({ where: { organizationId: org.organizationId, status: 'APPROVED', step: { route: { subjectType: 'REQUEST' } }, decidedByMemberId: { not: null } }, orderBy: { decidedAt: 'desc' } })
    const code = codeOf(org, approver.decidedByMemberId!)
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: approver.decidedByMemberId!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
    const theirs = ok(await prepareOfflineCopies(org.ctxOf(code, NOW, 'APP')))
    expect(theirs.copies.some((c) => c.poId === po.poId)).toBe(false)
    expect(ok(await prepareOfflineCopies(org.ctxOf('receiver_con', NOW, 'APP'))).copies.some((c) => c.poId === po.poId)).toBe(true)
  })

  it('what a key recorded is read by the member who sent it; another member does not find it', async () => {
    const po = await sentPo(org, supplierId)
    const queueKey = randomUUID()
    const sent = ok(
      await postGoodsReceipt(
        org.ctxOf('receiver_con', NOW, 'APP'),
        { poId: po.poId, photoFileIds: [], lines: [{ poLineId: po.lineId, received: '1' }], offline: { capturedAt: NOW.toISOString(), capturedByMemberId: org.member.receiver_con!, expectedPoVersion: po.version } },
        { idempotencyKey: queueKey },
      ),
    )
    expect(sent).toMatchObject({ poVersion: po.version + 1, poStatus: 'PARTIALLY_RECEIVED' })
    expect(ok(await recordedReceipt(org.ctxOf('receiver_con', NOW), queueKey))).toMatchObject({ recorded: true, result: { ok: true, data: { grId: sent.grId } } })
    expect(ok(await recordedReceipt(org.ctxOf('proc_officer', NOW), queueKey))).toEqual({ recorded: false })
    expect(ok(await recordedReceipt(org.ctxOf('receiver_con', NOW), randomUUID()))).toEqual({ recorded: false })
    const gr = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: sent.grId } })
    expect(gr).toMatchObject({ offlineCapturedAt: NOW, receivedAt: NOW, postedAt: NOW })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: sent.grId, type: 'gr.posted' } })).toMatchObject({ schemaVersion: 2, channel: 'APP', data: { offline: { capturedAt: NOW.toISOString() } } })
  })
})

describe('[FR-PLT-301/AC5] the routes of /go/receive (BR-APP-03, BR-APP-07)', () => {
  it('POST needs the queue key, refuses a cross-site call, and a resend of the key gives the same receipt; GET reads it back', async () => {
    const cookie = await cookieOf(org, 'receiver_con')
    const po = await sentPo(org, supplierId)
    const url = `${getEnv().APP_URL}/api/go/receiving/gr`
    // The input frozen at the first send, sent again unchanged (BR-APP-05): the route checks the session's real time
    const frozen = JSON.stringify({ poId: po.poId, photoFileIds: [], lines: [{ poLineId: po.lineId, received: '2' }], offline: { capturedAt: new Date().toISOString(), capturedByMemberId: org.member.receiver_con!, expectedPoVersion: po.version } })
    const post = (headers: Record<string, string>, payload = frozen) => postRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'user-agent': APP_UA, ...headers }, body: payload }))
    expect((await post({})).status).toBe(400)
    expect((await post({ 'idempotency-key': randomUUID(), 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    const queueKey = randomUUID()
    const first = await post({ 'idempotency-key': queueKey })
    expect(first.status).toBe(201)
    const created = (await first.json()) as { grId: string; poVersion: number }
    // The answer was lost: the same key again is the same receipt, not a second one
    const again = await post({ 'idempotency-key': queueKey })
    expect(again.status).toBe(201)
    expect(((await again.json()) as { grId: string }).grId).toBe(created.grId)
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(1)
    const lookup = await lookupRoute(new Request(`${url}?key=${queueKey}`, { headers: { cookie } }))
    expect(lookup.status).toBe(200)
    expect(await lookup.json()).toMatchObject({ recorded: true, result: { ok: true, data: { grId: created.grId } } })
    expect((await lookupRoute(new Request(`${url}?key=x`, { headers: { cookie } }))).status).toBe(400)
    expect((await lookupRoute(new Request(`${url}?key=${queueKey}`))).status).toBe(401)
  })

  it('GET prepare names the member the copies are for (the page sends for that member only, BR-APP-09); 401 without a session', async () => {
    const cookie = await cookieOf(org, 'receiver_con')
    const po = await sentPo(org, supplierId)
    const url = `${getEnv().APP_URL}/api/go/receiving/prepare`
    const prepared = await prepareRoute(new Request(url, { headers: { cookie, 'user-agent': APP_UA } }))
    expect(prepared.status).toBe(200)
    expect(prepared.headers.get('cache-control')).toBe('no-store')
    const body = (await prepared.json()) as { memberId: string; maxPreparedPos: number; copies: Array<{ poId: string }> }
    expect(body.memberId).toBe(org.member.receiver_con)
    // The cap a QR resolved later keeps to as well (S17-14, BR-APP-04)
    expect(body.maxPreparedPos).toBeGreaterThan(0)
    expect(body.copies.some((c) => c.poId === po.poId)).toBe(true)
    expect((await prepareRoute(new Request(url))).status).toBe(401)
  })
})

describe('[FR-PLT-301/AC7] the photos of a queued receipt go up through the routes (BR-APP-14)', () => {
  it('a ticket, the upload, and a completion asked twice with the same ticket give one file', async () => {
    const cookie = await cookieOf(org, 'receiver_con')
    const base = getEnv().APP_URL
    const bytes = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==', 'base64')
    const headers = { 'content-type': 'application/json', cookie, 'user-agent': APP_UA }
    const asked = await requestRoute(new Request(`${base}/api/go/files/request`, { method: 'POST', headers, body: JSON.stringify({ fileName: 'delivery.jpg', mimeType: 'image/jpeg', sizeBytes: bytes.length }) }))
    expect(asked.status).toBe(200)
    const { ticket } = (await asked.json()) as { ticket: string }
    const storageKey = (JSON.parse(Buffer.from(ticket.split('.')[0]!, 'base64url').toString('utf8')) as { key: string }).key
    await putObject(storageKey, bytes, 'image/jpeg')
    const complete = () => completeRoute(new Request(`${base}/api/go/files/complete`, { method: 'POST', headers, body: JSON.stringify({ ticket }) }))
    const first = (await (await complete()).json()) as { fileId: string }
    const again = await complete()
    expect(again.status).toBe(200)
    expect(((await again.json()) as { fileId: string }).fileId).toBe(first.fileId)
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: first.fileId } })).toMatchObject({ uploadedById: org.member.receiver_con, mimeType: 'image/jpeg' })
    // A ticket that is not one asks for a new ticket; another site may not call the route
    expect(await (await completeRoute(new Request(`${base}/api/go/files/complete`, { method: 'POST', headers, body: JSON.stringify({ ticket: 'x.y' }) }))).json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    expect((await requestRoute(new Request(`${base}/api/go/files/request`, { method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, body: '{}' }))).status).toBe(403)
  })
})

/** A printing of the PO as S6 records it (BR-QR-01): a row whose token is computed from its id; the hash is kept */
async function printing(o: DoaOrg, poId: string, supersededAt: Date | null = null): Promise<{ token: string; tokenHash: string }> {
  const id = randomUUID()
  const token = verificationToken(id)
  const hash = verificationTokenHash(token)
  await prisma.documentVerification.create({ data: { id, organizationId: o.organizationId, subjectType: 'PURCHASE_ORDER', subjectId: poId, tokenHash: hash, keyId: verificationKey().keyId, contentSha256: tokenHash(), issuedAt: NOW, supersededAt } })
  return { token, tokenHash: hash }
}

describe('[FR-PLT-301/AC6] a QR scanned on site finds its PO by the hash of its token (BR-APP-11, OQ-163)', () => {
  it('the hash the page makes with WebCrypto is the tokenHash S6 recorded; the receiver gets the copy of the PO, from an older printout too', async () => {
    const po = await sentPo(org, supplierId)
    const older = await printing(org, po.poId, NOW)
    const latest = await printing(org, po.poId)
    // The page's own function (src/ui/go-receive/scan.ts) on the token of each printing
    expect(await tokenHashOf(latest.token)).toBe(latest.tokenHash)
    expect(await tokenHashOf(older.token)).toBe(older.tokenHash)
    for (const p of [latest, older]) {
      const found = ok(await resolveScannedPo(org.ctxOf('receiver_con', NOW, 'APP'), p.tokenHash))
      expect(found.copy).toMatchObject({ poId: po.poId, number: po.number, version: po.version, tokenHashes: expect.arrayContaining([older.tokenHash, latest.tokenHash]) })
      expect(JSON.stringify(found)).not.toMatch(/2780|unitPrice|amount|budget/i)
    }
  })

  it('refuses alike: no such printing, a malformed hash, another organization\'s PO, a PO out of scope, one no longer taking goods', async () => {
    const po = await sentPo(org, supplierId)
    const mine = await printing(org, po.poId)
    const other = await setupOrg()
    await withModule(other)
    const otherSupplier = (await prisma.supplier.create({ data: { organizationId: other.organizationId, code: 'S1', nameTh: 'ผู้ขายอื่น', taxId: '0999999000012' } })).id
    const theirs = await printing(other, (await sentPo(other, otherSupplier)).poId)
    const receiver = org.ctxOf('receiver_con', NOW, 'APP')
    const refusals = [
      await resolveScannedPo(receiver, tokenHash()),
      await resolveScannedPo(receiver, mine.tokenHash.toUpperCase()),
      await resolveScannedPo(receiver, mine.token),
      await resolveScannedPo(receiver, theirs.tokenHash),
      // A member without gr.post on the PO: procurement drafted it but receives nothing
      await resolveScannedPo(org.ctxOf('proc_officer', NOW, 'APP'), mine.tokenHash),
    ]
    for (const r of refusals) expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    // One message for all of them, so nothing tells a PO out of scope from one that does not exist
    expect(new Set(refusals.map((r) => (r.ok ? '' : r.error.message))).size).toBe(1)
    // Received in full or cancelled: nothing to receive on it any more
    await prisma.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'CANCELLED' } })
    expect(await resolveScannedPo(receiver, mine.tokenHash)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('the route sends only the hash and answers 200, 404 alike for any refusal, 401 without a session', async () => {
    const cookie = await cookieOf(org, 'receiver_con')
    const po = await sentPo(org, supplierId)
    const p = await printing(org, po.poId)
    const url = (h: string) => `${getEnv().APP_URL}/api/go/resolve?h=${encodeURIComponent(h)}`
    const found = await resolveRoute(new Request(url(p.tokenHash), { headers: { cookie, 'user-agent': APP_UA } }))
    expect(found.status).toBe(200)
    expect(found.headers.get('cache-control')).toBe('no-store')
    expect(((await found.json()) as { copy: { poId: string } }).copy.poId).toBe(po.poId)
    const missing = await resolveRoute(new Request(url(tokenHash()), { headers: { cookie } }))
    const malformed = await resolveRoute(new Request(url('not-a-hash'), { headers: { cookie } }))
    expect([missing.status, malformed.status]).toEqual([404, 404])
    expect(await missing.json()).toEqual(await malformed.json())
    expect((await resolveRoute(new Request(url(p.tokenHash)))).status).toBe(401)
  })
})

describe('[FR-PLT-301/AC10] module BCS_GO off: nothing new is prepared, a queued receipt still goes (BR-APP-13)', () => {
  it('prepare answers MODULE_DISABLED; gr.post with the queue key and offline still records the receipt', async () => {
    const off = await setupOrg()
    const s = (await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'S1', nameTh: 'ผู้ขาย', taxId: '0999999000012' } })).id
    const po = await sentPo(off, s)
    expect(await prepareOfflineCopies(off.ctxOf('receiver_con', NOW, 'APP'))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    const cookie = await cookieOf(off, 'receiver_con')
    const prepared = await prepareRoute(new Request(`${getEnv().APP_URL}/api/go/receiving/prepare`, { headers: { cookie, 'user-agent': APP_UA } }))
    expect(prepared.status).toBe(403)
    expect(await prepared.json()).toMatchObject({ error: { code: 'MODULE_DISABLED' } })
    const queued = await postGoodsReceipt(
      off.ctxOf('receiver_con', NOW, 'APP'),
      { poId: po.poId, photoFileIds: [], lines: [{ poLineId: po.lineId, received: '2' }], offline: { capturedAt: NOW.toISOString(), capturedByMemberId: off.member.receiver_con!, expectedPoVersion: po.version } },
      { idempotencyKey: randomUUID() },
    )
    expect(queued).toMatchObject({ ok: true, data: { poStatus: 'RECEIVED' } })
  })

  it('a scanned QR is not resolved: MODULE_DISABLED from the service and the route (S17-14)', async () => {
    const off = await setupOrg()
    const s = (await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'S1', nameTh: 'ผู้ขาย', taxId: '0999999000012' } })).id
    const p = await printing(off, (await sentPo(off, s)).poId)
    expect(await resolveScannedPo(off.ctxOf('receiver_con', NOW, 'APP'), p.tokenHash)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    const cookie = await cookieOf(off, 'receiver_con')
    const res = await resolveRoute(new Request(`${getEnv().APP_URL}/api/go/resolve?h=${p.tokenHash}`, { headers: { cookie, 'user-agent': APP_UA } }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 'MODULE_DISABLED' } })
  })
})

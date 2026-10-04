import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '@/server/context'

// The LIFF page's session is what these tests choose: the LIFF request pages' server side runs with whatever
// liffPage() hands it (src/app/liff/_lib/session.ts reads the cookies of a request, which a test has none of). The
// language of the screen is Thai. Everything else — the services, the commands, the Events — is the real path on real
// Postgres (BCS_TEST_DB).
const session = vi.hoisted(() => ({ page: { kind: 'signed-out' } as unknown }))
vi.mock('@/app/liff/_lib/session', () => ({ liffPage: async () => session.page }))
vi.mock('next-intl/server', () => ({ getLocale: async () => 'th' }))

import {
  answerInfoAction,
  attachFileAction,
  cancelRequestAction,
  completeUploadAction,
  downloadUrlAction,
  previewRequestAction,
  requestUploadAction,
  resubmitReturnedAction,
  submitRequestAction,
} from '@/app/liff/requests/actions'
import { POST as autosave } from '@/app/liff/requests/new/autosave/route'
import { prisma } from '@/server/db/client'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-06 · the server side of the LIFF request pages (§9.4 /liff/requests/new, /liff/requests/[id]; FR-LINE-003 AC1):
//  - the draft the LIFF form saves (POST /liff/requests/new/autosave) and the send (submitRequestAction) run the
//    workspace's commands with the context of the LIFF page, so every Event of the request says LIFF (here the context
//    is the one the test hands over as the LIFF page's; that a real LIFF page's context says LIFF is proved end to end
//    in tests/e2e/liff-requests.spec.ts, from the Events of requests made in the LINE-sized browser);
//  - a send runs once, whether it is tapped twice or sent again after a lost answer;
//  - the requester answers a question and sends a returned request again from LIFF, and nobody else can;
//  - nothing is saved, previewed, sent, uploaded or opened without a member session of the LIFF page;
//  - another member can neither save into, preview nor send someone else's draft (the services refuse, BR-AUTH-05);
//  - the autosave route takes same-origin requests only, and no body above its limit.

const NOW = new Date('2026-10-05T03:00:00Z')
const ORIGIN = 'http://liff.test.local'
let org: DoaOrg

beforeAll(async () => {
  org = await createDoaOrg()
})

beforeEach(() => {
  session.page = { kind: 'signed-out' }
})

/** The LIFF page of a member of the test organization, as liffPage() hands it over (a LIFF session, channel LIFF) */
function asMember(code: string): Ctx {
  const ctx = org.ctxOf(code, NOW, 'LIFF')
  session.page = {
    kind: 'member',
    ctx,
    member: { id: org.member[code]!, organizationId: org.organizationId, organizationName: 'องค์กรทดสอบ DOA', displayNameTh: `ผู้ใช้ ${code}`, displayNameEn: null, email: `${code}@test.bcs.local` },
    session: 'liff',
  }
  return ctx
}

async function conLine(): Promise<string> {
  return (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CON-OPEX-2569' }, select: { id: true } })).id
}

const LINES = [
  { id: null, description: 'ไม้อัด 10 มม.', quantity: '20', uom: 'แผ่น', unitPrice: '1500.00', vatable: true },
  { id: null, description: 'ตะปู 2 นิ้ว', quantity: '100', uom: 'กล่อง', unitPrice: '120.00', vatable: true },
]

/** A save as the LIFF form sends it (src/ui/request-form/use-autosave.ts), from the same site unless told otherwise */
function saveRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/liff/requests/new/autosave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: new URL(ORIGIN).host, 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  })
}

async function newDraft(code: string): Promise<{ requestId: string; version: number }> {
  asMember(code)
  const response = await autosave(
    saveRequest({
      idempotencyKey: randomUUID(),
      requestId: null,
      requestTypeCode: 'BUY_GOODS',
      expectedVersion: null,
      draft: { title: `ไม้อัดและตะปู ${randomUUID().slice(0, 6)}`, budgetLineId: await conLine(), priceIncludesVat: false, formData: {}, lines: LINES },
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { ok: true; requestId: string; version: number }
  return { requestId: body.requestId, version: body.version }
}

const channelsOf = async (requestId: string, type: string) =>
  (await prisma.event.findMany({ where: { aggregateType: 'Request', aggregateId: requestId, type }, select: { channel: true }, orderBy: { seq: 'asc' } })).map((e) => e.channel)

describe('[FR-LINE-003/AC1] a request made in LIFF goes through the workspace commands on channel LIFF', () => {
  it('[FR-LINE-003/AC1] [FR-INT-006/AC1] the LIFF autosave route creates the draft and edits it by version, with the LIFF page’s context: request.drafted says LIFF', async () => {
    const { requestId, version } = await newDraft('req_con')
    expect(version).toBe(0)
    const draft = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, requesterMemberId: true, lines: { select: { netSatang: true } } } })
    expect(draft.status).toBe('DRAFT')
    expect(draft.requesterMemberId).toBe(org.member.req_con)
    expect(draft.lines.map((l) => l.netSatang).sort()).toEqual([1_200_000n, 3_000_000n])

    // The next save names the version it was based on
    const edited = await autosave(saveRequest({ idempotencyKey: randomUUID(), requestId, requestTypeCode: 'BUY_GOODS', expectedVersion: 0, draft: { title: 'ไม้อัดและตะปู ไซต์ A', priceIncludesVat: false, formData: {} } }))
    expect(edited.status).toBe(200)
    expect(((await edited.json()) as { version: number }).version).toBe(1)
    // A save based on a version another device replaced gets CONFLICT_VERSION (FR-INT-006 AC2)
    const stale = await autosave(saveRequest({ idempotencyKey: randomUUID(), requestId, requestTypeCode: 'BUY_GOODS', expectedVersion: 0, draft: { title: 'จากเครื่องเก่า', priceIncludesVat: false, formData: {} } }))
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { code: string }).code).toBe('CONFLICT_VERSION')

    const channels = await channelsOf(requestId, 'request.drafted')
    expect(channels.length).toBeGreaterThanOrEqual(2)
    expect(new Set(channels)).toEqual(new Set(['LIFF']))
  })

  it('[FR-LINE-003/AC1] [FR-INT-004/AC1] [FR-DOA-003/AC2] [FR-INT-007/AC1] the LIFF preview shows the line’s balance and the route, and the send submits on channel LIFF with the number and who decides', async () => {
    const { requestId, version } = await newDraft('req_con')
    const line = await conLine()
    const preview = await previewRequestAction({
      requestTypeCode: 'BUY_GOODS',
      requestId,
      budgetLineId: line,
      priceIncludesVat: false,
      lines: LINES.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, vatable: l.vatable })),
    })
    if (!preview.ok) throw new Error(`preview refused: ${preview.code}`)
    expect(preview.preview.totals).toMatchObject({ net: { amount: '42000.00' }, vat: { amount: '2940.00' }, gross: { amount: '44940.00' } })
    expect(preview.preview.budget).toMatchObject({ kind: 'LINE', budgetLineId: line, enough: true })
    expect(preview.preview.route).toMatchObject({ kind: 'ROUTE', doaCode: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' })

    const key = randomUUID()
    const sent = await submitRequestAction({ requestId, expectedVersion: version, resubmit: false }, key)
    if (!sent.ok) throw new Error(`send refused: ${sent.code}`)
    expect(sent.requestId).toBe(requestId)
    expect(sent.sent.number).toMatch(/^PR-\d{4}-\d{5}$/)
    expect(sent.sent.waitingFor).toEqual([{ name: 'ผู้ใช้ vp_ops', principalName: null }])
    expect(await channelsOf(requestId, 'request.submitted')).toEqual(['LIFF'])
    const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, version: true } })
    expect(request.status).toBe('PENDING_APPROVAL')

    // A double tap, or a retry after a lost answer, is the same submission with the same key: the command ran once and
    // the answer is the same — one number, one request.submitted, one task
    expect(await submitRequestAction({ requestId, expectedVersion: version, resubmit: false }, key)).toEqual(sent)
    expect(await channelsOf(requestId, 'request.submitted')).toEqual(['LIFF'])
    expect(await prisma.approvalTask.count({ where: { step: { route: { subjectType: 'REQUEST', subjectId: requestId } } } })).toBe(1)
    // A new send of a request that was sent is refused: for its state when it names the version the request has now,
    // for the version when it names the one the form saved before the send (the form then offers the latest version)
    expect(await submitRequestAction({ requestId, expectedVersion: request.version, resubmit: false }, randomUUID())).toMatchObject({ ok: false, code: 'INVALID_STATE_TRANSITION' })
    expect(await submitRequestAction({ requestId, expectedVersion: version, resubmit: false }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT_VERSION' })
    expect(await channelsOf(requestId, 'request.submitted')).toEqual(['LIFF'])
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { number: true, version: true } })).toEqual({ number: sent.sent.number, version: request.version })
  })
})

/** The open approval task of a request */
const openTask = (requestId: string) =>
  prisma.approvalTask.findFirstOrThrow({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { subjectType: 'REQUEST', subjectId: requestId } } }, select: { id: true, status: true } })

/** A request req_con made and sent from LIFF */
async function sentFromLiff(): Promise<string> {
  const { requestId, version } = await newDraft('req_con')
  const sent = await submitRequestAction({ requestId, expectedVersion: version, resubmit: false }, randomUUID())
  if (!sent.ok) throw new Error(`send refused: ${sent.code}`)
  return requestId
}

describe('[FR-LINE-003/AC1] [FR-INT-009/AC2] the requester sends a returned request again from LIFF', () => {
  it('[FR-INT-009/AC2] only the requester, on channel LIFF, on a new route; a second tap with the same key changes nothing more', async () => {
    const requestId = await sentFromLiff()
    const task = await openTask(requestId)
    const returned = await decideTask(org.ctxOf('vp_ops', NOW, 'LIFF'), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการตามความหนา' }, { idempotencyKey: randomUUID(), sender: null })
    if (!returned.ok) throw new Error(`return refused: ${returned.error.code}`)
    const routes = async () => prisma.approvalRoute.count({ where: { subjectType: 'REQUEST', subjectId: requestId } })
    const before = await routes()

    // Someone else signed in through LINE: refused, and the request stays returned
    asMember('asst_con')
    expect(await resubmitReturnedAction(requestId, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect((await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).status).toBe('RETURNED')

    asMember('req_con')
    const key = randomUUID()
    expect(await resubmitReturnedAction(requestId, key)).toEqual({ ok: true })
    expect(await resubmitReturnedAction(requestId, key)).toEqual({ ok: true })
    expect((await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).status).toBe('PENDING_APPROVAL')
    // BR-DOA-09: a new route under the DOA in effect, made once
    expect(await routes()).toBe(before + 1)
    expect(await channelsOf(requestId, 'request.resubmitted')).toEqual(['LIFF'])
  })
})

describe('[FR-LINE-003/AC1] [FR-INT-009/AC2] the requester changes a returned request in the LIFF form and sends it again from there', () => {
  it('[FR-INT-009/AC2] the edit saved through the LIFF autosave route, then "ส่งขออนุมัติอีกครั้ง" of the form: a new route, the reservation moved by the difference, channel LIFF; nobody else can', async () => {
    const requestId = await sentFromLiff()
    const lineIds = (await prisma.requestLine.findMany({ where: { requestId }, orderBy: { lineNo: 'asc' }, select: { id: true } })).map((l) => l.id)
    const held = async () =>
      (await prisma.budgetAllocation.aggregate({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: lineIds } }, _sum: { reservedSatang: true } }))._sum.reservedSatang ?? 0n
    expect(await held()).toBe(4_200_000n)
    const task = await openTask(requestId)
    const returned = await decideTask(org.ctxOf('vp_ops', NOW, 'LIFF'), { taskId: task.id, decision: 'RETURN', reason: 'ลดจำนวนไม้อัดลงครึ่งหนึ่ง' }, { idempotencyKey: randomUUID(), sender: null })
    if (!returned.ok) throw new Error(`return refused: ${returned.error.code}`)
    const routes = async () => prisma.approvalRoute.count({ where: { subjectType: 'REQUEST', subjectId: requestId } })
    const routesBefore = await routes()
    // A returned request keeps what it reserved until it is sent again (§6.4)
    expect(await held()).toBe(4_200_000n)

    // The LIFF form of the returned request (/liff/requests/[id]/edit) saves the change: 10 sheets of plywood, not 20
    asMember('req_con')
    const { version } = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { version: true } })
    const saved = await autosave(
      saveRequest({
        idempotencyKey: randomUUID(),
        requestId,
        requestTypeCode: 'BUY_GOODS',
        expectedVersion: version,
        draft: { priceIncludesVat: false, formData: {}, lines: [{ ...LINES[0]!, id: lineIds[0]!, quantity: '10' }, { ...LINES[1]!, id: lineIds[1]! }] },
      }),
    )
    expect(saved.status).toBe(200)
    const edit = (await saved.json()) as { ok: true; version: number; lineIds: string[] }
    expect(edit.lineIds).toEqual(lineIds)
    // Still returned, still holding the old amount until the send
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).toEqual({ status: 'RETURNED' })
    expect(await held()).toBe(4_200_000n)

    // Someone else signed in through LINE cannot send it, from the form either
    asMember('asst_con')
    expect(await submitRequestAction({ requestId, expectedVersion: edit.version, resubmit: true }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).toEqual({ status: 'RETURNED' })

    // The form's send of a returned request: resubmit, naming the version the requester checked
    asMember('req_con')
    const key = randomUUID()
    const sent = await submitRequestAction({ requestId, expectedVersion: edit.version, resubmit: true }, key)
    if (!sent.ok) throw new Error(`send again refused: ${sent.code}`)
    expect(sent.requestId).toBe(requestId)
    expect(sent.sent.number).toMatch(/^PR-\d{4}-\d{5}$/)
    expect(sent.sent.waitingFor).toEqual([{ name: 'ผู้ใช้ vp_ops', principalName: null }])
    // A second tap with the same key: the same answer, the command ran once
    expect(await submitRequestAction({ requestId, expectedVersion: edit.version, resubmit: true }, key)).toEqual(sent)

    const after = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, netSatang: true } })
    expect(after).toEqual({ status: 'PENDING_APPROVAL', netSatang: 2_700_000n })
    // BR-DOA-09: a new route under the DOA in effect, made once; the reservation follows the new amount (FR-INT-009 AC2)
    expect(await routes()).toBe(routesBefore + 1)
    expect(await held()).toBe(2_700_000n)
    // On channel LIFF: the edit and the send again
    expect(await channelsOf(requestId, 'request.resubmitted')).toEqual(['LIFF'])
    expect(new Set(await channelsOf(requestId, 'request.drafted'))).toEqual(new Set(['LIFF']))
  })
})

describe('[FR-LINE-003/AC1] [FR-INT-009/AC3] the requester answers the approver’s question from LIFF', () => {
  it('[FR-INT-009/AC3] the answer goes back to the approver who asked (the hand-back; the SLA part is S5-07’s); another member and an empty answer are refused', async () => {
    const requestId = await sentFromLiff()
    const task = await openTask(requestId)
    const asked = await requestInfo(org.ctxOf('vp_ops', NOW, 'LIFF'), { taskId: task.id, question: 'ขอใบเสนอราคาอีกราย' }, { idempotencyKey: randomUUID(), sender: null })
    if (!asked.ok) throw new Error(`question refused: ${asked.error.code}`)
    const infoRequestId = asked.data.infoRequestId

    asMember('asst_con')
    expect(await answerInfoAction({ infoRequestId, answer: 'ตอบแทน' }, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    asMember('req_con')
    expect(await answerInfoAction({ infoRequestId, answer: '   ' }, randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'answer' })
    expect((await openTask(requestId)).status).toBe('INFO_REQUESTED')

    expect(await answerInfoAction({ infoRequestId, answer: 'แนบใบที่สองแล้ว' }, randomUUID())).toEqual({ ok: true })
    // The task is open again with the approver who asked (FR-INT-009 AC3's hand-back), and the answer is on channel LIFF
    expect(await openTask(requestId)).toEqual({ id: task.id, status: 'OPEN' })
    expect(await channelsOf(requestId, 'request.info_provided')).toEqual(['LIFF'])
  })
})

describe('[FR-LINE-003/AC1] [FR-INT-009/AC1] the requester cancels their request from LIFF', () => {
  it('[FR-LINE-003/AC1] [FR-INT-009/AC1] only the requester cancels, with a reason, on channel LIFF, and the budget the request held goes back', async () => {
    const { requestId, version } = await newDraft('req_con')
    const sent = await submitRequestAction({ requestId, expectedVersion: version, resubmit: false }, randomUUID())
    if (!sent.ok) throw new Error(`send refused: ${sent.code}`)
    const lineIds = (await prisma.requestLine.findMany({ where: { requestId }, select: { id: true } })).map((l) => l.id)
    const held = async () =>
      (await prisma.budgetAllocation.aggregate({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: lineIds } }, _sum: { reservedSatang: true } }))._sum.reservedSatang ?? 0n
    expect(await held()).toBe(4_200_000n)

    // Someone else, signed in through LINE: refused before the service runs, and nothing changes
    asMember('asst_con')
    expect(await cancelRequestAction({ requestId, reason: 'ไม่ใช่คำขอของฉัน' }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    // The requester without a reason: refused (the page asks for one)
    asMember('req_con')
    expect(await cancelRequestAction({ requestId, reason: 'ไป' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })
    expect((await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).status).toBe('PENDING_APPROVAL')

    const cancelled = await cancelRequestAction({ requestId, reason: 'ใช้งบโครงการอื่นแทน' }, randomUUID())
    expect(cancelled).toEqual({ ok: true })
    expect((await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).status).toBe('CANCELLED')
    expect(await channelsOf(requestId, 'request.cancelled')).toEqual(['LIFF'])
    expect(await held()).toBe(0n)
  })
})

describe('[FR-LINE-003/AC1] without a member session of the LIFF page, nothing is saved, previewed, sent or opened', () => {
  for (const page of [{ kind: 'signed-out' }, { kind: 'needs-2fa-setup', session: 'liff' }, { kind: 'no-membership', session: 'web' }] as const) {
    it(`[FR-LINE-003/AC1] a page that is ${page.kind}`, async () => {
      const { requestId, version } = await newDraft('req_con')
      session.page = page
      const before = await prisma.request.count({ where: { organizationId: org.organizationId } })
      const saved = await autosave(saveRequest({ idempotencyKey: randomUUID(), requestId: null, requestTypeCode: 'BUY_GOODS', expectedVersion: null, draft: { title: 'ไม่ควรถูกบันทึก', priceIncludesVat: false, formData: {} } }))
      expect(saved.status).toBe(401)
      expect(await saved.json()).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
      expect(await prisma.request.count({ where: { organizationId: org.organizationId } })).toBe(before)

      const unauthenticated = { ok: false, code: 'UNAUTHENTICATED' }
      expect(await previewRequestAction({ requestTypeCode: 'BUY_GOODS', requestId, budgetLineId: null, priceIncludesVat: false, lines: [] })).toEqual(unauthenticated)
      expect(await submitRequestAction({ requestId, expectedVersion: version, resubmit: false }, randomUUID())).toEqual(unauthenticated)
      expect(await attachFileAction(requestId, randomUUID(), 'OTHER', randomUUID())).toEqual(unauthenticated)
      expect(await answerInfoAction({ infoRequestId: randomUUID(), answer: 'คำตอบ' }, randomUUID())).toEqual(unauthenticated)
      expect(await resubmitReturnedAction(requestId, randomUUID())).toEqual(unauthenticated)
      expect(await cancelRequestAction({ requestId, reason: 'ไม่ต้องการแล้ว' }, randomUUID())).toEqual(unauthenticated)
      expect(await requestUploadAction({ fileName: 'ใบเสนอราคา.pdf', mimeType: 'application/pdf', sizeBytes: 1000 })).toEqual({ ok: false, reason: 'FAILED' })
      expect(await completeUploadAction('ticket')).toEqual({ ok: false, reason: 'FAILED' })
      expect(await downloadUrlAction(randomUUID())).toBeNull()
      // The draft stayed as it was
      expect((await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, version: true } })).status).toBe('DRAFT')
    })
  }
})

describe('[FR-LINE-003/AC1] another member cannot save into, preview or send someone else’s draft from LIFF', () => {
  it('[FR-LINE-003/AC1] asst_con, signed in through LINE, gets FORBIDDEN for req_con’s draft and changes nothing', async () => {
    const { requestId, version } = await newDraft('req_con')
    asMember('asst_con')
    const edit = await autosave(saveRequest({ idempotencyKey: randomUUID(), requestId, requestTypeCode: 'BUY_GOODS', expectedVersion: version, draft: { title: 'แก้โดยคนอื่น', priceIncludesVat: false, formData: {} } }))
    expect(edit.status).toBe(403)
    expect(((await edit.json()) as { code: string }).code).toBe('FORBIDDEN')
    const preview = await previewRequestAction({ requestTypeCode: 'BUY_GOODS', requestId, budgetLineId: await conLine(), priceIncludesVat: false, lines: [] })
    expect(preview).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const sent = await submitRequestAction({ requestId, expectedVersion: version, resubmit: false }, randomUUID())
    expect(sent).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const draft = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, version: true, title: true } })
    expect(draft.status).toBe('DRAFT')
    expect(draft.version).toBe(version)
    expect(draft.title).not.toBe('แก้โดยคนอื่น')
    expect(await channelsOf(requestId, 'request.submitted')).toEqual([])
  })

  it('[FR-LINE-003/AC1] a send without a proper idempotency key is refused before the command runs', async () => {
    const { requestId, version } = await newDraft('req_con')
    expect(await submitRequestAction({ requestId, expectedVersion: version, resubmit: false }, 'not-a-key')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await attachFileAction(requestId, randomUUID(), 'OTHER', 'not-a-key')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect((await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).status).toBe('DRAFT')
  })
})

describe('[§9.4] the LIFF autosave route takes the page’s own site only, and bodies within its limit', () => {
  it('[§9.4] a save from another site is refused before anything is read', async () => {
    asMember('req_con')
    const before = await prisma.request.count({ where: { organizationId: org.organizationId } })
    const crossSite = await autosave(
      saveRequest(
        { idempotencyKey: randomUUID(), requestId: null, requestTypeCode: 'BUY_GOODS', expectedVersion: null, draft: { title: 'จากเว็บอื่น', priceIncludesVat: false, formData: {} } },
        { origin: 'https://other.example', 'sec-fetch-site': 'cross-site' },
      ),
    )
    expect(crossSite.status).toBe(403)
    expect(await crossSite.json()).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await prisma.request.count({ where: { organizationId: org.organizationId } })).toBe(before)
  })

  it('[§9.4] a body above 1 MiB is refused as a whole (413), and a malformed one names what is wrong', async () => {
    asMember('req_con')
    const tooLarge = await autosave(
      saveRequest({ idempotencyKey: randomUUID(), requestId: null, requestTypeCode: 'BUY_GOODS', expectedVersion: null, draft: { title: 'x'.repeat(1_100_000) } }),
    )
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' })
    const malformed = await autosave(saveRequest({ idempotencyKey: 'not-a-key', requestId: null, requestTypeCode: 'BUY_GOODS', expectedVersion: null, draft: {} }))
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
  })
})

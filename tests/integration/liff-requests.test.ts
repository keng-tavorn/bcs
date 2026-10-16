import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '@/server/context'

// The LIFF page's session is what these tests choose: the LIFF request pages' server side runs with whatever
// liffPage() hands it (src/app/liff/_lib/session.ts reads the cookies of a request, which a test has none of). The
// language of the screen is Thai. Everything else — the services, the commands, the Events — is the real path on real
// Postgres (BCS_TEST_DB).
// The fixtures send the same request again within the duplicate window (S6-13 · BR-DUP-05): the form would ask why
const AGAIN = 'ส่งซ้ำโดยตั้งใจในเทสต์'
const session = vi.hoisted(() => ({ page: { kind: 'signed-out' } as unknown }))
vi.mock('@/app/liff/_lib/session', () => ({ liffPage: async () => session.page }))
vi.mock('next-intl/server', () => ({ getLocale: async () => 'th' }))
// The roles a request page asks request.view with: the session's (src/app/liff/requests/_lib/principal.ts reads them
// from the request's cookies, which a test has none of) — here the member's roles in the database, as the session holds them
vi.mock('@/app/liff/requests/_lib/principal', async (importOriginal) => {
  const { memberPrincipal } = await import('@/server/authz')
  const { STORED_ROLES } = await import('@/server/authz/permissions')
  const { prisma } = await import('@/server/db/client')
  return {
    ...(await importOriginal<typeof import('@/app/liff/requests/_lib/principal')>()),
    liffPrincipalOf: async (memberId: string) => {
      const held = await prisma.roleAssignment.findMany({ where: { memberId, revokedAt: null }, select: { role: true } })
      return memberPrincipal(
        memberId,
        held.map((r) => r.role).filter((r): r is (typeof STORED_ROLES)[number] => (STORED_ROLES as readonly string[]).includes(r)),
      )
    },
  }
})

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
import { getDownloadUrl } from '@/server/services/files'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-06 · the server side of the LIFF request pages (§9.4 /liff/requests/new, /liff/requests/[id]; FR-LINE-003 AC1):
//  - the draft the LIFF form saves (POST /liff/requests/new/autosave) and the send (submitRequestAction) run the
//    workspace's commands with the context of the LIFF page, so every Event of the request says LIFF (here the context
//    is the one the test hands over as the LIFF page's; that a real LIFF page's context says LIFF is proved end to end
//    in tests/e2e/liff-requests.spec.ts, from the Events of requests made in the LINE-sized browser);
//  - a send runs once, whether it is tapped twice or sent again after a lost answer;
//  - the requester answers a question and sends a returned request again from LIFF, and nobody else can;
//  - nothing is saved, previewed, sent, uploaded or opened without a member session of the LIFF page;
//  - a file opens only through the request it belongs to, for a member who may view that request, or as the
//    requester's own upload the form has not linked yet — no other file of the organization (FR-PLT-004 AC2);
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
    member: { id: org.member[code]!, organizationId: org.organizationId, organizationName: 'องค์กรทดสอบ DOA', organizationKind: 'PRODUCTION', displayNameTh: `ผู้ใช้ ${code}`, displayNameEn: null, email: `${code}@test.bcs.local` },
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
    const sent = await submitRequestAction({ requestId, expectedVersion: version, resubmit: false, duplicateReason: AGAIN }, key)
    if (!sent.ok) throw new Error(`send refused: ${sent.code}`)
    expect(sent.requestId).toBe(requestId)
    expect(sent.sent.number).toMatch(/^PR-\d{4}-\d{5}$/)
    expect(sent.sent.waitingFor).toEqual([{ name: 'ผู้ใช้ vp_ops', principalName: null }])
    expect(await channelsOf(requestId, 'request.submitted')).toEqual(['LIFF'])
    const request = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, version: true } })
    expect(request.status).toBe('PENDING_APPROVAL')

    // A double tap, or a retry after a lost answer, is the same submission with the same key: the command ran once and
    // the answer is the same — one number, one request.submitted, one task
    expect(await submitRequestAction({ requestId, expectedVersion: version, resubmit: false, duplicateReason: AGAIN }, key)).toEqual(sent)
    expect(await channelsOf(requestId, 'request.submitted')).toEqual(['LIFF'])
    expect(await prisma.approvalTask.count({ where: { step: { route: { subjectType: 'REQUEST', subjectId: requestId } } } })).toBe(1)
    // A new send of a request that was sent is refused: for its state when it names the version the request has now,
    // for the version when it names the one the form saved before the send (the form then offers the latest version)
    expect(await submitRequestAction({ requestId, expectedVersion: request.version, resubmit: false, duplicateReason: AGAIN }, randomUUID())).toMatchObject({ ok: false, code: 'INVALID_STATE_TRANSITION' })
    expect(await submitRequestAction({ requestId, expectedVersion: version, resubmit: false, duplicateReason: AGAIN }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT_VERSION' })
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
  const sent = await submitRequestAction({ requestId, expectedVersion: version, resubmit: false, duplicateReason: AGAIN }, randomUUID())
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
    expect(await resubmitReturnedAction(requestId, key, AGAIN)).toEqual({ ok: true })
    expect(await resubmitReturnedAction(requestId, key, AGAIN)).toEqual({ ok: true })
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
    expect(await submitRequestAction({ requestId, expectedVersion: edit.version, resubmit: true, duplicateReason: AGAIN }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).toEqual({ status: 'RETURNED' })

    // The form's send of a returned request: resubmit, naming the version the requester checked
    asMember('req_con')
    const key = randomUUID()
    const sent = await submitRequestAction({ requestId, expectedVersion: edit.version, resubmit: true, duplicateReason: AGAIN }, key)
    if (!sent.ok) throw new Error(`send again refused: ${sent.code}`)
    expect(sent.requestId).toBe(requestId)
    expect(sent.sent.number).toMatch(/^PR-\d{4}-\d{5}$/)
    expect(sent.sent.waitingFor).toEqual([{ name: 'ผู้ใช้ vp_ops', principalName: null }])
    // A second tap with the same key: the same answer, the command ran once
    expect(await submitRequestAction({ requestId, expectedVersion: edit.version, resubmit: true, duplicateReason: AGAIN }, key)).toEqual(sent)

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
    const sent = await submitRequestAction({ requestId, expectedVersion: version, resubmit: false, duplicateReason: AGAIN }, randomUUID())
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
      expect(await submitRequestAction({ requestId, expectedVersion: version, resubmit: false, duplicateReason: AGAIN }, randomUUID())).toEqual(unauthenticated)
      expect(await attachFileAction(requestId, randomUUID(), 'OTHER', randomUUID())).toEqual(unauthenticated)
      expect(await answerInfoAction({ infoRequestId: randomUUID(), answer: 'คำตอบ' }, randomUUID())).toEqual(unauthenticated)
      expect(await resubmitReturnedAction(requestId, randomUUID())).toEqual(unauthenticated)
      expect(await cancelRequestAction({ requestId, reason: 'ไม่ต้องการแล้ว' }, randomUUID())).toEqual(unauthenticated)
      expect(await requestUploadAction({ fileName: 'ใบเสนอราคา.pdf', mimeType: 'application/pdf', sizeBytes: 1000 })).toEqual({ ok: false, reason: 'FAILED' })
      expect(await completeUploadAction('ticket')).toEqual({ ok: false, reason: 'FAILED' })
      expect(await downloadUrlAction(requestId, randomUUID())).toBeNull()
      expect(await downloadUrlAction(null, randomUUID())).toBeNull()
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
    const sent = await submitRequestAction({ requestId, expectedVersion: version, resubmit: false, duplicateReason: AGAIN }, randomUUID())
    expect(sent).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const draft = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, version: true, title: true } })
    expect(draft.status).toBe('DRAFT')
    expect(draft.version).toBe(version)
    expect(draft.title).not.toBe('แก้โดยคนอื่น')
    expect(await channelsOf(requestId, 'request.submitted')).toEqual([])
  })

  it('[FR-LINE-003/AC1] a send without a proper idempotency key is refused before the command runs', async () => {
    const { requestId, version } = await newDraft('req_con')
    expect(await submitRequestAction({ requestId, expectedVersion: version, resubmit: false, duplicateReason: AGAIN }, 'not-a-key')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
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

/** A file in the organization's storage as an upload records it, by member `code`, linked to `link` when given */
async function storedFile(code: string, link?: { subjectType: string; subjectId: string; kind: 'QUOTATION' | 'OTHER' | 'INVOICE' }): Promise<string> {
  const file = await prisma.fileObject.create({
    data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'quotation.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member[code]! },
  })
  if (link) await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, ...link } })
  return file.id
}

const SIGNED = /X-Amz-Signature=/

describe('[FR-PLT-004/AC2] [FR-LINE-003/AC1] a file opens from the LIFF request pages only through the request it belongs to', () => {
  it('[FR-PLT-004/AC2] gives a short-lived address for a file of the request to a member who may view it; another request’s file does not open through it', async () => {
    const requestId = await sentFromLiff()
    const other = await sentFromLiff()
    const file = await storedFile('req_con', { subjectType: 'Request', subjectId: requestId, kind: 'QUOTATION' })
    const otherFile = await storedFile('req_con', { subjectType: 'Request', subjectId: other, kind: 'QUOTATION' })
    asMember('req_con')
    const url = await downloadUrlAction(requestId, file)
    expect(url).toMatch(SIGNED)
    expect(Number(new URL(url!).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
    // The requester may read both requests, yet each file opens only through its own request
    expect(await downloadUrlAction(other, otherFile)).toMatch(SIGNED)
    expect(await downloadUrlAction(requestId, otherFile)).toBeNull()
    expect(await downloadUrlAction(other, file)).toBeNull()
    // Nor as an upload of the form: it is linked to a document now
    expect(await downloadUrlAction(null, file)).toBeNull()
    // The approver whose task it is views the request and opens the file; a member with no part in it does not
    asMember('vp_ops')
    expect(await downloadUrlAction(requestId, file)).toMatch(SIGNED)
    asMember('dm_fin')
    expect(await downloadUrlAction(requestId, file)).toBeNull()
    // Something that is not an id
    asMember('req_con')
    expect(await downloadUrlAction(requestId, '../../etc/passwd')).toBeNull()
    expect(await downloadUrlAction('../../etc/passwd', file)).toBeNull()
  })

  it('[FR-PLT-004/AC2] opens no file of another kind of document through a request, even one the member may read elsewhere', async () => {
    const requestId = await sentFromLiff()
    const file = await storedFile('req_con', { subjectType: 'Request', subjectId: requestId, kind: 'QUOTATION' })
    // An AUDITOR reads every request (request.view ORG) and the invoices' files (audit.view) in the workspace
    if (!(await prisma.roleAssignment.findFirst({ where: { memberId: org.member.auditor!, role: 'AUDITOR', revokedAt: null } }))) {
      await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW } })
    }
    const invoice = await storedFile('fin_officer', { subjectType: 'InvoiceConfirmation', subjectId: randomUUID(), kind: 'INVOICE' })
    expect((await getDownloadUrl(org.ctxOf('auditor', NOW, 'LIFF'), { fileId: invoice })).ok).toBe(true)
    asMember('auditor')
    expect(await downloadUrlAction(requestId, file)).toMatch(SIGNED)
    // Through the request pages of LIFF the invoice opens neither through a request nor as an upload of the form
    expect(await downloadUrlAction(requestId, invoice)).toBeNull()
    expect(await downloadUrlAction(null, invoice)).toBeNull()
  })

  it('[FR-PLT-004/AC2] the form opens the requester’s own upload it has not linked yet, with or without a draft, and nobody else’s', async () => {
    const { requestId } = await newDraft('req_con')
    const mine = await storedFile('req_con')
    const theirs = await storedFile('asst_con')
    asMember('req_con')
    expect(await downloadUrlAction(null, mine)).toMatch(SIGNED)
    expect(await downloadUrlAction(requestId, mine)).toMatch(SIGNED)
    expect(await downloadUrlAction(null, theirs)).toBeNull()
    expect(await downloadUrlAction(requestId, theirs)).toBeNull()
    // Saved with the draft (a quotation's file), it opens through the draft only
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: mine, subjectType: 'Request', subjectId: requestId, kind: 'QUOTATION' } })
    expect(await downloadUrlAction(requestId, mine)).toMatch(SIGNED)
    expect(await downloadUrlAction(null, mine)).toBeNull()
    // Someone else's draft is not theirs to open, its files neither
    asMember('asst_con')
    expect(await downloadUrlAction(requestId, mine)).toBeNull()
  })
})

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { NextIntlClientProvider } from 'next-intl'
import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '@/server/context'

// The LIFF page's session is what these tests choose: the page and its server actions run with whatever liffPage()
// hands them (src/app/liff/_lib/session.ts reads the cookies of a request, which a test has none of). The language of
// the screen is Thai, through next-intl's own translator. Everything else — the receiving view, the commands, the file
// service with the local S3 server (RustFS), the Events — is the real path on real Postgres (BCS_TEST_DB).
const session = vi.hoisted(() => ({ page: { kind: 'signed-out' } as unknown }))
vi.mock('@/app/liff/_lib/session', () => ({ liffPage: async () => session.page }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))
vi.mock('next-intl/server', async () => {
  const intl = await import('next-intl')
  const messages = (await import('../../messages/th.json')).default as Record<string, unknown>
  const translator = (namespace?: string) => intl.createTranslator({ locale: 'th', messages, ...(namespace ? { namespace } : {}) } as Parameters<typeof intl.createTranslator>[0])
  return { getLocale: async () => 'th', getTranslations: async (options?: string | { namespace?: string }) => translator(typeof options === 'string' ? options : options?.namespace) }
})

import { postReceipt } from '@/app/(workspace)/receiving/commands'
import { completeLiffUploadAction, postLiffReceiptAction, previewLiffReceiptAction, receiptPhotoUrlAction, requestLiffUploadAction } from '@/app/liff/gr/[poId]/actions'
import LiffReceivingPage from '@/app/liff/gr/[poId]/page'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { completeUpload, requestUpload } from '@/server/services/files'
import { assignSupplier } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { requestCloseShort } from '@/server/services/receiving'
import { createDraft, submitRequest } from '@/server/services/requests'
import { LiffProvider } from '@/ui/liff/liff-provider'
import type { ReceiptInput } from '@/ui/receiving/types'
import th from '../../messages/th.json'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-06 · the server side of /liff/gr/[poId] (FR-LINE-003 AC3, FR-P2P-006, the notices of FR-P2P-010 AC2):
//  - the page's server actions (src/app/liff/gr/[poId]/actions.ts) — the photo's presigned upload, the check, the
//    receipt and a photo's address — take the member from the LIFF page's session and run on channel LIFF;
//  - without a member session they do nothing and say the session ended (the camera says so, not "check the
//    connection"), whatever the page's state: signed out, a role still without TOTP, or no membership;
//  - the page says what the workspace's page says about closing the PO short: a close-short waiting for approval (to the
//    receiver: receiving goes on; to the others: it waits), one that waits for damaged goods being kept, and "ask
//    procurement" only when the member cannot close it short and nothing is waiting.
// Monday 5 Oct 2026 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const PLYWOOD = { description: 'ไม้อัด 10 มม.', quantity: '10', uom: 'แผ่น', unitPrice: '520.00' }
const PPE = { description: 'ชุด PPE', quantity: '10', uom: 'ชุด', unitPrice: '850.00' }
/** The first bytes of a JPEG as a phone's canvas writes it (the server recognises the type by them) */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...Array.from({ length: 52 }, (_, i) => i), 0xff, 0xd9])
const UNAUTHENTICATED = { ok: false, code: 'UNAUTHENTICATED' }
const NO_UPLOAD_SESSION = { ok: false, reason: 'UNAUTHENTICATED' }
/** The workspace's words the LIFF page repeats (messages/src/th/receiving.json, detail.*) */
const WORDS = {
  closeShortWaiting: 'ฝ่ายจัดซื้อขอปิดใบสั่งซื้อนี้ทั้งที่รับไม่ครบ และรออนุมัติอยู่ ถ้ามีของมาส่งก่อนอนุมัติ บันทึกรับได้ตามปกติ ระบบจะเลิกรอเฉพาะส่วนที่ยังไม่มา',
  closeShortWaitingOther: 'มีคำขอปิดใบสั่งซื้อนี้ทั้งที่รับไม่ครบ และรออนุมัติอยู่ ผู้อนุมัติได้รับแจ้งแล้ว',
  closeShortWaitsForDamaged: 'ยังขอปิดใบสั่งซื้อนี้ทั้งที่รับไม่ครบไม่ได้ เพราะของที่ยังไม่เข้าคือของเสียหายที่รออนุมัติให้รับไว้ รอผลการอนุมัติก่อน',
  askProcurement: 'ถ้าของที่ค้างจะไม่มาแล้ว แจ้งฝ่ายจัดซื้อให้ขอปิดใบสั่งซื้อทั้งที่รับไม่ครบ',
  viewOnly: 'คุณดูใบสั่งซื้อนี้ได้ แต่การบันทึกตรวจรับเป็นงานของผู้ตรวจรับของฝ่ายที่ขอ',
  check: 'ตรวจสอบก่อนบันทึก',
} as const

let org: DoaOrg
let supplierId: string
let siteId: string
const liff = (code: string) => org.ctxOf(code, NOW, 'LIFF')
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

beforeAll(async () => {
  execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012' } })).id
  siteId = (await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: 'SITE-A', nameTh: 'ไซต์งาน A' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
})

beforeEach(() => {
  session.page = { kind: 'signed-out' }
})

/** The LIFF page of a member of the test organization, as liffPage() hands it over (a LINE sign-in, channel LIFF) */
function asMember(code: string): Ctx {
  const ctx = liff(code)
  session.page = {
    kind: 'member',
    ctx,
    member: { id: org.member[code]!, organizationId: org.organizationId, organizationName: 'องค์กรทดสอบ DOA', displayNameTh: `ผู้ใช้ ${code}`, displayNameEn: null, email: `${code}@test.bcs.local` },
    session: 'liff',
  }
  return ctx
}

async function approveAll(subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** An urgent request of req_con drafted into its own PO, approved, and marked sent (the e-mail is S4-06's) */
async function sentPo(lines: ReadonlyArray<typeof PPE>) {
  const budgetLine = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, departmentId: org.department.CON! }, orderBy: { code: 'asc' } })
  const requester = org.ctxOf('req_con', NOW)
  const draft = ok(await createDraft(requester, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุหน้างาน', urgency: 'URGENT', budgetLineId: budgetLine.id, deliverySiteId: siteId, lines: [...lines] }, key()))
  ok(await submitRequest(requester, { requestId: draft.requestId }, key()))
  await approveAll(draft.requestId)
  const requestLines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId }, orderBy: { lineNo: 'asc' } })
  const assigned = ok(await assignSupplier(org.ctxOf('proc_officer', NOW), { requestLineIds: requestLines.map((l) => l.id), supplierId }, key()))
  const poId = assigned.purchaseOrderIds[0]!
  ok(await submitPo(org.ctxOf('proc_officer', NOW), { poId }, key()))
  await approveAll(poId)
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'SENT', sentAt: NOW } })
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  return { poId, number: po.number!, lineIds: po.lines.map((l) => l.id) }
}

const receipt = (poId: string, lines: ReceiptInput['lines'], extra: Partial<ReceiptInput> = {}): ReceiptInput => ({ poId, deliveryNoteNo: '', notes: '', photoFileIds: [], lines, ...extra })
const line = (poLineId: string, received: string, extra: Partial<ReceiptInput['lines'][number]> = {}): ReceiptInput['lines'][number] => ({ poLineId, received, rejected: '', damaged: false, remark: '', ...extra })

/** The PUT of a presigned address, as the phone sends the photo's bytes */
async function put(uploadUrl: string) {
  const answer = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array(JPEG) })
  expect(answer.status).toBe(200)
}

/** The LIFF page as the member's phone gets it from the server: the page rendered in the LIFF provider, in Thai */
async function pageFor(code: string, poId: string): Promise<string> {
  asMember(code)
  const page = await LiffReceivingPage({ params: Promise.resolve({ poId }) })
  return markup(page)
}

function markup(node: ReactNode): string {
  const intl = { locale: 'th', messages: th, timeZone: 'Asia/Bangkok' } as ComponentProps<typeof NextIntlClientProvider>
  const liffProps = { config: { liffId: null, mock: { lineUserId: `U${'0'.repeat(32)}`, cookie: 'bcs-liff-mock-user' }, session: 'liff' } } as ComponentProps<typeof LiffProvider>
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl, createElement(LiffProvider, liffProps, node)))
}

describe('[FR-LINE-003/AC3] the actions of the LIFF receiving page run with the page’s member, on channel LIFF', () => {
  it('[FR-LINE-003/AC3] a receiver signed in through LINE sends a photo, checks and posts the receipt through the page’s actions: the photo is on the GR, the Events say LIFF, and the photo opens only for those who may see the receipt', async () => {
    const po = await sentPo([PLYWOOD, PPE])
    asMember('receiver_con')
    const started = await requestLiffUploadAction({ fileName: 'site-delivery.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG.length })
    if (!started.ok) throw new Error(`no upload address: ${started.reason}`)
    await put(started.uploadUrl)
    const done = await completeLiffUploadAction(started.ticket)
    if (!done.ok) throw new Error(`not recorded: ${done.reason}`)
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: done.fileId, type: 'file.uploaded' } })).toMatchObject({ channel: 'LIFF', actorMemberId: org.member.receiver_con })

    const lines = [line(po.lineIds[0]!, '6'), line(po.lineIds[1]!, '10')]
    expect(await previewLiffReceiptAction({ poId: po.poId, photoFileIds: [done.fileId], lines }, randomUUID())).toMatchObject({ ok: true, preview: { poStatusAfter: 'PARTIALLY_RECEIVED', linesOutstandingAfter: 1 } })
    const posted = await postLiffReceiptAction(receipt(po.poId, lines, { deliveryNoteNo: 'DN-2569-0815', photoFileIds: [done.fileId] }), randomUUID())
    expect(posted).toMatchObject({ ok: true, poStatus: 'PARTIALLY_RECEIVED', pendingApproval: 0 })
    const gr = await prisma.goodsReceipt.findFirstOrThrow({ where: { poId: po.poId } })
    expect(await prisma.fileLink.findMany({ where: { fileId: done.fileId }, select: { subjectType: true, subjectId: true, kind: true } })).toEqual([{ subjectType: 'GoodsReceipt', subjectId: gr.id, kind: 'PHOTO' }])
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: gr.id, type: 'gr.posted' } })).toMatchObject({ channel: 'LIFF', actorMemberId: org.member.receiver_con })

    // The photo's address: for the receiver, not for a member with no part in the PO
    expect(await receiptPhotoUrlAction(done.fileId)).toMatch(/X-Amz-Expires=\d+/)
    asMember('dm_it')
    expect(await receiptPhotoUrlAction(done.fileId)).toBeNull()
    // The idempotency key comes from the page: a malformed one is refused before anything runs
    asMember('receiver_con')
    expect(await postLiffReceiptAction(receipt(po.poId, [line(po.lineIds[0]!, '1')]), 'not-a-key')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(1)
  })
})

describe('[FR-LINE-003/AC3] without a member session of the LIFF page nothing is sent, checked, posted or opened, and the answer says the session ended', () => {
  for (const page of [{ kind: 'signed-out' }, { kind: 'needs-2fa-setup', session: 'liff' }, { kind: 'no-membership', session: 'web' }] as const) {
    it(`[FR-LINE-003/AC3] a page that is ${page.kind}`, async () => {
      const po = await sentPo([PPE])
      // A photo the receiver uploaded earlier, while signed in
      const photoCtx = liff('receiver_con')
      const started = ok(await requestUpload(photoCtx, { fileName: 'earlier.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG.length }))
      await put(started.uploadUrl)
      const photo = ok(await completeUpload(photoCtx, { ticket: started.ticket }, { sender: null })).fileId
      const counts = async () => ({
        receipts: await prisma.goodsReceipt.count({ where: { poId: po.poId } }),
        files: await prisma.fileObject.count({ where: { organizationId: org.organizationId } }),
        events: await prisma.event.count({ where: { organizationId: org.organizationId } }),
      })
      const before = await counts()

      session.page = page
      const lines = [line(po.lineIds[0]!, '2')]
      expect(await previewLiffReceiptAction({ poId: po.poId, photoFileIds: [photo], lines }, randomUUID())).toEqual(UNAUTHENTICATED)
      expect(await postLiffReceiptAction(receipt(po.poId, lines, { photoFileIds: [photo] }), randomUUID())).toEqual(UNAUTHENTICATED)
      expect(await requestLiffUploadAction({ fileName: 'site.jpg', mimeType: 'image/jpeg', sizeBytes: JPEG.length })).toEqual(NO_UPLOAD_SESSION)
      expect(await completeLiffUploadAction(started.ticket)).toEqual(NO_UPLOAD_SESSION)
      expect(await receiptPhotoUrlAction(photo)).toBeNull()
      expect(await counts()).toEqual(before)
      // The page shows no part of the PO, only the gate
      const html = markup(await LiffReceivingPage({ params: Promise.resolve({ poId: po.poId }) }))
      expect(html).not.toContain(po.number)
      expect(html).not.toContain(WORDS.check)
    })
  }
})

// Shown only: PROCUREMENT asks for the close-short on the web (FR-P2P-010 is a workspace task); LIFF says where it stands
describe('[FR-P2P-010/AC2] the LIFF receiving page says what the workspace’s page says about closing the PO short', () => {
  it('[FR-P2P-010/AC2] before anyone asks, the receiver is told to ask procurement; once a close-short waits, the receiver may still receive and is told so, and procurement — who only views the page — is told it waits for its approver', async () => {
    const po = await sentPo([PPE])
    expect(await postReceipt(liff('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '6')]), randomUUID())).toMatchObject({ ok: true, poStatus: 'PARTIALLY_RECEIVED' })

    // Partly received, nothing asked yet: the receiver cannot close it short, so the page says whom to ask
    const before = await pageFor('receiver_con', po.poId)
    expect(before).toContain(WORDS.askProcurement)
    expect(before).not.toContain(WORDS.closeShortWaiting)

    ok(await requestCloseShort(org.ctxOf('proc_officer', NOW), { poId: po.poId, reason: 'ผู้ขายแจ้งว่าชุด PPE รุ่นนี้หมด' }, key()))

    const receiver = await pageFor('receiver_con', po.poId)
    expect(receiver).toContain(WORDS.closeShortWaiting)
    expect(receiver).not.toContain(WORDS.closeShortWaitingOther)
    expect(receiver).not.toContain(WORDS.askProcurement)
    // Receiving goes on while the close-short waits
    expect(receiver).toContain(WORDS.check)

    const procurement = await pageFor('proc_officer', po.poId)
    expect(procurement).toContain(WORDS.viewOnly)
    expect(procurement).toContain(WORDS.closeShortWaitingOther)
    expect(procurement).not.toContain(WORDS.closeShortWaiting)
    expect(procurement).not.toContain(WORDS.check)
  })

  it('[FR-P2P-010/AC2] what is still to come is damaged goods waiting to be kept: procurement is told why it cannot be closed short yet', async () => {
    const po = await sentPo([PLYWOOD])
    const photo = (
      await prisma.fileObject.create({
        data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}`, fileName: 'damaged.jpg', mimeType: 'image/jpeg', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.receiver_con! },
      })
    ).id
    // All 10 came, 1 damaged and kept: waiting for its approver, so nothing can be given up now
    const posted = await postReceipt(liff('receiver_con'), receipt(po.poId, [line(po.lineIds[0]!, '10', { rejected: '1', damaged: true, damagedDisposition: 'ACCEPT_DAMAGED' })], { photoFileIds: [photo] }), randomUUID())
    expect(posted).toMatchObject({ ok: true, pendingApproval: 1 })

    const procurement = await pageFor('proc_officer', po.poId)
    expect(procurement).toContain(WORDS.viewOnly)
    expect(procurement).toContain(WORDS.closeShortWaitsForDamaged)
    expect(procurement).not.toContain(WORDS.closeShortWaitingOther)
    // As on the workspace's page, only a member who may close it short is told what closing short waits for
    expect(await pageFor('receiver_con', po.poId)).not.toContain(WORDS.closeShortWaitsForDamaged)
  })
})

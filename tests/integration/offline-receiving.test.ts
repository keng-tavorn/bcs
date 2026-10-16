// tests/golden/offline-receiving.yaml (spec §7.20, S17-12, BR-APP-08, BR-APP-10, BR-APP-14, OQ-170): receipts captured
// on the phone without a signal and sent later go through gr.post as it is, with Postgres for real — the same money as
// online (GC-GR-05), one GR per key however often it is sent, the photos' files reused, and the capture time checked.
// The runner sends each item as the queue of /go/receive does: its key as the idempotencyKey, the APP channel, and
// `offline` { capturedAt, capturedByMemberId, expectedPoVersion }; the server's clock is NOW. store_p07 is the
// receiver of the fixture (receiver_con); store_p06 and OTHER_RECEIVER another receiver of the department (asst_con).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { fund } from '@/core/budget'
import { formatSatang } from '@/core/money/format'
import { putObject } from '@/integrations/storage'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { completeUpload, requestUpload } from '@/server/services/files'
import { assignSupplier } from '@/server/services/procurement'
import { cancelPurchaseOrder, submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createDraft, submitRequest } from '../support/requests'

const NOW = new Date('2026-11-02T03:00:00Z')
const SENT_AT = new Date('2026-10-30T02:00:00Z')
const MEMBER: Readonly<Record<string, string>> = { store_p07: 'receiver_con', store_p06: 'asst_con', OTHER_RECEIVER: 'asst_con' }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

interface Item {
  key: string
  received: string
  by?: string
  excessDisposition?: 'RETURN_EXCESS' | 'ACCEPT_EXCESS'
  capturedAt: string
  expectedPoVersion?: number
  poSentAt?: string
  photos?: number
}
interface Case {
  id: string
  title: string
  input: {
    po: { ordered: string; unitPrice: string; version: number }
    tolerancePct: number
    budgetAvailable?: string
    actor?: string
    separatePos?: boolean
    before?: Array<{ onlineGrBy?: string; received?: string; cancelPo?: 'RETURN_TO_POOL' }>
    items: Item[]
    steps?: Array<{ send?: string; dropResponse?: boolean; upload?: string; completeAnswerLost?: number }>
  }
  expect: Record<string, unknown>
}

const suite = parse(readFileSync(path.resolve(import.meta.dirname, '../golden/offline-receiving.yaml'), 'utf8')) as { cases: Case[] }

let org: DoaOrg
let supplierId: string
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'BCS_GO', enabled: true, enabledAt: NOW, contractRef: 'TEST-S17', reason: 'ทดสอบแอป BCS Go' } })
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012' } })).id
  for (const code of ['receiver_con', 'asst_con']) {
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member[code]!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
  }
})

async function setTolerance(pct: number) {
  const row = await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })
  await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...(row.settings as Record<string, unknown>), receiving: { overTolerancePct: pct } } } })
}

async function fundedLine(satang: bigint): Promise<string> {
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
  const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CC-CON' } })
  const line = await prisma.budgetLine.create({ data: { organizationId: org.organizationId, fiscalYearId: fy.id, departmentId: org.department.CON!, costCenterId: cc.id, code: `CON-${randomUUID().slice(0, 8)}`, nameTh: 'งบทดสอบ', plannedSatang: 0n } })
  await prisma.budgetLineBalance.create({ data: { organizationId: org.organizationId, budgetLineId: line.id } })
  const seedCtx = systemCtx(org.organizationId, NOW, 'seed')
  const importId = randomUUID()
  await forTenant(org.organizationId).$transaction(async (tx) => {
    const r = await applyBudget(tx, seedCtx, [{ budgetLineId: line.id, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, satang, importId) }])
    if (!r.ok) throw new Error('fund failed')
    await appendEvents(tx, seedCtx, r.events)
  })
  return line.id
}

async function approveAll(subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** "30.00" → 3000n (the cases write baht with two decimals at most) */
const satangOf = (baht: string) => {
  const [whole, decimals = ''] = baht.split('.')
  return BigInt(whole! + decimals.padEnd(2, '0'))
}

/** A PO of one line, SENT at `sentAt` and at `version`, on a budget line with `budgetAvailable` left after it */
async function sentPo(c: Case['input'], sentAt: Date) {
  const unitSatang = satangOf(c.po.unitPrice)
  const orderedNet = (unitSatang * BigInt(Math.round(Number(c.po.ordered) * 10_000))) / 10_000n
  const budgetLineId = await fundedLine(orderedNet + (c.budgetAvailable ? satangOf(c.budgetAvailable) : 100_000_000n))
  const requester = org.ctxOf('req_con', NOW)
  const draft = ok(await createDraft(requester, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุหน้างาน', urgency: 'URGENT', budgetLineId, lines: [{ description: 'คอนกรีตผสมเสร็จ', quantity: c.po.ordered, uom: 'ลบ.ม.', unitPrice: c.po.unitPrice }] }, key()))
  ok(await submitRequest(requester, { requestId: draft.requestId }, key()))
  await approveAll(draft.requestId)
  const requestLines = await prisma.requestLine.findMany({ where: { requestId: draft.requestId } })
  const poId = ok(await assignSupplier(org.ctxOf('proc_officer', NOW), { requestLineIds: requestLines.map((l) => l.id), supplierId }, key())).purchaseOrderIds[0]!
  ok(await submitPo(org.ctxOf('proc_officer', NOW), { poId }, key()))
  await approveAll(poId)
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'SENT', sentAt, version: c.po.version } })
  const lineId = (await prisma.poLine.findFirstOrThrow({ where: { poId } })).id
  return { poId, lineId, budgetLineId }
}

const committedOf = async (budgetLineId: string) => (await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId } })).committedSatang

/** A photo of the receipt, uploaded as the page does: a ticket, the PUT, then the completion */
async function uploadPhoto(code: string, loseFirstAnswer: boolean): Promise<{ fileId: string; same: boolean }> {
  const ctx = org.ctxOf(code, NOW, 'APP')
  const bytes = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==', 'base64')
  const ticket = ok(await requestUpload(ctx, { fileName: 'delivery.jpg', mimeType: 'image/jpeg', sizeBytes: bytes.length }))
  const keyOf = JSON.parse(Buffer.from(ticket.ticket.split('.')[0]!, 'base64url').toString('utf8')) as { key: string }
  await putObject(keyOf.key, bytes, 'image/jpeg')
  const first = ok(await completeUpload(ctx, { ticket: ticket.ticket }))
  if (!loseFirstAnswer) return { fileId: first.fileId, same: true }
  // The answer was lost: the page completes again with the same ticket
  const again = ok(await completeUpload(ctx, { ticket: ticket.ticket }))
  return { fileId: again.fileId, same: again.fileId === first.fileId }
}

function send(code: string, poId: string, lineId: string, item: Item, version: number, photoFileIds: string[] = []) {
  const by = org.member[MEMBER[item.by ?? 'store_p07']!]!
  return postGoodsReceipt(
    org.ctxOf(code, NOW, 'APP'),
    {
      poId,
      photoFileIds,
      lines: [{ poLineId: lineId, received: item.received, ...(item.excessDisposition ? { excessDisposition: item.excessDisposition } : {}) }],
      offline: { capturedAt: item.capturedAt, capturedByMemberId: by, expectedPoVersion: item.expectedPoVersion ?? version },
    },
    { idempotencyKey: `${item.key}:${poId}` },
  )
}

type Outcome = { ok: true; data: { grId: string; poVersion: number } } | { ok: false; error: { code: string; details?: Record<string, unknown> } }
// A refusal as the queue shows it: its code, and for invalid input the reason the form explains
const shown = (r: Outcome) =>
  r.ok ? { outcome: 'SENT', poVersion: r.data.poVersion } : { outcome: 'NEEDS_ATTENTION', code: r.error.code, ...(r.error.code === 'VALIDATION_FAILED' && r.error.details?.reason ? { reason: r.error.details.reason } : {}) }

async function run(c: Case): Promise<Record<string, unknown>> {
  const i = c.input
  await setTolerance(i.tolerancePct)
  const actor = MEMBER[i.actor ?? 'store_p07']!
  if (i.separatePos) {
    const results: unknown[] = []
    for (const item of i.items) {
      const po = await sentPo(i, new Date(item.poSentAt!))
      const r = (await send(actor, po.poId, po.lineId, item, i.po.version)) as Outcome
      const gr = r.ok ? await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: r.data.grId } }) : null
      results.push(gr ? { key: item.key, outcome: 'SENT', receivedAt: gr.receivedAt.toISOString().replace('.000Z', 'Z'), offlineCapturedAt: gr.offlineCapturedAt!.toISOString().replace('.000Z', 'Z'), postedAt: gr.postedAt!.toISOString().replace('.000Z', 'Z') } : { key: item.key, ...shown(r) })
    }
    return { results }
  }
  const po = await sentPo(i, SENT_AT)
  const committedBefore = await committedOf(po.budgetLineId)
  let version = i.po.version
  for (const b of i.before ?? []) {
    if (b.onlineGrBy) {
      ok(await postGoodsReceipt(org.ctxOf(MEMBER[b.onlineGrBy]!, NOW), { poId: po.poId, photoFileIds: [], lines: [{ poLineId: po.lineId, received: b.received! }] }, key()))
      version++
    }
    if (b.cancelPo) ok(await cancelPurchaseOrder(org.ctxOf('proc_officer', NOW), { poId: po.poId, reason: 'ผู้ขายแจ้งว่าส่งของไม่ได้', disposition: b.cancelPo }, key()))
  }
  const out: Record<string, unknown> = {}
  if (i.steps) {
    const stepResults: unknown[] = []
    const photos: string[] = []
    let committedGr: string | null = null
    for (const step of i.steps) {
      if (step.upload) {
        const item = i.items.find((x) => x.key === step.upload)!
        let same = true
        for (let n = 0; n < (item.photos ?? 0); n++) {
          const up = await uploadPhoto(actor, n < (step.completeAnswerLost ?? 0))
          photos.push(up.fileId)
          same &&= up.same
        }
        stepResults.push({ photosStored: photos.length, sameFileIdAfterRetry: same })
        continue
      }
      const item = i.items.find((x) => x.key === step.send)!
      const r = (await send(actor, po.poId, po.lineId, item, i.po.version, photos)) as Outcome
      if (step.dropResponse) {
        // The server recorded it; the phone never heard: it tries again with the same key
        committedGr = r.ok ? r.data.grId : null
        stepResults.push({ outcome: 'RETRY', committedOnServer: r.ok })
      } else {
        stepResults.push({ ...shown(r), ...(committedGr ? { sameGrAsCommitted: r.ok && r.data.grId === committedGr } : {}) })
      }
    }
    out.stepResults = stepResults
    out.fileObjects = new Set(photos).size
  } else {
    const results: unknown[] = []
    for (const item of i.items) {
      const r = (await send(actor, po.poId, po.lineId, item, version)) as Outcome
      if (r.ok) version = r.data.poVersion
      results.push(shown(r))
    }
    out.results = results
  }
  const grs = await prisma.goodsReceipt.findMany({ where: { poId: po.poId }, select: { id: true } })
  const lineAfter = await prisma.poLine.findUniqueOrThrow({ where: { id: po.lineId } })
  const variances = await prisma.variance.findMany({ where: { poId: po.poId }, orderBy: { createdAt: 'asc' } })
  const poAfter = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId } })
  out.grCount = grs.length
  out.grPostedEvents = await prisma.event.count({ where: { type: 'gr.posted', aggregateId: { in: grs.map((g) => g.id) } } })
  out.accepted = Number(lineAfter.receivedQuantity.toString()).toString()
  out.commitDelta = formatSatang((await committedOf(po.budgetLineId)) - committedBefore).replace(/,/g, '')
  out.variances = variances.map((v) => ({ type: v.type, quantity: Number(v.quantity.toString()).toString(), amount: formatSatang(v.amountSatang).replace(/,/g, ''), needsApproval: v.status === 'PENDING_APPROVAL' }))
  out.poStatus = poAfter.status
  out.photoLinks = grs.length ? await prisma.fileLink.count({ where: { subjectType: 'GoodsReceipt', subjectId: { in: grs.map((g) => g.id) }, kind: 'PHOTO' } }) : 0
  return out
}

describe('golden offline-receiving.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, async () => {
      const got = await run(c)
      expect(Object.fromEntries(Object.keys(c.expect).map((k) => [k, got[k]]))).toEqual(c.expect)
    })
  }
})

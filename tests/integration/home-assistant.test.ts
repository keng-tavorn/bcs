import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { agreementDay } from '@/core/pricing/agreement'
import { MS_PER_DAY, MS_PER_HOUR } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { allSuggestions, dismissSuggestion, homeSuggestions, type SuggestionDto } from '@/server/services/assistants/suggestions'
import { manageFollowers } from '@/server/services/requests/followers'
import { AP_NOW, apOrg, codedDraft, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'
import { p2p } from '../support/p2p'
import { createDraft, submitRequest } from '../support/requests'

// NEW-121 (ADR-078): the home card "ผู้ช่วยเจอให้คุณ" against Postgres. One organization holds a situation for every
// kind — a request waiting past its due time, one flagged as a duplicate and priced above three earlier POs, a budget
// line nearly spent, an agreed price ending in ten days, and an invoice ready for payment from a supplier the registry
// reports ceased — and each member gets only what its source shows them. Setting one aside is the member's own.

const NOW = AP_NOW
const DRILL = 'สว่านไฟฟ้า 18V'

let ap: ApOrg
let drill: { requestId: string; taskId: string; approver: string }

const as = (code: string) => ap.org.ctxOf(code, NOW)
const codeOf = (memberId: string) => Object.entries(ap.org.member).find(([, id]) => id === memberId)![0]
/** Every suggestion of the member, not only the five the card shows */
const suggestions = async (code: string): Promise<SuggestionDto[]> => ok(await allSuggestions(as(code)))
const kindsOf = (list: readonly SuggestionDto[]) => new Set(list.map((s) => s.kind))

beforeAll(async () => {
  ap = await apOrg({ supplier: { registryFlag: 'CEASED' } })
  const { organizationId } = ap.org
  // an ORG_ADMIN reads every request, so may follow one, and has no task on it
  await prisma.roleAssignment.create({ data: { organizationId, memberId: ap.org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })

  // three POs of the drill in the last days: the reference the request is measured against (S6-11)
  const tools = (await prisma.supplier.create({ data: { organizationId, code: 'S-TOOLS', nameTh: 'ผู้ขายเครื่องมือ', isForeign: true } })).id
  for (const [day, price] of [
    ['2026-10-07T03:00:00Z', '2400.00'],
    ['2026-10-08T03:00:00Z', '2380.00'],
    ['2026-10-09T03:00:00Z', '2450.00'],
  ] as const) {
    const kit = p2p(ap.org, new Date(day))
    const line = await kit.fundedLine(100_000n)
    const request = await kit.approvedRequest(line, [{ quantity: '1', unitPrice: price, description: DRILL }])
    await kit.approvedPo(request.lines.map((l) => l.id), tools)
  }

  // the drill at 2,700.00, waiting for its approver, followed by the admin
  const line = await p2p(ap.org, NOW).fundedLine(100_000n)
  const draft = ok(await createDraft(as('req_con'), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องมือช่าง', budgetLineId: line, lines: [{ description: DRILL, quantity: '2', uom: 'ชิ้น', unitPrice: '2700.00' }] }, key()))
  ok(await submitRequest(as('req_con'), { requestId: draft.requestId }, key()))
  ok(await manageFollowers(as('req_con'), { requestId: draft.requestId, memberId: ap.org.member.admin!, follow: true }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } }, include: { step: { include: { route: true } } } })
  drill = { requestId: draft.requestId, taskId: task.id, approver: codeOf(task.assigneeMemberId) }
  // its approver's task went past its due time an hour ago, and the submit found it like an earlier request
  await prisma.approvalTask.update({ where: { id: task.id }, data: { dueAt: new Date(NOW.getTime() - MS_PER_HOUR) } })
  await prisma.requestFlag.create({ data: { organizationId, requestId: draft.requestId, routeNo: task.step.route.routeNo, kind: 'DUPLICATE', matchedRequestIds: [], detail: {} } })

  // a line of 1,000.00 with 990.00 of it asked for: 1% left, below the low warning
  const small = await p2p(ap.org, NOW).fundedLine(1_000n)
  const nearlySpent = ok(await createDraft(as('req_con'), { requestTypeCode: 'BUY_GOODS', title: 'ของจิปาถะ', budgetLineId: small, lines: [{ description: 'ถุงมือ', quantity: '1', uom: 'กล่อง', unitPrice: '990.00' }] }, key()))
  ok(await submitRequest(as('req_con'), { requestId: nearlySpent.requestId }, key()))

  // an agreed price that ends in ten days
  const item = await prisma.catalogItem.create({ data: { organizationId, code: 'CAT-GLOVE', nameTh: 'ถุงมือผ้า', uom: 'คู่', categoryCode: 'PPE' } })
  const today = new Date(`${agreementDay(NOW)}T00:00:00Z`)
  await prisma.priceAgreement.create({
    data: { organizationId, catalogItemId: item.id, supplierId: tools, unitPriceSatang: 2_500n, validFrom: new Date(today.getTime() - 100 * MS_PER_DAY), validTo: new Date(today.getTime() + 10 * MS_PER_DAY) },
  })

  // an invoice of the ceased supplier, submitted; the match holds it on the ceased registration, and the card reads the
  // supplier's flags of an invoice ready for payment, so the test puts it there (the match is not what is tested)
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
  await receive(ap, po, { 0: '1' })
  const invoice = await codedDraft(ap, po, { no: `HOME-${randomUUID().slice(0, 6)}`, vat: '0.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
  ok(await submit(ap, invoice))
  await prisma.invoice.update({ where: { id: invoice.invoiceId }, data: { status: 'READY_FOR_PAYMENT' } })
}, 600_000)

describe('[FR-VIS-006/AC7] what the rules found, each by its source’s own permission', () => {
  it('the requester and a follower read the request waiting past its due time; its approver does not, the task is theirs', async () => {
    const key = `FOLLOW_OVERDUE:${drill.taskId}`
    for (const code of ['req_con', 'admin']) {
      const found = (await suggestions(code)).find((s) => s.key === key)
      expect(found, code).toMatchObject({ kind: 'FOLLOW_OVERDUE', tone: 'DANGER', href: `/requests/${drill.requestId}`, title: 'เครื่องมือช่าง', waitingFor: { th: `ผู้ใช้ ${drill.approver}` } })
    }
    expect((await suggestions(drill.approver)).some((s) => s.kind === 'FOLLOW_OVERDUE' && s.key === key)).toBe(false)
    expect((await suggestions('receiver_con')).some((s) => s.key === key)).toBe(false)
  })

  it('due within a day it is "soon", with a key of its own; due later it is nothing yet', async () => {
    await prisma.approvalTask.update({ where: { id: drill.taskId }, data: { dueAt: new Date(NOW.getTime() + 2 * MS_PER_HOUR) } })
    const soon = await suggestions('req_con')
    expect(soon.find((s) => s.key === `FOLLOW_DUE_SOON:${drill.taskId}`)).toMatchObject({ tone: 'WARN' })
    expect(soon.some((s) => s.key === `FOLLOW_OVERDUE:${drill.taskId}`)).toBe(false)
    await prisma.approvalTask.update({ where: { id: drill.taskId }, data: { dueAt: new Date(NOW.getTime() + 3 * MS_PER_DAY) } })
    expect((await suggestions('req_con')).some((s) => s.key.endsWith(drill.taskId))).toBe(false)
    await prisma.approvalTask.update({ where: { id: drill.taskId }, data: { dueAt: new Date(NOW.getTime() - MS_PER_HOUR) } })
  })

  it('the approver reads the duplicate flag and the price above its reference on their task; the requester and the follower do not', async () => {
    const mine = await suggestions(drill.approver)
    expect(mine.find((s) => s.kind === 'REQUEST_FLAG')).toMatchObject({ key: `REQUEST_FLAG:${drill.taskId}:DUPLICATE`, href: `/tasks/${drill.taskId}`, flags: ['DUPLICATE'] })
    expect(mine.find((s) => s.kind === 'PRICE_HIGH')).toMatchObject({ key: `PRICE_HIGH:${drill.taskId}:1`, lineNo: 1, description: DRILL, deviationBp: 1250, samples: 3 })
    for (const code of ['req_con', 'admin']) {
      expect(kindsOf(await suggestions(code)).has('REQUEST_FLAG'), code).toBe(false)
      expect(kindsOf(await suggestions(code)).has('PRICE_HIGH'), code).toBe(false)
    }
  })

  it('PROCUREMENT reads the agreed price ending soon; the requester and FINANCE do not', async () => {
    expect((await suggestions('proc_officer')).find((s) => s.kind === 'AGREEMENT_EXPIRING')).toMatchObject({
      // named by its members: one agreement, and which one
      key: expect.stringMatching(/^AGREEMENT_EXPIRING:1:[0-9a-f]{16}$/),
      href: '/catalog/manage',
      count: 1,
      days: 30,
      first: { item: { th: 'ถุงมือผ้า' }, supplier: { th: 'ผู้ขายเครื่องมือ' } },
    })
    for (const code of ['req_con', 'fin_officer']) expect(kindsOf(await suggestions(code)).has('AGREEMENT_EXPIRING'), code).toBe(false)
  })

  it('FINANCE reads the budget line nearly spent; a requester, whose grant is the line in their own form, does not', async () => {
    const low = (await suggestions('fin_officer')).find((s) => s.kind === 'BUDGET_LOW')
    expect(low).toMatchObject({ tone: 'WARN', first: { availableBp: 100 } })
    expect(kindsOf(await suggestions('req_con')).has('BUDGET_LOW')).toBe(false)
  })

  it('FINANCE and AUDITOR read the payment flag of the supplier, in codes only; PROCUREMENT does not', async () => {
    for (const code of ['fin_officer', 'auditor']) {
      const flagged = (await suggestions(code)).find((s) => s.kind === 'SUPPLIER_FLAGS')
      expect(flagged, code).toMatchObject({ key: `SUPPLIER_FLAGS:${ap.supplierId}:REGISTRY_CHANGED`, tone: 'DANGER', supplier: { th: 'ผู้ขายหนึ่ง' }, flags: ['REGISTRY_CHANGED'], invoices: 1 })
      expect(flagged!.href).toMatch(/^\/finance\/invoices\//)
    }
    expect(kindsOf(await suggestions('proc_officer')).has('SUPPLIER_FLAGS')).toBe(false)
  })

  it('shows five at most, the most pressing first, and counts the rest', async () => {
    const r = ok(await homeSuggestions(as(drill.approver)))
    expect(r.total).toBe((await suggestions(drill.approver)).length)
    expect(r.items.length).toBeLessThanOrEqual(5)
    expect(r.total).toBeGreaterThanOrEqual(r.items.length)
    const tones = r.items.map((s) => s.tone)
    expect([...tones].sort((a, b) => ['DANGER', 'WARN', 'INFO'].indexOf(a) - ['DANGER', 'WARN', 'INFO'].indexOf(b))).toEqual(tones)
  })
})

describe('[FR-VIS-006/AC8] setting one aside', () => {
  it('is the member’s own: gone for them, still there for the follower, recorded once', async () => {
    const key = `FOLLOW_OVERDUE:${drill.taskId}`
    expect(ok(await dismissSuggestion(as('req_con'), { key }, { idempotencyKey: randomUUID(), sender: null }))).toEqual({ key })
    expect((await suggestions('req_con')).some((s) => s.key === key)).toBe(false)
    expect((await suggestions('admin')).some((s) => s.key === key)).toBe(true)
    const events = await prisma.event.findMany({ where: { organizationId: ap.org.organizationId, type: 'assistant.suggestion_dismissed', aggregateId: ap.org.member.req_con! } })
    expect(events.map((e) => e.data)).toEqual([{ kind: 'FOLLOW_OVERDUE', key }])
    // a second press changes nothing and records nothing
    expect(await dismissSuggestion(as('req_con'), { key }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await prisma.event.count({ where: { organizationId: ap.org.organizationId, type: 'assistant.suggestion_dismissed', aggregateId: ap.org.member.req_con! } })).toBe(1)
  })

  it('takes only a suggestion the member has now: not a made-up key, not another member’s', async () => {
    const theirs = (await suggestions('proc_officer')).find((s) => s.kind === 'AGREEMENT_EXPIRING')!.key
    for (const k of [`FOLLOW_OVERDUE:${randomUUID()}`, theirs]) {
      expect(await dismissSuggestion(as('req_con'), { key: k }, { idempotencyKey: randomUUID(), sender: null }), k).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    }
    expect(await prisma.assistantDismissal.count({ where: { organizationId: ap.org.organizationId, memberId: ap.org.member.req_con! } })).toBe(1)
    // and the one it was is still there for its member
    expect((await suggestions('proc_officer')).some((s) => s.key === theirs)).toBe(true)
  })

  it('a set is named by its members: another line low as one is closed is a new suggestion, though as many', async () => {
    const before = (await suggestions('fin_officer')).find((s) => s.kind === 'BUDGET_LOW')!
    ok(await dismissSuggestion(as('fin_officer'), { key: before.key }, { idempotencyKey: randomUUID(), sender: null }))
    expect((await suggestions('fin_officer')).some((s) => s.kind === 'BUDGET_LOW')).toBe(false)
    // the lowest line is closed, and another of 1,000.00 is nearly spent: as many low lines, not the same ones
    const lowest = await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: ap.org.organizationId, code: (before as Extract<SuggestionDto, { kind: 'BUDGET_LOW' }>).first.code } })
    await prisma.budgetLine.update({ where: { id: lowest.id }, data: { status: 'CLOSED' } })
    const line = await p2p(ap.org, NOW).fundedLine(1_000n)
    const draft = ok(await createDraft(as('req_con'), { requestTypeCode: 'BUY_GOODS', title: 'ของจิปาถะอีกชุด', budgetLineId: line, lines: [{ description: 'ถุงมือ', quantity: '1', uom: 'กล่อง', unitPrice: '990.00' }] }, key()))
    ok(await submitRequest(as('req_con'), { requestId: draft.requestId }, key()))
    const after = (await suggestions('fin_officer')).find((s) => s.kind === 'BUDGET_LOW')
    expect(after).toMatchObject({ count: (before as Extract<SuggestionDto, { kind: 'BUDGET_LOW' }>).count })
    expect(after!.key).not.toBe(before.key)
  })

  it('the same task in a new state shows again', async () => {
    await prisma.approvalTask.update({ where: { id: drill.taskId }, data: { dueAt: new Date(NOW.getTime() + 2 * MS_PER_HOUR) } })
    expect((await suggestions('req_con')).some((s) => s.key === `FOLLOW_DUE_SOON:${drill.taskId}`)).toBe(true)
    await prisma.approvalTask.update({ where: { id: drill.taskId }, data: { dueAt: new Date(NOW.getTime() - MS_PER_HOUR) } })
  })

  it('takes only a key of a known kind', async () => {
    for (const k of ['NOPE:1', '', 'x'.repeat(201)]) {
      expect(await dismissSuggestion(as('req_con'), { key: k }, { idempotencyKey: randomUUID(), sender: null }), k).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    }
  })
})

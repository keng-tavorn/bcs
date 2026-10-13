import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDraft, editRequest, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S13-03 (docs/sub-specs/S13.md BR-AI-17, ADR-148): the document commands take AI values in with aiAssist, a person
// as the actor, and refuse to send a document while a value the AI filled waits for the person (AI_REVIEW_PENDING).
// The AI actions here are rows as an agent leaves them (DRAFT, with what it proposed by form path): the assist contract
// reads AgentAction and the document only, so no model and no AI module are needed — a draft stays confirmable when AI
// is switched off (BR-AI-24).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let other: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  other = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
})

async function aiAction(
  o: DoaOrg,
  proposed: Record<string, string>,
  over: { purpose?: 'QUOTATION_READ' | 'DELIVERY_NOTE_READ' | 'INTAKE' | 'QUESTION'; status?: 'DRAFT' | 'ACCEPTED'; level?: 'L0' | 'L1'; subjectType?: string; subjectId?: string } = {},
) {
  const purpose = over.purpose ?? 'QUOTATION_READ'
  const row = await prisma.agentAction.create({
    data: {
      organizationId: o.organizationId,
      agent: purpose === 'INTAKE' ? 'INTAKE' : purpose === 'QUESTION' ? 'INSIGHT' : 'DOCUMENT',
      purpose,
      level: over.level ?? 'L1',
      status: over.status ?? 'DRAFT',
      channel: 'WEB',
      promptVersion: `${purpose}@1`,
      model: 'claude-sonnet-5-5',
      requestedById: o.member.req_con!,
      subjectType: over.subjectType ?? null,
      subjectId: over.subjectId ?? null,
      output: {},
      review: { requiredPaths: Object.keys(proposed), confirmedPaths: [], proposed },
      createdAt: NOW,
    },
  })
  return row.id
}

const line = { description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: '45000.00' }
const draftInput = { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [line] }
const action = (id: string) => prisma.agentAction.findUniqueOrThrow({ where: { id } })
const eventsOf = async (id: string) => (await prisma.event.findMany({ where: { aggregateType: 'AgentAction', aggregateId: id }, orderBy: { seq: 'asc' } })).map((e) => ({ type: e.type, data: e.data, actorType: e.actorType }))

describe('[BR-AI-17] a request keeps AI values waiting until the person confirms them, and cannot be sent before', () => {
  it('[BR-AI-17] request.create_draft takes the values in; request.submit refuses with AI_REVIEW_PENDING while two wait', async () => {
    const id = await aiAction(org, { title: 'วัสดุก่อสร้าง', 'lines.0.quantity': '1', 'lines.0.unitPrice': '45000.00' })
    const draft = await createDraft(org.ctxOf('req_con', NOW), { ...draftInput, aiAssist: { agentActionId: id, confirmedPaths: ['title'] } }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    expect(await action(id)).toMatchObject({ status: 'DRAFT', subjectType: 'REQUEST', subjectId: draft.data.requestId, appliedById: org.member.req_con })
    expect(await eventsOf(id)).toEqual([{ type: 'agent_action.applied', data: { subjectType: 'REQUEST', subjectId: draft.data.requestId, pending: 2 }, actorType: 'USER' }])
    const drafted = await prisma.event.findFirstOrThrow({ where: { aggregateId: draft.data.requestId, type: 'request.drafted' } })
    expect(drafted.data).toMatchObject({ agentActionId: id })

    const refused = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 2, agentActionIds: [id] } } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: draft.data.requestId } })).toMatchObject({ status: 'DRAFT', number: null })

    // Confirming the rest in the submit itself sends it, and the action is ACCEPTED (nothing changed)
    const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId, aiAssist: { agentActionId: id, confirmedPaths: ['lines.0.quantity', 'lines.0.unitPrice'] } }, key())
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    expect(await action(id)).toMatchObject({ status: 'ACCEPTED', decidedById: org.member.req_con, diff: null })
    expect((await eventsOf(id)).map((e) => e.type)).toEqual(['agent_action.applied', 'agent_action.accepted'])
  })

  it('[BR-AI-17] a value the person changed or removed counts as confirmed; the action is EDITED with what changed', async () => {
    const id = await aiAction(org, { title: 'วัสดุก่อสร้าง', 'lines.0.unitPrice': '45000.00', 'lines.1.description': 'ทรายหยาบ' })
    const draft = await createDraft(org.ctxOf('req_con', NOW), { ...draftInput, aiAssist: { agentActionId: id, confirmedPaths: [] } }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    // The person lowers the price (changed); the AI's second line never was on the form (removed); the title stays
    const edited = await editRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId, lines: [{ ...line, unitPrice: '40000.00' }] }, key())
    expect(edited.ok).toBe(true)
    const stillTitle = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
    expect(stillTitle).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 1 } } })
    const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId, aiAssist: { agentActionId: id, confirmedPaths: ['title'] } }, key())
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    const done = await action(id)
    expect(done.status).toBe('EDITED')
    expect(done.diff).toEqual({ 'lines.0.unitPrice': { ai: '45000.00', final: '40000.00' }, 'lines.1.description': { ai: 'ทรายหยาบ', final: null } })
    expect((await eventsOf(id)).at(-1)).toMatchObject({ type: 'agent_action.edited', data: { changedPaths: ['lines.0.unitPrice', 'lines.1.description'] } })
  })
})

describe('[BR-AI-17] the AI action must be of this organization, DRAFT at level L1, of a purpose that fills this document', () => {
  it('[BR-AI-17] another organization, a closed or L0 action, the wrong purpose or another document are refused, and nothing is saved', async () => {
    const cases: Array<[string, () => Promise<string>, string]> = [
      ['another organization', () => aiAction(other, { title: 'x' }), 'NOT_FOUND'],
      ['already accepted', () => aiAction(org, { title: 'x' }, { status: 'ACCEPTED' }), 'INVALID_STATE_TRANSITION'],
      ['an L0 result', () => aiAction(org, { title: 'x' }, { level: 'L0', purpose: 'QUESTION' }), 'INVALID_STATE_TRANSITION'],
      ['a delivery note', () => aiAction(org, { title: 'x' }, { purpose: 'DELIVERY_NOTE_READ' }), 'VALIDATION_FAILED'],
      ['applied to another request', async () => {
        const first = await createDraft(org.ctxOf('req_con', NOW), draftInput, key())
        if (!first.ok) throw new Error('draft')
        const id = await aiAction(org, { title: 'x' }, { subjectType: 'REQUEST', subjectId: first.data.requestId })
        await prisma.agentAction.update({ where: { id }, data: { appliedAt: NOW } })
        return id
      }, 'VALIDATION_FAILED'],
    ]
    for (const [name, make, code] of cases) {
      const id = await make()
      const before = await prisma.request.count({ where: { organizationId: org.organizationId } })
      const r = await createDraft(org.ctxOf('req_con', NOW), { ...draftInput, aiAssist: { agentActionId: id, confirmedPaths: ['title'] } }, key())
      expect(r.ok ? null : r.error.code, name).toBe(code)
      expect(await prisma.request.count({ where: { organizationId: org.organizationId } }), name).toBe(before)
    }
  })

  it('[BR-AI-17] a draft without aiAssist and a submit with nothing applied behave as before (EG-1)', async () => {
    const draft = await createDraft(org.ctxOf('req_con', NOW), draftInput, key())
    if (!draft.ok) throw new Error('draft')
    const drafted = await prisma.event.findFirstOrThrow({ where: { aggregateId: draft.data.requestId, type: 'request.drafted' } })
    expect(drafted.data).not.toHaveProperty('agentActionId')
    expect((await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())).ok).toBe(true)
  })
})

describe('[BR-AI-17] gr.post checks who, the PO and the version first, and the AI values last', () => {
  it('[BR-AI-17] no right or a PO in the wrong state answers its own code before aiAssist is looked at', async () => {
    const flow = p2p(org, NOW)
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขาย', taxId: '0999999000012' } })
    const request = await flow.approvedRequest(await flow.fundedLine(1_000_000n), [{ quantity: '3', unitPrice: '100.00' }])
    const po = await flow.approvedPo(request.lines.map((l) => l.id), supplier.id)
    const poLineId = po.lines[0]!.id
    const bogus = { agentActionId: randomUUID(), confirmedPaths: [`lines.${poLineId}.received`] }
    // The PO is approved but not sent: the PO's state answers first
    const early = await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId, received: '3' }], aiAssist: bogus }, key())
    expect(early.ok ? null : early.error.code).toBe('INVALID_STATE_TRANSITION')
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
    // Someone who may not receive for CON is refused as before
    const stranger = await postGoodsReceipt(org.ctxOf('fin_officer', NOW), { poId: po.id, lines: [{ poLineId, received: '3' }], aiAssist: bogus }, key())
    expect(stranger.ok ? null : stranger.error.code).toBe('FORBIDDEN')
    // The receiver reaches aiAssist: the action does not exist
    const missing = await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId, received: '3' }], aiAssist: bogus }, key())
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND')

    // A delivery note read for the PO: every proposed quantity must be confirmed in the same post (final)
    const dn = await aiAction(org, { [`lines.${poLineId}.received`]: '3' }, { purpose: 'DELIVERY_NOTE_READ', subjectType: 'PURCHASE_ORDER', subjectId: po.id })
    const waiting = await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId, received: '3' }], aiAssist: { agentActionId: dn, confirmedPaths: [] } }, key())
    expect(waiting).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 1 } } })
    expect(await prisma.goodsReceipt.count({ where: { poId: po.id } })).toBe(0)
    const posted = await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId, received: '3' }], aiAssist: { agentActionId: dn, confirmedPaths: [`lines.${poLineId}.received`] } }, key())
    if (!posted.ok) throw new Error(JSON.stringify(posted.error))
    expect(await action(dn)).toMatchObject({ status: 'ACCEPTED', subjectType: 'GOODS_RECEIPT', subjectId: posted.data.grId })
  })
})

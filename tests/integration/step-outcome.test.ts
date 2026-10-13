import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ok } from '@/core/result'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-DOA-004 AC6 (P1-07): every decide flow moves its document by what the step came to (completeStep), not by the
// decision of the task — the slot S6 fills with steps of several tasks. A completeStep that answers OPEN here, as a
// step of parallel reviewers will while others still have to decide: the task is decided, the request does not move
// and no task is made for the next step. Next steps are made by assignNextStep only.

const state = vi.hoisted(() => ({ open: false }))
vi.mock('@/server/services/approvals/step-complete', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/approvals/step-complete')>()
  return { ...real, completeStep: vi.fn((...args: Parameters<typeof real.completeStep>) => (state.open ? Promise.resolve(ok({ outcome: 'OPEN' as const, events: [] })) : real.completeStep(...args))) }
})

const NOW = new Date('2026-10-05T03:00:00Z')
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
})

async function waitingRequest() {
  const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', priceIncludesVat: true, lines: [{ description: 'ปูน', quantity: '1', uom: 'งาน', unitPrice: '5000.00' }] }, key())
  if (!draft.ok) throw new Error(JSON.stringify(draft.error))
  const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(JSON.stringify(sent.error))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, task }
}

describe('[FR-DOA-004/AC6] the document follows the step, not the task', () => {
  it('a step still OPEN: the task is approved, the request keeps its status, and no new task is made', async () => {
    const { requestId, task } = await waitingRequest()
    const before = await prisma.request.findUniqueOrThrow({ where: { id: requestId } })
    state.open = true
    try {
      expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: before.status } })
    } finally {
      state.open = false
    }
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'APPROVED' })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: before.status, version: before.version })
    expect(await prisma.approvalTask.count({ where: { step: { route: { subjectId: requestId } } } })).toBe(1)
    expect(await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: requestId } })).toMatchObject({ status: 'ACTIVE' })
  })

  it('the step result decides as before when the step is done', async () => {
    const { requestId, task } = await waitingRequest()
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'APPROVED' })
  })

  it('a task of a next step is made by assignNextStep only (and by the moves of a task, never by a decide flow)', () => {
    const makers = ['approvals/decide.ts', 'approvals/policy-decide.ts', 'purchase-orders/decide.ts', 'receiving/variance-decide.ts'].filter((f) =>
      readFileSync(path.join(ROOT, 'src/server/services', f), 'utf8').includes('approvalTask.create'),
    )
    expect(makers).toEqual([])
  })
})

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { getTaskView } from '@/server/queries/tasks'
import { startRoute } from '@/server/services/approvals/route'
import { draftDoaCopy, getDoaEditor, type DraftCopyInput } from '@/server/services/doa/editor'
import { getDoaSimulation } from '@/server/services/doa/simulate'
import type { DoaOrg } from '../support/doa-org'
import { createP1Org } from '../support/p1-org'

// What the DOA pages and the task card do with the phase-1 document types (P1-07): the table editor keeps a bank
// account change without a band (FR-DOA-001 AC4), the simulator routes the new types with the engine and takes no
// amount for a type without one (FR-DOA-009 AC4), and a task of a new subject names the DOA version and rule of its
// route like any task (FR-DOA-005 AC5). An organization of the phase-1 fixtures (createP1Org, DOA-P1 version 1).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let v1: string
const admin = () => org.ctxOf('admin', NOW)

beforeAll(async () => {
  org = await createP1Org()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  v1 = (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, status: 'PUBLISHED' } })).id
})

describe('[FR-DOA-001/AC4] the table editor keeps the new types; a type without an amount has no band', () => {
  it('a copy of the phase-1 version saves with BA-01 without a band; a band on it is refused BAND_NOT_ALLOWED', async () => {
    const view = await getDoaEditor(admin(), v1)
    if (!view.ok) throw new Error(JSON.stringify(view.error))
    expect(new Set(view.data.rules.map((r) => r.documentType)).size).toBe(11)
    expect(view.data.rules.find((r) => r.code === 'BA-01')).toMatchObject({ documentType: 'BANK_ACCOUNT_CHANGE', band: null })
    const input = (edit: (i: DraftCopyInput) => void = () => undefined): DraftCopyInput => {
      const i: DraftCopyInput = {
        sourceVersionId: view.data.source.id,
        effectiveDate: view.data.defaultEffectiveDate,
        changeReason: 'ทดลองแก้ข้อของระยะ 1',
        policy: { ...view.data.policy },
        rules: view.data.rules.map((r) => ({ code: r.code, documentType: r.documentType, band: r.band ? { ...r.band } : null, steps: r.steps.map((s) => ({ approver: { ...s.approver }, slaMinutes: s.slaMinutes })) })),
      }
      edit(i)
      return i
    }
    const banded = input((i) => {
      i.rules.find((r) => r.code === 'BA-01')!.band = { lowerKind: 'gt', lower: '0', upper: null }
    })
    expect(await draftDoaCopy(admin(), banded, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'BAND_NOT_ALLOWED', rule: 'BA-01' } } })
    const saved = await draftDoaCopy(admin(), input(), key())
    expect(saved).toMatchObject({ ok: true, data: { versionNo: 2 } })
    if (!saved.ok) return
    const rules = await prisma.doaRule.findMany({ where: { doaVersionId: saved.data.versionId }, select: { code: true, documentType: true, when: true } })
    expect(rules).toHaveLength(22)
    expect(rules.find((r) => r.code === 'BA-01')).toMatchObject({ documentType: 'BANK_ACCOUNT_CHANGE', when: {} })
  })
})

describe('[FR-DOA-009/AC4] the simulator routes the new types with the engine of the real routes', () => {
  it('a payment run goes to the CFO by PAY-01; a bank account change takes no amount and goes to the CFO by BA-01', async () => {
    const query = { department: org.department.HQ!, requester: org.member.fin_officer! }
    const run = await getDoaSimulation(admin(), v1, { ...query, type: 'PAYMENT_RUN', net: '3,200,000.00', vat: '' })
    if (!run.ok) throw new Error(JSON.stringify(run.error))
    expect(run.data.errors).toEqual({})
    expect(run.data.result?.version).toMatchObject({ ok: true, ruleCode: 'PAY-01' })
    expect(run.data.result?.version.ok && run.data.result.version.steps.map((s) => s.assignee.id)).toEqual([org.member.cfo])

    // An amount typed for a type without one is not read (the page shows no field for it)
    const bank = await getDoaSimulation(admin(), v1, { ...query, type: 'BANK_ACCOUNT_CHANGE', net: '100.00' })
    if (!bank.ok) throw new Error(JSON.stringify(bank.error))
    expect(bank.data.result?.version).toMatchObject({ ok: true, ruleCode: 'BA-01', basisAmount: null })
  })
})

describe('[FR-DOA-005/AC5] the task of a new subject names the DOA version and rule of its route', () => {
  it('the generic card of a payment run task: DOA-P1 version 1 rule PAY-01, linked to that version', async () => {
    const subjectId = randomUUID()
    const ctx = org.ctxOf('fin_officer', NOW)
    const started = await forTenant(org.organizationId).$transaction(async (tx) => {
      const r = await startRoute(
        tx,
        ctx,
        { type: 'PAYMENT_RUN', id: subjectId, label: 'รอบจ่าย' },
        { documentType: 'PAYMENT_RUN', amount: { netSatang: 320_000_000n, vatSatang: 0n }, requesterMemberId: org.member.fin_officer!, chargedDepartmentId: org.department.HQ!, conflictMemberIds: [org.member.fin_officer!], at: NOW },
      )
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      return r.data
    })
    const view = await getTaskView(org.ctxOf('cfo', NOW), started.firstTask.id)
    expect(view).toMatchObject({ subjectType: 'PAYMENT_RUN', subjectId })
    expect(view?.route?.doa).toMatchObject({ code: 'DOA-P1', versionNo: 1, ruleCode: 'PAY-01', versionId: v1 })
  })
})

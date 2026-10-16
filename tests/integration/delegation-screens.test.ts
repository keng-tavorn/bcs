import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { revokeDelegation } from '@/server/services/delegations'
import { createDelegationForDays, delegationState, getMyDelegations } from '@/server/services/delegations/view'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg } from '../support/doa-org'

// NEW-06 · FR-DOA-006 AC2 (web part, BR-DLG-01..05, §7.6): a delegator sets their own delegation on the web by whole
// days, sees it with its state, and revokes it; the delegate sees what they act for. Demo scene of S2: dm_con sets
// asst_con to act for them, and a 10,000 baht request then goes to asst_con.

// Monday 5 Oct 2026 10:00 Thai time
const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

describe('[FR-DOA-006/AC2] the delegator sets their own delegation on the web', () => {
  it('sets dm_con → asst_con for whole Thai days; a 10,000 baht request then goes to asst_con on behalf of dm_con', async () => {
    const org = await createDoaOrg()
    const dm = org.ctxOf('dm_con', NOW)
    const created = await createDelegationForDays(dm, { delegateMemberId: org.member.asst_con!, firstDay: '2026-10-05', lastDay: '2026-10-09', documentTypes: [], maxAmount: '', reason: 'ลาพักร้อน' }, key())
    expect(created).toMatchObject({ ok: true, data: { status: 'ACTIVE' } })
    if (!created.ok) return
    // [5 Oct 00:00, 10 Oct 00:00) Thai time, no cap, every document type
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: created.data.delegationId } })).toMatchObject({
      delegatorMemberId: org.member.dm_con,
      delegateMemberId: org.member.asst_con,
      startsAt: new Date('2026-10-04T17:00:00Z'),
      endsAt: new Date('2026-10-09T17:00:00Z'),
      documentTypes: [],
      maxAmountSatang: null,
      createdVia: 'SELF',
    })
    expect(await prisma.event.count({ where: { aggregateId: created.data.delegationId, type: 'delegation.created' } })).toBe(1)

    const mine = await getMyDelegations(dm)
    expect(mine).toMatchObject({ ok: true, data: { today: '2026-10-05', given: [{ id: created.data.delegationId, state: 'ACTIVE', delegate: { nameTh: 'ผู้ใช้ asst_con' }, maxAmount: null, reason: 'ลาพักร้อน' }], received: [] } })
    if (mine.ok) expect(mine.data.positions.map((p) => [p.positionTh, p.departmentTh])).toEqual([['DM', 'ฝ่ายก่อสร้าง']])
    const theirs = await getMyDelegations(org.ctxOf('asst_con', NOW))
    expect(theirs).toMatchObject({ ok: true, data: { given: [], positions: [], received: [{ id: created.data.delegationId, state: 'ACTIVE', delegator: { nameTh: 'ผู้ใช้ dm_con' } }] } })

    // The demo scene: req_con asks for 10,000 baht; the DM of CON's task goes to asst_con
    const requester = org.ctxOf('req_con', NOW)
    const draft = await createDraft(requester, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุหน้างาน', priceIncludesVat: true, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'งาน', unitPrice: '10000.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    expect(await submitRequest(requester, { requestId: draft.data.requestId }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.asst_con } })
    expect(await prisma.approvalTask.findFirstOrThrow({ where: { step: { route: { subjectId: draft.data.requestId } } } })).toMatchObject({
      assigneeMemberId: org.member.asst_con,
      principalMemberId: org.member.dm_con,
    })
  })

  it('keeps a cap in satang and the chosen document types; a later delegation is waiting to start', async () => {
    const org = await createDoaOrg()
    const created = await createDelegationForDays(
      org.ctxOf('dm_fin', NOW),
      { delegateMemberId: org.member.fin_officer!, firstDay: '2026-10-12', lastDay: '2026-10-12', documentTypes: ['PURCHASE_REQUEST', 'GR_VARIANCE'], maxAmount: ' 10,000.5 ', reason: 'ประชุมต่างจังหวัด' },
      key(),
    )
    expect(created).toMatchObject({ ok: true, data: { status: 'SCHEDULED' } })
    if (!created.ok) return
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: created.data.delegationId } })).toMatchObject({
      startsAt: new Date('2026-10-11T17:00:00Z'),
      endsAt: new Date('2026-10-12T17:00:00Z'),
      documentTypes: ['PURCHASE_REQUEST', 'GR_VARIANCE'],
      maxAmountSatang: 1_000_050n,
    })
    expect(await getMyDelegations(org.ctxOf('dm_fin', NOW))).toMatchObject({ ok: true, data: { given: [{ state: 'SCHEDULED', maxAmount: '10000.50', documentTypes: ['PURCHASE_REQUEST', 'GR_VARIANCE'] }] } })
  })

  it.each([
    ['a first day that is not a date', { firstDay: '2026-02-30', lastDay: '2026-10-09' }, { field: 'firstDay' }],
    // Yesterday in Thai time (now is Monday 5 Oct 10:00): a period already gone hands over nothing
    ['a first day before today', { firstDay: '2026-10-04', lastDay: '2026-10-09' }, { field: 'firstDay', reason: 'PAST_FIRST_DAY' }],
    ['a period wholly in the past', { firstDay: '2026-09-28', lastDay: '2026-10-02' }, { field: 'firstDay', reason: 'PAST_FIRST_DAY' }],
    ['a last day that is not a date', { firstDay: '2026-10-05', lastDay: '9/10/2569' }, { field: 'lastDay' }],
    ['a last day before the first', { firstDay: '2026-10-09', lastDay: '2026-10-05' }, { field: 'lastDay', reason: 'INVALID_PERIOD' }],
    ['a cap that is not an amount in baht', { firstDay: '2026-10-05', lastDay: '2026-10-09', maxAmount: '10.555' }, { field: 'maxAmount' }],
    ['a cap of zero', { firstDay: '2026-10-05', lastDay: '2026-10-09', maxAmount: '0' }, { reason: 'INVALID_AMOUNT' }],
    ['a reason shorter than 3 letters', { firstDay: '2026-10-05', lastDay: '2026-10-09', reason: 'ลา' }, { field: 'reason' }],
  ])('refuses %s', async (_label, input, details) => {
    const org = await createDoaOrg()
    const result = await createDelegationForDays(org.ctxOf('dm_it', NOW), { delegateMemberId: org.member.admin!, documentTypes: [], reason: 'ไปอบรม', ...input }, key())
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details } })
    expect(await prisma.delegation.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })

  it('offers a delegator only other active members; a member without a position gets no member list and nothing to delegate (BR-DLG-01)', async () => {
    const org = await createDoaOrg()
    await prisma.member.update({ where: { id: org.member.receiver_con! }, data: { status: 'DEACTIVATED' } })
    const dm = await getMyDelegations(org.ctxOf('dm_con', NOW))
    expect(dm).toMatchObject({ ok: true })
    if (dm.ok) {
      const ids = dm.data.candidates.map((c) => c.id)
      expect(ids).not.toContain(org.member.dm_con)
      expect(ids).not.toContain(org.member.receiver_con)
      expect(ids).toContain(org.member.asst_con)
      expect(dm.data.candidates.find((c) => c.id === org.member.req_con)).toMatchObject({ nameTh: 'ผู้ใช้ req_con', departmentTh: 'ฝ่ายก่อสร้าง' })
    }
    // Names and departments of the members go only to someone who can hand authority over
    const asst = org.ctxOf('asst_con', NOW)
    expect(await getMyDelegations(asst)).toMatchObject({ ok: true, data: { positions: [], candidates: [] } })
    const refused = await createDelegationForDays(asst, { delegateMemberId: org.member.req_con!, firstDay: '2026-10-05', lastDay: '2026-10-06', documentTypes: [], reason: 'ทดสอบ' }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NOTHING_TO_DELEGATE' } } })
  })

  it('shows a revoked delegation as revoked and one that has run its days as ended', async () => {
    const org = await createDoaOrg()
    const dm = org.ctxOf('dm_proc', NOW)
    const created = await createDelegationForDays(dm, { delegateMemberId: org.member.proc_officer!, firstDay: '2026-10-05', lastDay: '2026-10-06', documentTypes: [], reason: 'ไปอบรม' }, key())
    if (!created.ok) throw new Error('create failed')
    expect(await revokeDelegation(dm, { delegationId: created.data.delegationId }, key())).toMatchObject({ ok: true })
    expect(await getMyDelegations(dm)).toMatchObject({ ok: true, data: { given: [{ state: 'REVOKED' }] } })
    // The delegate no longer sees a revoked delegation
    expect(await getMyDelegations(org.ctxOf('proc_officer', NOW))).toMatchObject({ ok: true, data: { received: [] } })

    const row = { status: 'ACTIVE' as const, startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-06T00:00:00Z' }
    expect(delegationState(row, new Date('2026-10-04T23:59:59Z'))).toBe('SCHEDULED')
    expect(delegationState(row, new Date('2026-10-05T00:00:00Z'))).toBe('ACTIVE')
    expect(delegationState(row, new Date('2026-10-06T00:00:00Z'))).toBe('ENDED')
    expect(delegationState({ ...row, status: 'ENDED' }, new Date('2026-10-05T12:00:00Z'))).toBe('ENDED')
  })

  it('only a member sees and sets their own delegations (deny)', async () => {
    const org = await createDoaOrg()
    const system = systemCtx(org.organizationId, NOW, 'test')
    expect(await getMyDelegations(system)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await createDelegationForDays(system, { delegateMemberId: org.member.asst_con!, firstDay: '2026-10-05', lastDay: '2026-10-06', documentTypes: [], reason: 'ระบบ' }, key())).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    // A deactivated member keeps no access, not even to their own page
    await prisma.member.update({ where: { id: org.member.dm_con! }, data: { status: 'DEACTIVATED' } })
    const dm = org.ctxOf('dm_con', NOW)
    expect(await getMyDelegations(dm)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await createDelegationForDays(dm, { delegateMemberId: org.member.asst_con!, firstDay: '2026-10-05', lastDay: '2026-10-06', documentTypes: [], reason: 'ลาป่วย' }, key())).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(await prisma.delegation.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })
})

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { createDelegation, revokeDelegation } from '@/server/services/delegations'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-DOA-006 AC1 (BR-DLG-01..03): a position holder delegates for a period; the checks of core/delegation apply and a
// running delegation sends new tasks to the delegate (tests/integration/requests.test.ts covers the routing). Only the
// delegator cancels one, and only while its period runs or has yet to start (§6.4 Delegation, BR-DLG-04, NEW-35).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
})

const period = (from: string, to: string) => ({ startsAt: from, endsAt: to })

describe('[FR-DOA-006/AC1] the delegator sets a delegation; the checks of BR-DLG-01..03 apply', () => {
  it('saves a running delegation, tells the delegate, and refuses an overlapping one', async () => {
    const created = await createDelegation(
      org.ctxOf('dm_con', NOW),
      { delegateMemberId: org.member.asst_con!, ...period('2026-10-05T00:00:00+07:00', '2026-10-10T00:00:00+07:00'), reason: 'ลาพักร้อน' },
      key(),
    )
    expect(created).toMatchObject({ ok: true, data: { status: 'ACTIVE' } })
    if (!created.ok) return
    expect(await prisma.event.count({ where: { aggregateId: created.data.delegationId, type: 'delegation.created' } })).toBe(1)
    expect(await prisma.notification.count({ where: { recipientMemberId: org.member.asst_con, templateKey: 'delegation.created' } })).toBe(1)
    const overlap = await createDelegation(
      org.ctxOf('dm_con', NOW),
      { delegateMemberId: org.member.req_con!, ...period('2026-10-09T00:00:00+07:00', '2026-10-12T00:00:00+07:00'), reason: 'ต่อเวลา' },
      key(),
    )
    expect(overlap).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'OVERLAPPING_DELEGATION' } } })
    // [startsAt, endsAt): the next period may start exactly when this one ends
    const after = await createDelegation(
      org.ctxOf('dm_con', NOW),
      { delegateMemberId: org.member.req_con!, ...period('2026-10-10T00:00:00+07:00', '2026-10-12T00:00:00+07:00'), reason: 'ต่อเวลา' },
      key(),
    )
    expect(after).toMatchObject({ ok: true, data: { status: 'SCHEDULED' } })
  })

  it.each([
    ['someone without a position (NOTHING_TO_DELEGATE)', 'asst_con', 'req_con', '2026-10-06T00:00:00+07:00', '2026-10-07T00:00:00+07:00', 'NOTHING_TO_DELEGATE'],
    ['to oneself (SELF_DELEGATION)', 'dm_proc', 'dm_proc', '2026-10-06T00:00:00+07:00', '2026-10-07T00:00:00+07:00', 'SELF_DELEGATION'],
    ['a period that ends before it starts (INVALID_PERIOD)', 'dm_proc', 'proc_officer', '2026-10-07T00:00:00+07:00', '2026-10-06T00:00:00+07:00', 'INVALID_PERIOD'],
  ])('refuses %s', async (_label, delegator, delegate, from, to, reason) => {
    const r = await createDelegation(org.ctxOf(delegator, NOW), { delegateMemberId: org.member[delegate]!, ...period(from, to), reason: 'ทดสอบ' }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason } } })
  })

  it('only the delegator revokes a running delegation', async () => {
    const created = await createDelegation(
      org.ctxOf('dm_fin', NOW),
      { delegateMemberId: org.member.fin_officer!, ...period('2026-10-05T00:00:00+07:00', '2026-10-06T00:00:00+07:00'), reason: 'ประชุมนอกสถานที่' },
      key(),
    )
    if (!created.ok) throw new Error('create failed')
    expect(await revokeDelegation(org.ctxOf('fin_officer', NOW), { delegationId: created.data.delegationId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await revokeDelegation(org.ctxOf('dm_fin', NOW), { delegationId: created.data.delegationId }, key())).toMatchObject({ ok: true })
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: created.data.delegationId } })).toMatchObject({ status: 'REVOKED', revokedAt: NOW })
    expect(await revokeDelegation(org.ctxOf('dm_fin', NOW), { delegationId: created.data.delegationId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })

  it('[BR-DLG-04] refuses to cancel a delegation whose period is over, though its row still says ACTIVE or SCHEDULED (the job writes ENDED when it runs)', async () => {
    // Running now, until 00:00 on 7 Oct; and one set for later, from 9 Oct until 00:00 on 10 Oct (Thai time)
    const running = await createDelegation(
      org.ctxOf('dm_proc', NOW),
      { delegateMemberId: org.member.proc_officer!, ...period('2026-10-05T00:00:00+07:00', '2026-10-07T00:00:00+07:00'), reason: 'อบรมต่างจังหวัด' },
      key(),
    )
    const later = await createDelegation(
      org.ctxOf('dm_it', NOW),
      { delegateMemberId: org.member.admin!, ...period('2026-10-09T00:00:00+07:00', '2026-10-10T00:00:00+07:00'), reason: 'ลากิจ' },
      key(),
    )
    if (!running.ok || !later.ok) throw new Error('create failed')
    expect([running.data.status, later.data.status]).toEqual(['ACTIVE', 'SCHEDULED'])
    const endOfRunning = new Date('2026-10-07T00:00:00+07:00')
    const afterLater = new Date('2026-10-10T08:00:00+07:00')

    // At the end of the period (it is [startsAt, endsAt)) and after it, nothing is left to cancel: ENDED, nothing changes
    for (const [code, delegationId, at] of [
      ['dm_proc', running.data.delegationId, endOfRunning],
      ['dm_proc', running.data.delegationId, afterLater],
      ['dm_it', later.data.delegationId, afterLater],
    ] as const) {
      const refused = await revokeDelegation(org.ctxOf(code, at), { delegationId }, key())
      expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'ENDED' } } })
    }
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: running.data.delegationId } })).toMatchObject({ status: 'ACTIVE', revokedAt: null })
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: later.data.delegationId } })).toMatchObject({ status: 'SCHEDULED', revokedAt: null })
    expect(await prisma.event.count({ where: { type: 'delegation.revoked', aggregateId: { in: [running.data.delegationId, later.data.delegationId] } } })).toBe(0)

    // Someone else is refused first, whatever the period (FORBIDDEN before anything about the delegation is said)
    expect(await revokeDelegation(org.ctxOf('proc_officer', afterLater), { delegationId: running.data.delegationId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // A moment before its end it is still running, and its delegator cancels it
    const justBefore = new Date(endOfRunning.getTime() - 1)
    expect(await revokeDelegation(org.ctxOf('dm_proc', justBefore), { delegationId: running.data.delegationId }, key())).toMatchObject({ ok: true })
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: running.data.delegationId } })).toMatchObject({ status: 'REVOKED', revokedAt: justBefore })
  })
})

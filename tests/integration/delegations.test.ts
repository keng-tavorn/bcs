import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { createDelegation, revokeDelegation } from '@/server/services/delegations'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-DOA-006 AC1 (BR-DLG-01..03): a position holder delegates for a period; the checks of core/delegation apply and a
// running delegation sends new tasks to the delegate (tests/integration/requests.test.ts covers the routing).

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
})

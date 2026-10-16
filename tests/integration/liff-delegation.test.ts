import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { createDelegation, revokeDelegation } from '@/server/services/delegations'
import { createDelegationForDays, getMyDelegations } from '@/server/services/delegations/view'
import { createDraft, submitRequest } from '../support/requests'
import { endDelegationWindow } from '@/server/services/sla/delegation-window'
import { createDoaOrg } from '../support/doa-org'

// S5-06 · /liff/delegation (FR-DOA-006 AC2, the LIFF part; BR-DLG-01 to BR-DLG-03): the LIFF page's server actions
// (src/app/liff/delegation/actions.ts) take the member's context from the LIFF session — channel LIFF — and call the same
// services as the workspace's /settings/delegation. Here those calls run with a LIFF context against real Postgres: the
// delegation and its cancellation are recorded on channel LIFF and take effect as on the web, and the services refuse
// what the page never offers — someone else's delegation, one that ended, a member with nothing to hand over.
// Monday 5 Oct 2026 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const HOUR = 3_600_000
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

describe('[FR-DOA-006/AC2] an approver names and cancels an acting approver from LIFF', () => {
  it('names one for whole Thai days on channel LIFF; a request then goes to the delegate; cancelling it on LIFF hands new work back', async () => {
    const org = await createDoaOrg()
    const dm = org.ctxOf('dm_con', NOW, 'LIFF')
    const created = await createDelegationForDays(dm, { delegateMemberId: org.member.asst_con!, firstDay: '2026-10-05', lastDay: '2026-10-06', documentTypes: [], maxAmount: '20,000', reason: 'ลาพักร้อน' }, key())
    expect(created).toMatchObject({ ok: true, data: { status: 'ACTIVE' } })
    if (!created.ok) return
    const id = created.data.delegationId
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id } })).toMatchObject({
      startsAt: new Date('2026-10-04T17:00:00Z'),
      endsAt: new Date('2026-10-06T17:00:00Z'),
      maxAmountSatang: 2_000_000n,
      createdVia: 'SELF',
    })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: id, type: 'delegation.created' } })).toMatchObject({ channel: 'LIFF', actorMemberId: org.member.dm_con })
    expect(await getMyDelegations(dm)).toMatchObject({ ok: true, data: { given: [{ id, state: 'ACTIVE', maxAmount: '20000.00' }] } })

    // A request within the cap goes to the delegate on behalf of the DM, as when it was set on the web
    const requester = org.ctxOf('req_con', NOW)
    const draft = await createDraft(requester, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุหน้างาน', priceIncludesVat: true, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'งาน', unitPrice: '8000.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    expect(await submitRequest(requester, { requestId: draft.data.requestId }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.asst_con } })

    expect(await revokeDelegation(dm, { delegationId: id }, key())).toMatchObject({ ok: true })
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'REVOKED' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: id, type: 'delegation.revoked' } })).toMatchObject({ channel: 'LIFF', data: { from: 'ACTIVE' } })
    const later = org.ctxOf('req_con', new Date(NOW.getTime() + HOUR))
    const second = await createDraft(later, { requestTypeCode: 'BUY_GOODS', title: 'วัสดุเพิ่ม', priceIncludesVat: true, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'งาน', unitPrice: '8000.00' }] }, key())
    if (!second.ok) throw new Error('draft failed')
    expect(await submitRequest(later, { requestId: second.data.requestId }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.dm_con } })
  })

  it('refuses on LIFF what the page never offers: cancelling someone else’s delegation, cancelling one that ended, and delegating without a position', async () => {
    const org = await createDoaOrg()
    const dm = org.ctxOf('dm_con', NOW, 'LIFF')
    const running = await createDelegationForDays(dm, { delegateMemberId: org.member.asst_con!, firstDay: '2026-10-07', lastDay: '2026-10-08', reason: 'ประชุมต่างจังหวัด' }, key())
    if (!running.ok) throw new Error('not created')
    // Only the delegator cancels their own (delegation.manage, OWN): the delegate and an outsider are refused
    for (const code of ['asst_con', 'dm_it']) {
      expect(await revokeDelegation(org.ctxOf(code, NOW, 'LIFF'), { delegationId: running.data.delegationId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: running.data.delegationId } })).toMatchObject({ status: 'SCHEDULED' })

    // An ended delegation (its period over, ended by the delegation-window job) cannot be cancelled any more
    const past = await createDelegation(
      org.ctxOf('dm_con', NOW),
      { delegateMemberId: org.member.asst_con!, startsAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(), endsAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(), reason: 'ประชุมเช้า' },
      key(),
    )
    if (!past.ok) throw new Error('not created')
    expect(await endDelegationWindow(org.organizationId, past.data.delegationId, NOW)).toMatchObject({ done: true })
    expect(await getMyDelegations(dm)).toMatchObject({ ok: true, data: { given: expect.arrayContaining([expect.objectContaining({ id: past.data.delegationId, state: 'ENDED' })]) } })
    expect(await revokeDelegation(dm, { delegationId: past.data.delegationId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await prisma.delegation.findUniqueOrThrow({ where: { id: past.data.delegationId } })).toMatchObject({ status: 'ENDED' })

    // A member who holds no position has nothing to hand over (BR-DLG-01)
    expect(await createDelegationForDays(org.ctxOf('req_con', NOW, 'LIFF'), { delegateMemberId: org.member.asst_con!, firstDay: '2026-10-05', lastDay: '2026-10-05', reason: 'ลาพักร้อน' }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { reason: 'NOTHING_TO_DELEGATE' } },
    })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'delegation.revoked' } })).toBe(0)
  })
})

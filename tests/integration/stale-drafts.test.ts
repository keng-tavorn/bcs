import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { MS_PER_DAY } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { createDraft } from '@/server/services/requests'
import { runDraftExpiry } from '@/server/services/requests/stale-drafts'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-INT-006 AC3 (NEW-07): a draft nobody edits is announced to its requester after 83 days and removed (cancelled by
// the system, history kept) after 90 days and at least 7 days after the warning; a draft edited meanwhile stays. The
// business clock is moved by passing the job its date.

const START = new Date('2026-10-05T03:00:00Z')
const day = (n: number) => new Date(START.getTime() + n * MS_PER_DAY)
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
})

async function draftOn(when: Date, title: string) {
  const r = await createDraft(org.ctxOf('req_con', when), { requestTypeCode: 'BUY_GOODS', title, lines: [{ description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice: '100.00' }] }, key())
  if (!r.ok) throw new Error('draft failed')
  // The draft was last edited then
  await prisma.request.update({ where: { id: r.data.requestId }, data: { updatedAt: when } })
  return r.data.requestId
}

describe('[FR-INT-006/AC3] an idle draft is announced before it is removed', () => {
  it('warns at 83 days idle, removes at 90 once warned 7 days before, and leaves a draft edited meanwhile', async () => {
    const idle = await draftOn(START, 'ร่างที่ไม่ได้แก้')
    const edited = await draftOn(START, 'ร่างที่กลับมาแก้')

    expect(await runDraftExpiry(org.organizationId, day(82))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await runDraftExpiry(org.organizationId, day(83))).toMatchObject({ ok: true, data: { warned: 2, removed: 0 } })
    const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'request.draft_expiring', subjectId: idle } })
    expect(notice).toMatchObject({ recipientMemberId: org.member.req_con })
    expect((notice.data as { deleteOn: string }).deleteOn).toBe(day(90).toISOString())
    // A second run the same day repeats nothing
    expect(await runDraftExpiry(org.organizationId, day(83))).toMatchObject({ ok: true, data: { warned: 2, removed: 0 } })
    expect(await prisma.notification.count({ where: { templateKey: 'request.draft_expiring', subjectId: idle } })).toBe(1)

    // The requester comes back to one draft on day 85
    await prisma.request.update({ where: { id: edited }, data: { title: 'ร่างที่กลับมาแก้ (แก้แล้ว)', updatedAt: day(85) } })

    // Day 90: the warning was given 7 days before the run, so the idle draft goes; the edited one is not idle enough
    const notice83 = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'request.draft_expiring', subjectId: idle } })
    await prisma.notification.update({ where: { id: notice83.id }, data: { createdAt: day(83) } })
    expect(await runDraftExpiry(org.organizationId, day(90))).toMatchObject({ ok: true, data: { removed: 1 } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: idle } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'STALE_DRAFT' })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: edited } })).toMatchObject({ status: 'DRAFT' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: idle, type: 'request.cancelled' } })).toMatchObject({ actorType: 'SYSTEM' })
  })

  it('never removes a draft that was not warned first, even when it is older than 90 days', async () => {
    const old = await draftOn(day(-200), 'ร่างเก่ามาก')
    const r = await runDraftExpiry(org.organizationId, day(91))
    expect(r.ok).toBe(true)
    expect(await prisma.request.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ status: 'DRAFT' })
    const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'request.draft_expiring', subjectId: old } })
    // Told it goes 7 days from now at the earliest
    expect((notice.data as { deleteOn: string }).deleteOn).toBe(day(98).toISOString())
  })
})

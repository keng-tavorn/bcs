import { describe, expect, it } from 'vitest'
import { type TimelineT, type ViewT } from '@/app/(workspace)/_tracking/present'
import { docTimelineItems, waitingOf, type PoT } from '@/app/(workspace)/procurement/pos/_parts/present'
import type { DocTrackEntryDto } from '@/server/queries/purchase-orders'

// §9.9 principle 4 and FR-INT-008 AC1 on a purchase order, as the PO list, the PO page and the decision pages say it
// (src/app/(workspace)/procurement/pos/_parts/present.ts): a PO waiting on procurement (a draft, an approved PO) or on its
// supplier (a sent PO) says how long it has waited in business time under "whom it waits for", and its timeline's
// current step says it too; the delivery step names the supplier it waits for. Without a business calendar nothing is
// said about the time. The query side is tests/integration/po-team-wait.test.ts.

const fake = (key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key)
const t = fake as unknown as PoT
const tv = fake as unknown as ViewT
const tl = fake as unknown as TimelineT

const waited = (hours: string) => ({ kind: 'waiting', text: `waiting.hours${JSON.stringify({ hours })}` })

function current(over: Partial<DocTrackEntryDto>): DocTrackEntryDto {
  return {
    key: 'now',
    state: 'current',
    what: 'WAIT_SEND',
    at: new Date('2026-10-07T04:30:00Z'),
    channel: null,
    actor: null,
    onBehalfOf: null,
    role: null,
    expected: null,
    doa: null,
    note: null,
    detail: null,
    other: null,
    waitingMinutes: 90,
    dueAt: null,
    overdue: false,
    ...over,
  }
}

describe('[FR-INT-008/AC1] a PO waiting on procurement or its supplier says for how long (§9.9 principle 4)', () => {
  it('a draft, an approved PO and a sent PO say the business time they have waited under whom they wait for', () => {
    expect(waitingOf(t, tv, 'th', { kind: 'EDIT', waitingMinutes: 90 })).toEqual({ now: 'waiting.EDIT', states: [waited('1.5')] })
    expect(waitingOf(t, tv, 'th', { kind: 'SEND', bounced: false, waitingMinutes: 600 })).toEqual({ now: 'waiting.SEND', states: [waited('10')] })
    // A bounced e-mail still says how long the PO has waited to go out since its approval
    expect(waitingOf(t, tv, 'th', { kind: 'SEND', bounced: true, waitingMinutes: 45 })).toEqual({ now: 'waiting.SEND_BOUNCED', states: [{ kind: 'waiting', text: `waiting.minutes${JSON.stringify({ minutes: 45 })}` }] })
    expect(waitingOf(t, tv, 'en', { kind: 'DELIVERY', waitingMinutes: 1_620 })).toEqual({ now: 'waiting.DELIVERY', states: [waited('27')] })
    // Nothing counted yet (outside business hours): said in words, never a bare 0
    expect(waitingOf(t, tv, 'th', { kind: 'DELIVERY', waitingMinutes: 0 }).states).toEqual([{ kind: 'waiting', text: 'waiting.notStarted' }])
  })

  it('says nothing about the time without a business calendar, nor for the rest of the goods and the closing', () => {
    expect(waitingOf(t, tv, 'th', { kind: 'EDIT', waitingMinutes: null })).toEqual({ now: 'waiting.EDIT', states: [] })
    expect(waitingOf(t, tv, 'th', { kind: 'SEND', bounced: false, waitingMinutes: null }).states).toEqual([])
    expect(waitingOf(t, tv, 'th', { kind: 'REST' })).toEqual({ now: 'waiting.REST', states: [] })
    expect(waitingOf(t, tv, 'th', { kind: 'CLOSE' })).toEqual({ now: 'waiting.CLOSE', states: [] })
  })

  it('the current step says how long it has waited, and the delivery step names the supplier it waits for', () => {
    const [send, delivery, rest] = docTimelineItems(
      t,
      tv,
      tl,
      'th',
      [
        current({ key: 'send' }),
        current({ key: 'delivery', what: 'WAIT_DELIVERY', waitingMinutes: 30, supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }),
        current({ key: 'rest', what: 'WAIT_DELIVERY', waitingMinutes: null, supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }),
      ],
      { doaLinks: false },
    )
    expect(send).toMatchObject({ id: 'send', title: 'track.what.WAIT_SEND', actor: 'track.procurement', state: 'current', waiting: waited('1.5').text })
    expect(delivery).toMatchObject({ id: 'delivery', title: 'track.what.WAIT_DELIVERY', actor: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', waiting: `waiting.minutes${JSON.stringify({ minutes: 30 })}` })
    // A current step is never stamped with a time of its own: the time it began is not a decision
    expect(delivery).not.toHaveProperty('when')
    expect(rest).toMatchObject({ actor: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' })
    expect(rest).not.toHaveProperty('waiting')
  })

  it('a delivery step without its supplier reads as before: the step alone', () => {
    const [plain] = docTimelineItems(t, tv, tl, 'th', [current({ what: 'WAIT_DELIVERY', waitingMinutes: null })], { doaLinks: false })
    expect(plain).toMatchObject({ actor: '', state: 'current' })
  })
})

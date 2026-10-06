import { describe, expect, it } from 'vitest'
import { type TimelineT, type ViewT } from '@/app/(workspace)/_tracking/present'
import { docTimelineItems, waitingOf, type PoT } from '@/app/(workspace)/procurement/pos/_parts/present'
import type { DocTrackEntryDto } from '@/server/queries/purchase-orders'

// §9.9 principle 4 and FR-INT-008 AC1 on a purchase order, as the PO list, the PO page and the decision pages say it
// (src/app/(workspace)/procurement/pos/_parts/present.ts): a PO waiting on procurement (a draft, an approved PO) or on its
// supplier (a sent PO) says how long it has waited in business time under "whom it waits for", and its timeline's
// current step says it too; the delivery step names the supplier it waits for. A PO partly received ("รอของส่วนที่เหลือ")
// or received in full ("รอใบกำกับและปิด PO") says it as well, counted from its latest goods receipt. Without a business
// calendar nothing is said about the time. The query side is tests/integration/po-team-wait.test.ts.

const fake = (key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key)
const t = fake as unknown as PoT
const tv = fake as unknown as ViewT
const tl = fake as unknown as TimelineT

const waited = (hours: number) => ({ kind: 'waiting', text: `waiting.hours${JSON.stringify({ hours })}` })

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
    expect(waitingOf(t, tv, 'th', { kind: 'EDIT', waitingMinutes: 90 })).toEqual({ now: 'waiting.EDIT', states: [waited(1.5)] })
    expect(waitingOf(t, tv, 'th', { kind: 'SEND', bounced: false, waitingMinutes: 600 })).toEqual({ now: 'waiting.SEND', states: [waited(10)] })
    // A bounced e-mail still says how long the PO has waited to go out since its approval
    expect(waitingOf(t, tv, 'th', { kind: 'SEND', bounced: true, waitingMinutes: 45 })).toEqual({ now: 'waiting.SEND_BOUNCED', states: [{ kind: 'waiting', text: `waiting.minutes${JSON.stringify({ minutes: 45 })}` }] })
    expect(waitingOf(t, tv, 'en', { kind: 'DELIVERY', waitingMinutes: 1_620 })).toEqual({ now: 'waiting.DELIVERY', states: [waited(27)] })
    // Under a whole business minute (sent a moment ago, or outside business hours): said in words, never a bare 0
    expect(waitingOf(t, tv, 'th', { kind: 'DELIVERY', waitingMinutes: 0 }).states).toEqual([{ kind: 'waiting', text: 'waiting.underMinute' }])
  })

  it('a PO partly received waits for the rest of its goods, and one received in full for its invoice and closing, for as long as its latest goods receipt says', () => {
    expect(waitingOf(t, tv, 'th', { kind: 'REST', waitingMinutes: 60 })).toEqual({ now: 'waiting.REST', states: [waited(1)] })
    expect(waitingOf(t, tv, 'en', { kind: 'CLOSE', waitingMinutes: 120 })).toEqual({ now: 'waiting.CLOSE', states: [waited(2)] })
    expect(waitingOf(t, tv, 'th', { kind: 'CLOSE', waitingMinutes: 45 })).toEqual({ now: 'waiting.CLOSE', states: [{ kind: 'waiting', text: `waiting.minutes${JSON.stringify({ minutes: 45 })}` }] })
    // Received a moment ago, or outside business hours: under a whole business minute, said in words
    expect(waitingOf(t, tv, 'th', { kind: 'REST', waitingMinutes: 0 }).states).toEqual([{ kind: 'waiting', text: 'waiting.underMinute' }])
  })

  it('says nothing about the time without a business calendar', () => {
    expect(waitingOf(t, tv, 'th', { kind: 'EDIT', waitingMinutes: null })).toEqual({ now: 'waiting.EDIT', states: [] })
    expect(waitingOf(t, tv, 'th', { kind: 'SEND', bounced: false, waitingMinutes: null }).states).toEqual([])
    expect(waitingOf(t, tv, 'th', { kind: 'REST', waitingMinutes: null })).toEqual({ now: 'waiting.REST', states: [] })
    expect(waitingOf(t, tv, 'th', { kind: 'CLOSE', waitingMinutes: null })).toEqual({ now: 'waiting.CLOSE', states: [] })
    // Nothing waits on a closed, cancelled or rejected PO
    expect(waitingOf(t, tv, 'th', { kind: 'NONE' })).toEqual({ now: 'waiting.NONE', states: [] })
  })

  it('the current step says how long it has waited, and the delivery step names the supplier it waits for', () => {
    const [send, delivery, rest, close] = docTimelineItems(
      t,
      tv,
      tl,
      'th',
      [
        current({ key: 'send' }),
        current({ key: 'delivery', what: 'WAIT_DELIVERY', waitingMinutes: 30, supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }),
        current({ key: 'rest', what: 'WAIT_DELIVERY', waitingMinutes: 60, supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }),
        current({ key: 'close', what: 'WAIT_CLOSE', waitingMinutes: 120 }),
      ],
      { doaLinks: false },
    )
    expect(send).toMatchObject({ id: 'send', title: 'track.what.WAIT_SEND', actor: 'track.procurement', state: 'current', waiting: waited(1.5).text })
    expect(delivery).toMatchObject({ id: 'delivery', title: 'track.what.WAIT_DELIVERY', actor: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', waiting: `waiting.minutes${JSON.stringify({ minutes: 30 })}` })
    // A current step is never stamped with a time of its own: the time it began is not a decision
    expect(delivery).not.toHaveProperty('when')
    // The rest of the goods waits on the same supplier since the latest receipt; the closing waits on procurement
    expect(rest).toMatchObject({ id: 'rest', title: 'track.what.WAIT_DELIVERY', actor: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', waiting: waited(1).text })
    expect(close).toMatchObject({ id: 'close', title: 'track.what.WAIT_CLOSE', actor: 'track.procurement', state: 'current', waiting: waited(2).text })
    expect(close).not.toHaveProperty('when')
  })

  it('a current step without a business calendar says whom it waits for and nothing about the time', () => {
    const [rest, close] = docTimelineItems(
      t,
      tv,
      tl,
      'th',
      [current({ key: 'rest', what: 'WAIT_DELIVERY', waitingMinutes: null, supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }), current({ key: 'close', what: 'WAIT_CLOSE', waitingMinutes: null })],
      { doaLinks: false },
    )
    expect(rest).toMatchObject({ actor: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' })
    expect(rest).not.toHaveProperty('waiting')
    expect(close).toMatchObject({ actor: 'track.procurement' })
    expect(close).not.toHaveProperty('waiting')
  })

  it('a delivery step without its supplier reads as before: the step alone', () => {
    const [plain] = docTimelineItems(t, tv, tl, 'th', [current({ what: 'WAIT_DELIVERY', waitingMinutes: null })], { doaLinks: false })
    expect(plain).toMatchObject({ actor: '', state: 'current' })
  })
})

import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { commentViews, historyRows, requestHistoryKinds, stepBadge, stepCards, type DocumentT } from '@/app/(workspace)/_tracking/document-present'
import { timelineItems, type TimelineT, type ViewT } from '@/app/(workspace)/_tracking/present'
import type { StepDetailDto } from '@/server/queries/document-page'
import type { RouteDto, RouteStepDto, TrackEntryDto } from '@/server/queries/requests'
import { PO_BADGES, REQUEST_BADGES, STEP_BADGES, URGENCY_BADGES } from '@/ui/document/badges'
import th from '../../messages/th.json'

// S16-07 presentation of the tabbed document page (FR-INT-012): the badges of §9.10 (status as a light background with an
// icon and a word), a step card's state — neutral while waiting, warn from half of its time, danger past it — and its
// stamp once decided (AC3), the history table from the timeline's done entries only (AC5), and the comments of the right
// column (AC2). Real Thai messages, so the words are the ones on the screen.

const td = createTranslator({ locale: 'th', messages: th, namespace: 'document' }) as unknown as DocumentT
const tv = createTranslator({ locale: 'th', messages: th, namespace: 'requestView' }) as unknown as ViewT
const tl = createTranslator({ locale: 'th', messages: th, namespace: 'timeline' }) as unknown as TimelineT

const vp = { id: 'm-vp', name: { th: 'วีระ ปฏิบัติการ', en: null } }
const requester = { id: 'm-req', name: { th: 'สมชาย ใจดี', en: null } }
const role = { kind: 'POSITION' as const, positionCode: 'VP', position: { th: 'รองประธานสายงาน', en: null }, department: { th: 'สายปฏิบัติการ', en: null }, orgWide: false }
const doa = { versionId: 'v1', code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' }
const AT = new Date('2026-10-05T03:00:00Z')

function step(over: Partial<RouteStepDto>): RouteStepDto {
  return { stepNo: 1, status: 'ACTIVE', approver: vp, onBehalfOf: null, role, expected: null, taskStatus: 'OPEN', decision: null, decidedAt: null, open: [{ taskId: 't1', approver: vp, onBehalfOf: null, role, status: 'OPEN' }], escalation: null, ...over }
}
const detail = (sla: StepDetailDto['sla'], over: Partial<StepDetailDto> = {}): StepDetailDto => ({ stepNo: 1, channel: null, sla, history: [], ...over })
const route = (steps: RouteStepDto[]): RouteDto => ({ id: 'r1', routeNo: 1, status: 'ACTIVE', doa, escalatedFromRuleCode: null, amountBasis: 'GROSS', basisSatang: 2_150_000n, explanationTh: 'เหตุผล', band: null, steps, createdAt: AT })

describe('[FR-INT-012/AC3] a step card says its state with the badge of §9.10', () => {
  it('is neutral while under half of its time, warn from half of it, and danger past it', () => {
    expect(stepBadge(td, 'th', step({}), detail({ dueAt: AT, usedMinutes: 120, targetMinutes: 480, overdue: false }))).toEqual({ key: 'OPEN', label: 'รอตัดสิน · เหลือ 6 ชม.ทำการ' })
    expect(stepBadge(td, 'th', step({}), detail({ dueAt: AT, usedMinutes: 240, targetMinutes: 480, overdue: false }))).toEqual({ key: 'OPEN_HALF', label: 'รอตัดสิน · เหลือ 4 ชม.ทำการ' })
    expect(stepBadge(td, 'th', step({}), detail({ dueAt: AT, usedMinutes: 570, targetMinutes: 480, overdue: true }))).toEqual({ key: 'OVERDUE', label: 'เกินกำหนด 1.5 ชม.ทำการ' })
    expect(STEP_BADGES.OPEN).toEqual({ tone: 'neutral', icon: 'Hourglass' })
    expect(STEP_BADGES.OPEN_HALF).toEqual({ tone: 'warn', icon: 'Hourglass' })
    expect(STEP_BADGES.OVERDUE).toEqual({ tone: 'danger', icon: 'AlarmClock' })
  })

  it('waits for the requester’s answer, waits for its turn, or shows its decision', () => {
    expect(stepBadge(td, 'th', step({ taskStatus: 'INFO_REQUESTED' }), undefined)).toEqual({ key: 'INFO_REQUESTED', label: 'รอผู้ขอตอบ' })
    expect(stepBadge(td, 'th', step({ status: 'WAITING', approver: null, taskStatus: null }), undefined)).toEqual({ key: 'WAITING', label: 'รอถึงขั้นนี้' })
    expect(stepBadge(td, 'th', step({ status: 'DONE', decision: 'APPROVE', decidedAt: AT }), undefined)).toEqual({ key: 'APPROVE', label: 'อนุมัติแล้ว' })
    expect(stepBadge(td, 'th', step({ status: 'DONE', decision: 'RETURN', decidedAt: AT }), undefined)).toEqual({ key: 'RETURN', label: 'ตีกลับให้แก้' })
    expect(stepBadge(td, 'th', step({ status: 'DONE', decision: 'REJECT', decidedAt: AT }), undefined)).toEqual({ key: 'REJECT', label: 'ไม่อนุมัติ' })
  })

  it('turns a decided step into a stamp: name, position, time, channel and the route’s DOA rule', () => {
    const [card] = stepCards(td, tv, tl, 'th', route([step({ status: 'DONE', decision: 'APPROVE', decidedAt: AT, open: [] })]), [detail(null, { channel: 'LIFF' })], { doaLinks: false })
    expect(card).toMatchObject({ title: 'ขั้นที่ 1 · รองประธานสายงาน สายปฏิบัติการ', current: false, stampTone: 'ok', stamp: { name: 'วีระ ปฏิบัติการ', role: 'รองประธานสายงาน สายปฏิบัติการ', channel: 'หน้าจอใน LINE', doaRef: 'DOA-DEMO ฉบับ 1 ข้อ PR-02' } })
    expect(card!.stamp!.doaHref).toBeUndefined()
    // Only a reader who may open the version gets the link (canOpenDoaVersion)
    const [linked] = stepCards(td, tv, tl, 'th', route([step({ status: 'DONE', decision: 'APPROVE', decidedAt: AT, open: [] })]), [detail(null)], { doaLinks: true })
    expect(linked!.stamp!.doaHref).toBe('/admin/doa/v1')
  })

  it('names everyone who may decide an escalated step, why, and its SLA used of its time', () => {
    const escalated = step({ escalation: 'CO_ASSIGNED', open: [{ taskId: 't1', approver: requester, onBehalfOf: null, role, status: 'OPEN' }, { taskId: 't2', approver: vp, onBehalfOf: null, role, status: 'OPEN' }] })
    const [card] = stepCards(td, tv, tl, 'th', route([escalated]), [detail({ dueAt: AT, usedMinutes: 540, targetMinutes: 480, overdue: true })], { doaLinks: false })
    expect(card).toMatchObject({ current: true, overdue: true, people: ['สมชาย ใจดี', 'หรือ วีระ ปฏิบัติการ'], sla: 'ใช้ไป 9 จาก 8 ชม.ทำการ' })
    expect(card!.notes).toEqual(['ส่งต่อเมื่อเลยกำหนด ผู้อนุมัติระดับถัดไปร่วมพิจารณา', 'ผู้ที่ตัดสินก่อนเป็นผู้ตัดสินขั้นนี้'])
  })
})

describe('[FR-INT-012/AC1] [FR-INT-012/AC6] the status badges follow the table of §9.10', () => {
  it('pairs every request and PO status with its colour and icon', () => {
    expect(REQUEST_BADGES.PENDING_APPROVAL).toEqual({ tone: 'warn', icon: 'Clock' })
    expect(REQUEST_BADGES.RETURNED).toEqual({ tone: 'warn', icon: 'Undo2' })
    expect(REQUEST_BADGES.ORDERED).toEqual({ tone: 'info', icon: 'ShoppingCart' })
    expect(REQUEST_BADGES.COMPLETED).toEqual({ tone: 'ok', icon: 'CircleCheckBig' })
    expect(REQUEST_BADGES.REJECTED).toEqual({ tone: 'danger', icon: 'CircleX' })
    expect(PO_BADGES.SENT).toEqual({ tone: 'info', icon: 'Send' })
    expect(PO_BADGES.RECEIVED).toEqual({ tone: 'ok', icon: 'PackageCheck' })
    expect(PO_BADGES.CLOSED).toEqual({ tone: 'neutral', icon: 'Lock' })
    expect(URGENCY_BADGES.URGENT).toEqual({ tone: 'warn', icon: 'Zap' })
    // Every status of the table has a word on its badge, in both languages
    for (const s of Object.keys(REQUEST_BADGES)) expect(td(`badge.request.${s}` as 'badge.request.DRAFT')).not.toContain('badge.')
    for (const s of Object.keys(PO_BADGES)) expect(td(`badge.po.${s}` as 'badge.po.DRAFT')).not.toContain('badge.')
  })
})

function entry(over: Partial<TrackEntryDto>): TrackEntryDto {
  return { key: 'k', state: 'done', what: 'SUBMITTED', at: AT, channel: 'WEB', actor: requester, onBehalfOf: null, role: null, expected: null, doa: null, note: null, other: null, number: null, stepNo: null, waitingMinutes: null, dueAt: null, overdue: false, ...over }
}

describe('[FR-INT-012/AC5] [FR-PLT-003/AC3] the history tab lists what happened, from the Events only', () => {
  const track = [
    entry({ key: 'e1', what: 'SUBMITTED', number: 'PR-2569-00012' }),
    entry({ key: 'e2', what: 'INFO_REQUESTED', actor: vp, note: 'ขอใบเสนอราคา' }),
    entry({ key: 'e3', what: 'APPROVED', actor: vp, role, doa, channel: 'LINE_CHAT', onBehalfOf: requester }),
    entry({ key: 'live', state: 'current', what: 'WAIT_PROCUREMENT', actor: null, channel: null, at: null }),
  ]
  it('has the date, who (and for whom), the event with its DOA reference and the channel, by kind', () => {
    const rows = historyRows(td, timelineItems(tv, tl, 'th', track), requestHistoryKinds(track))
    expect(rows.map((r) => [r.key, r.kind, r.event, r.channel])).toEqual([
      ['e1', 'DOCUMENT', 'ส่งขออนุมัติ ได้เลขที่ PR-2569-00012', 'เว็บ'],
      ['e2', 'QUESTION', 'ขอข้อมูลเพิ่ม', 'เว็บ'],
      ['e3', 'DECISION', 'อนุมัติ · DOA-DEMO ฉบับ 1 ข้อ PR-02', 'แชท LINE'],
    ])
    expect(rows[2]).toMatchObject({ actor: 'วีระ ปฏิบัติการ · รองประธานสายงาน สายปฏิบัติการ', onBehalfOf: 'รักษาการแทน สมชาย ใจดี' })
    expect(rows[1]!.note).toBe('ขอใบเสนอราคา')
    // Dates are Buddhist era
    expect(rows[0]!.when).toMatch(/2569/)
  })

  it('makes the comments of the right column from the reasons, questions and answers written on the document', () => {
    const comments = commentViews(td, 'th', [...track, entry({ key: 'e4', what: 'RETURNED', actor: vp, note: 'แยกรายการ' })], 'ระบบ')
    expect(comments.map((c) => [c.key, c.kind, c.text])).toEqual([
      ['e2', 'คำถาม', 'ขอใบเสนอราคา'],
      ['e4', 'เหตุผล', 'แยกรายการ'],
    ])
    expect(comments[0]!.by).toMatch(/^วีระ ปฏิบัติการ · /)
  })
})

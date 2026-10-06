import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { routeSentence, stageText, stageWaitingMinutes, timelineItems, waitingText, type TimelineT, type ViewT } from '@/app/(workspace)/_tracking/present'
import { requestRows } from '@/app/(workspace)/_tracking/rows'
import type { MyRequestRowDto, RouteDto, StageDto, TrackEntryDto } from '@/server/queries/requests'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S2-12 presentation: business time waited in hours with one decimal (integers only), the tracking timeline as stamps,
// "where it is now" in one line, and the English route sentence built from the stored route (the Thai one is the record).

const t = ((key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key)) as unknown as ViewT
const tl = ((key: string, values?: Record<string, unknown>) => (key === 'doaRef' && values ? `${String(values.code)} v${String(values.version)} ${String(values.rule)}` : values ? `${key}${JSON.stringify(values)}` : key)) as unknown as TimelineT

const vp = { id: 'm-vp', name: { th: 'วีระ ปฏิบัติการ', en: 'Weera Operations' } }
const requester = { id: 'm-req', name: { th: 'สมชาย ใจดี', en: null } }
const role = { kind: 'POSITION' as const, positionCode: 'VP', position: { th: 'รองประธานสายงาน', en: 'Vice president' }, department: { th: 'สายปฏิบัติการ', en: 'Operations' }, orgWide: false }

function entry(over: Partial<TrackEntryDto>): TrackEntryDto {
  return {
    key: 'k',
    state: 'done',
    what: 'SUBMITTED',
    at: new Date('2026-10-05T03:00:00Z'),
    channel: 'WEB',
    actor: requester,
    onBehalfOf: null,
    role: null,
    expected: null,
    doa: null,
    note: null,
    other: null,
    number: null,
    stepNo: null,
    waitingMinutes: null,
    dueAt: null,
    overdue: false,
    ...over,
  }
}

describe('[FR-INT-008/AC1] how long a step has waited, in business hours', () => {
  it.each([
    [null, null],
    // under one whole business minute, true inside business hours (the clock runs) and outside them alike (D-05 round 4)
    [0, 'waiting.underMinute'],
    [45, 'waiting.minutes{"minutes":45}'],
    [60, 'waiting.hours{"hours":1}'],
    [90, 'waiting.hours{"hours":1.5}'],
    [125, 'waiting.hours{"hours":2.1}'],
    [540, 'waiting.hours{"hours":9}'],
  ])('%s minutes → %s', (minutes, text) => {
    expect(waitingText(t, minutes)).toBe(text)
  })

  it('[FR-PLT-002/AC2] says the wait in the words of each language: one decimal at most, and "hour" for one hour in English', () => {
    const words = (locale: 'th' | 'en') => createTranslator({ locale, messages: locale === 'th' ? th : en, namespace: 'requestView' }) as unknown as ViewT
    for (const [minutes, thai, english] of [
      [1, 'ค้างมา 1 นาทีในเวลาทำการ', 'Waiting 1 business minute'],
      [45, 'ค้างมา 45 นาทีในเวลาทำการ', 'Waiting 45 business minutes'],
      [60, 'ค้างมา 1 ชั่วโมงทำการ', 'Waiting 1 business hour'],
      [90, 'ค้างมา 1.5 ชั่วโมงทำการ', 'Waiting 1.5 business hours'],
      [125, 'ค้างมา 2.1 ชั่วโมงทำการ', 'Waiting 2.1 business hours'],
      [540, 'ค้างมา 9 ชั่วโมงทำการ', 'Waiting 9 business hours'],
      [1086, 'ค้างมา 18.1 ชั่วโมงทำการ', 'Waiting 18.1 business hours'],
    ] as const) {
      expect(waitingText(words('th'), minutes), `${minutes} th`).toBe(thai)
      expect(waitingText(words('en'), minutes), `${minutes} en`).toBe(english)
    }
  })

  it('[§9.9] words every wait as how long it has waited, under a minute too, in Thai and in English', () => {
    expect(th.requestView.waiting.underMinute).toBe('ค้างมาไม่ถึง 1 นาทีในเวลาทำการ')
    expect(en.requestView.waiting.underMinute).toBe('Waiting under 1 business minute')
    // the screens and their tests read every wait by its first word (ค้างมา / Waiting)
    for (const key of ['underMinute', 'minutes', 'hours'] as const) {
      expect(th.requestView.waiting[key].startsWith('ค้างมา'), key).toBe(true)
      expect(en.requestView.waiting[key].startsWith('Waiting'), key).toBe(true)
    }
    expect(JSON.stringify(th.requestView)).not.toContain('ยังไม่เริ่มนับเวลาทำการ')
  })

  it('says who the request waits for, with their position, and what the requester has to do', () => {
    const stage: StageDto = { kind: 'APPROVER', taskId: 't', assignee: vp, onBehalfOf: null, role, since: new Date(), waitingMinutes: 30, dueAt: null, overdue: false, stepNo: 1, stepCount: 1 }
    expect(stageText(t, 'th', stage, true)).toBe('stage.APPROVER{"name":"วีระ ปฏิบัติการ (role.positionIn{\\"position\\":\\"รองประธานสายงาน\\",\\"department\\":\\"สายปฏิบัติการ\\"})"}')
    expect(stageText(t, 'en', stage, true)).toContain('Weera Operations (role.positionIn')
    expect(stageText(t, 'th', { kind: 'REQUESTER_EDIT', since: null }, true)).toBe('stage.REQUESTER_EDIT_MINE')
    expect(stageText(t, 'th', { kind: 'REQUESTER_EDIT', since: null }, false)).toBe('stage.REQUESTER_EDIT')
  })

  it('names whom a delegate acts for, so the delegate is never shown as the holder of the position (BR-DLG-04)', () => {
    const delegate = { id: 'm-asst', name: { th: 'สมหญิง รักงาน', en: 'Somying Rakngan' } }
    const stage: StageDto = { kind: 'APPROVER', taskId: 't', assignee: delegate, onBehalfOf: vp, role, since: new Date(), waitingMinutes: 30, dueAt: null, overdue: false, stepNo: 1, stepCount: 1 }
    const position = `role.positionIn${JSON.stringify({ position: 'รองประธานสายงาน', department: 'สายปฏิบัติการ' })}`
    const acting = `stage.actingForRole${JSON.stringify({ name: 'วีระ ปฏิบัติการ', role: position })}`
    expect(stageText(t, 'th', stage, true)).toBe(`stage.APPROVER${JSON.stringify({ name: `สมหญิง รักงาน (${acting})` })}`)
    const actingEn = `stage.actingFor${JSON.stringify({ name: 'Weera Operations' })}`
    expect(stageText(t, 'en', { ...stage, role: { kind: 'UNKNOWN' } }, true)).toBe(`stage.APPROVER${JSON.stringify({ name: `Somying Rakngan (${actingEn})` })}`)
  })
})

describe('[FR-INT-008/AC1] whoever a request waits for, the screens say for how long; an ordered one names the suppliers (§9.9 principle 4)', () => {
  const since = new Date('2026-10-08T01:00:00Z')
  const suppliers = [
    { th: 'บริษัท ผู้ขายหนึ่ง จำกัด', en: 'Supplier One Co., Ltd.' },
    { th: 'บริษัท ผู้ขายสอง จำกัด', en: null },
  ]
  const delivery: StageDto = { kind: 'DELIVERY', since, waitingMinutes: 90, suppliers }
  const row = (stage: StageDto): MyRequestRowDto => ({
    id: 'r-1',
    number: 'PR-2569-00012',
    title: 'ไม้อัดและตะปู',
    status: 'ORDERED',
    documentType: 'PURCHASE_REQUEST',
    relation: 'REQUESTER',
    grossSatang: 4_494_000n,
    createdAt: since,
    submittedAt: since,
    stage,
  })

  it('an ordered request names the suppliers of its POs that went out, in the reader’s language; none yet, the general words', () => {
    expect(stageText(t, 'th', delivery, true)).toBe(`stage.DELIVERY_SUPPLIERS${JSON.stringify({ suppliers: new Intl.ListFormat('th', { type: 'conjunction' }).format(suppliers.map((s) => s.th)) })}`)
    expect(stageText(t, 'en', delivery, true)).toBe(`stage.DELIVERY_SUPPLIERS${JSON.stringify({ suppliers: 'Supplier One Co., Ltd. and บริษัท ผู้ขายสอง จำกัด' })}`)
    expect(stageText(t, 'th', { kind: 'DELIVERY', since: null, waitingMinutes: null, suppliers: [] }, true)).toBe('stage.DELIVERY')
  })

  it('every stage that waits on someone gives its business minutes: an approver, the requester, procurement, a supplier', () => {
    expect(stageWaitingMinutes(delivery)).toBe(90)
    expect(stageWaitingMinutes({ kind: 'ANSWER', taskId: 't', infoRequestId: 'q', question: 'ขอใบเสนอราคา', askedBy: vp, since, waitingMinutes: 45 })).toBe(45)
    expect(stageWaitingMinutes({ kind: 'REQUESTER_EDIT', since, waitingMinutes: 600 })).toBe(600)
    expect(stageWaitingMinutes({ kind: 'PROCUREMENT', since, waitingMinutes: 30 })).toBe(30)
    expect(stageWaitingMinutes({ kind: 'CLOSED' })).toBeNull()
    expect(stageWaitingMinutes({ kind: 'DELIVERY', since: null, waitingMinutes: null, suppliers: [] })).toBeNull()
  })

  it('"my requests" and home say how long an ordered request has waited for its suppliers, as for the requester and procurement', () => {
    const [ordered] = requestRows(t, 'th', [row(delivery)])
    expect(ordered!.now).toContain('stage.DELIVERY_SUPPLIERS')
    expect(ordered!.nowStates).toEqual([{ kind: 'waiting', text: 'waiting.hours{"hours":1.5}' }])
    const [returned] = requestRows(t, 'th', [row({ kind: 'REQUESTER_EDIT', since, waitingMinutes: 45 })])
    expect(returned!.nowStates).toEqual([{ kind: 'waiting', text: 'waiting.minutes{"minutes":45}' }])
    // Not sent to a supplier yet: no time to count
    const [notSent] = requestRows(t, 'th', [row({ kind: 'DELIVERY', since: null, waitingMinutes: null, suppliers: [] })])
    expect(notSent!.nowStates).toEqual([])
  })

  it('the timeline’s delivery step names the suppliers and how long; without one it stays procurement’s', () => {
    const [waiting] = timelineItems(t, tl, 'th', [entry({ what: 'WAIT_DELIVERY', state: 'current', actor: null, at: since, channel: null, waitingMinutes: 90, suppliers })])
    expect(waiting).toMatchObject({ actor: new Intl.ListFormat('th', { type: 'conjunction' }).format(suppliers.map((s) => s.th)), waiting: 'waiting.hours{"hours":1.5}', state: 'current' })
    const [none] = timelineItems(t, tl, 'th', [entry({ what: 'WAIT_DELIVERY', state: 'current', actor: null, at: null, channel: null, waitingMinutes: null })])
    expect(none).toMatchObject({ actor: 'procurement' })
    expect(none).not.toHaveProperty('waiting')
    const [answer] = timelineItems(t, tl, 'th', [entry({ what: 'WAIT_ANSWER', state: 'current', actor: requester, at: since, channel: null, waitingMinutes: 45 })])
    expect(answer).toMatchObject({ actor: 'สมชาย ใจดี', waiting: 'waiting.minutes{"minutes":45}' })
  })
})

describe('[FR-PLT-003/AC3] [FR-DOA-005/AC2] the timeline as stamps', () => {
  it('stamps decisions with who, position, when, channel and a link to the DOA version for those who may open it', () => {
    const decided = [entry({ what: 'APPROVED', actor: vp, role, channel: 'LIFF', doa: { versionId: 'v-1', code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' } })]
    const [item] = timelineItems(t, tl, 'th', decided, { doaLinks: true })
    expect(item).toMatchObject({
      title: 'timeline.what.APPROVED',
      actor: 'วีระ ปฏิบัติการ',
      role: 'role.positionIn{"position":"รองประธานสายงาน","department":"สายปฏิบัติการ"}',
      when: '5 ต.ค. 2569 10:00 น.',
      channel: 'channel.LIFF',
      doaRef: 'DOA-DEMO v1 PR-02',
      doaHref: '/admin/doa/v-1',
      outcome: 'approved',
      statusLabel: 'timeline.statusLabel.approved',
      stamp: true,
      state: 'done',
    })
    // Without the right to open DOA versions the reference stays on the stamp, as text (no link that ends in a refusal)
    const [plain] = timelineItems(t, tl, 'th', decided)
    expect(plain).toMatchObject({ doaRef: 'DOA-DEMO v1 PR-02' })
    expect(plain).not.toHaveProperty('doaHref')
  })

  it('shows the requester’s edit after a return as one step', () => {
    const [item] = timelineItems(t, tl, 'th', [entry({ what: 'EDITED' })])
    expect(item).toMatchObject({ title: 'timeline.what.EDITED', actor: 'สมชาย ใจดี', when: '5 ต.ค. 2569 10:00 น.', channel: 'channel.WEB', state: 'done' })
  })

  it('names the number on submit, the reason of a return, the delegate’s principal and the current step’s wait', () => {
    const items = timelineItems(t, tl, 'th', [
      entry({ what: 'SUBMITTED', number: 'PR-2569-00012' }),
      entry({ what: 'RETURNED', actor: vp, note: 'แยกรายการ', onBehalfOf: requester }),
      entry({ what: 'WAIT_APPROVAL', state: 'current', actor: vp, role, at: null, channel: null, waitingMinutes: 90, dueAt: new Date('2026-10-06T02:00:00Z'), overdue: true, stepNo: 2 }),
      entry({ what: 'NEXT_PROCUREMENT', state: 'upcoming', actor: null, at: null, channel: null }),
    ], { stepCount: 2 })
    expect(items[0]!.title).toBe('timeline.submittedNumber{"number":"PR-2569-00012"}')
    expect(items[1]).toMatchObject({ outcome: 'returned', note: 'แยกรายการ', noteLabel: 'timeline.noteReason', onBehalfOf: 'actingFor{"name":"สมชาย ใจดี"}', stamp: true })
    expect(items[2]).toMatchObject({ title: 'timeline.waitStep{"no":2}', state: 'current', waiting: 'waiting.hours{"hours":1.5}', overdue: true, statusLabel: 'timeline.statusLabel.current' })
    expect(items[2]!.due).toBe('waiting.overdue{"time":"6 ต.ค. 2569 09:00 น."}')
    expect(items[2]).not.toHaveProperty('when')
    expect(items[3]).toMatchObject({ title: 'timeline.what.NEXT_PROCUREMENT', actor: 'procurement', state: 'upcoming' })
  })
})

describe('[FR-DOA-003/AC2] the route and why, in the reader’s language', () => {
  const route: RouteDto = {
    id: 'r',
    routeNo: 1,
    status: 'ACTIVE',
    doa: { versionId: 'v-1', code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02' },
    escalatedFromRuleCode: 'PR-01',
    amountBasis: 'GROSS',
    basisSatang: 1_500_000n,
    explanationTh: 'DOA-DEMO ฉบับ 1 ข้อ PR-02: คำขอซื้อยอด 15,000.00 บาท (รวม VAT) …',
    band: { lowerSatang: 0n, upperSatang: 2_000_000n },
    steps: [{ stepNo: 1, status: 'ACTIVE', approver: vp, onBehalfOf: null, role, expected: null, taskStatus: 'OPEN', decision: null, decidedAt: null }],
    createdAt: new Date(),
  }

  it('shows the Thai record as stored, and builds the English sentence from the route', () => {
    expect(routeSentence(t, tl, 'th', route, 'REQUEST')).toBe(route.explanationTh)
    const en = routeSentence(t, tl, 'en', route, 'REQUEST')
    expect(en.startsWith('DOA-DEMO v1 PR-02:')).toBe(true)
    expect(en).toContain('route.explain.subject{"document":"route.explain.document.REQUEST","amount":"15,000.00","basis":"route.explain.basis.GROSS"}')
    expect(en).toContain('route.explain.bandUpTo{"upper":"20,000.00"}')
    expect(en).toContain('route.explain.escalated{"from":"PR-01","rule":"PR-02"}')
    expect(en).toContain('Weera Operations (role.positionIn')
  })
})

import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { taskTitle, type TasksT } from '@/app/(workspace)/_tracking/rows'
import { changesView, type BudgetsT } from '@/app/(workspace)/budgets/_present'
import { overrunFacts, overrunPanelView, overrunRequestLabel, type OverrunT } from '@/app/(workspace)/budgets/overruns/_present'
import type { InboxTaskDto } from '@/server/queries/tasks'
import type { OverrunDto, OverrunOfferDto } from '@/server/services/budget/overrun-view'
import { OVERRUN_BADGES, overrunCancellable, overrunErrorKey, overrunReasonError, toOverrunFailure, type OverrunStatus } from '@/ui/budgets/overrun-model'
import { failureKey, failureStep, toFormFailure } from '@/ui/request-form/outcome'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The screens of over-budget approval (S6-16 · FR-BUD-101 · BR-BUD-12 to BR-BUD-15): the request page's panel — what is
// short and the button for its requester only while they may ask, nothing at all for the demo organization that has no
// OVER_BUDGET rule — each overrun's state in words and a badge, what its requester may still cancel, how a refusal
// reads (DOA_NOT_CONFIGURED, NOT_OVER_BUDGET, LINE_NOT_OPEN, OVERRUN_EXISTS), the request form's words for a request
// locked while its overrun waits (OVERRUN_PENDING), the inbox row of the approver and the dashboard's "เติมจากเกินงบ".
// Expected values are written out by hand. The pages run in tests/e2e/budget-overrun.spec.ts at 375 and 1440 px.

const t = createTranslator({ locale: 'th', messages: th, namespace: 'budgetOverrun' }) as unknown as OverrunT
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'budgetOverrun' }) as unknown as OverrunT
const money = (amount: string) => ({ amount, currency: 'THB' as const })
const day = (iso: string) => iso.slice(0, 10)

function overrun(o: Partial<OverrunDto> = {}): OverrunDto {
  return {
    id: 'o1',
    number: 'OB-CON-2569-0001',
    status: 'PENDING_APPROVAL',
    request: { id: 'r1', number: null, title: 'งานเปิดตัวโครงการ' },
    budgetLine: { id: 'l1', code: 'CON-OPEX', nameTh: 'งบดำเนินงาน' },
    requestNet: money('70000.00'),
    shortfall: money('60000.00'),
    used: money('0.00'),
    returned: money('0.00'),
    returnedAfterUse: money('0.00'),
    reason: 'งานต้องจัดก่อนสิ้นเดือน',
    submittedBy: { id: 'm1', nameTh: 'สมชาย ขอซื้อ' },
    submittedAt: '2026-10-06T03:00:00.000Z',
    approvedAt: null,
    lapsesAt: null,
    consumedAt: null,
    openTaskId: 't1',
    mine: true,
    ...o,
  }
}

const offer = (o: Partial<OverrunOfferDto> = {}): OverrunOfferDto => ({ canAsk: false, line: null, need: null, available: null, shortfall: null, ruleInEffect: false, overruns: [], ...o })

describe('[FR-BUD-101/AC1] the request page shows the shortfall and the button only to the requester who may ask', () => {
  it('nothing at all when nothing was asked and the reader may not ask — the demo organization has no OVER_BUDGET rule', () => {
    expect(overrunPanelView(t, offer(), day)).toBeNull()
    // The requester of a short line without the rule: the service says canAsk false, so the page shows nothing
    expect(overrunPanelView(t, offer({ line: { code: 'CON-OPEX', nameTh: 'งบดำเนินงาน' }, need: money('70000.00'), available: money('10000.00'), shortfall: money('60000.00') }), day)).toBeNull()
  })

  it('the requester who may ask sees the line, what the request needs, what is left and what is short', () => {
    const view = overrunPanelView(t, offer({ canAsk: true, ruleInEffect: true, line: { code: 'CON-OPEX', nameTh: 'งบดำเนินงาน' }, need: money('70000'), available: money('10000.00'), shortfall: money('60000.00') }), day)!
    expect(view.title).toBe('ขออนุมัติเกินงบ')
    expect(view.canAsk).toBe(true)
    expect(view.shortfall).toBe('60,000.00')
    expect(view.short).toEqual({
      headline: 'งบของบรรทัด CON-OPEX · งบดำเนินงาน ไม่พอสำหรับคำขอนี้',
      amounts: [
        { label: 'ยอดที่คำขอนี้ต้องใช้', value: '70,000.00' },
        { label: 'คงเหลือที่ใช้ได้', value: '10,000.00' },
        { label: 'ขาดอีก', value: '60,000.00', total: true },
      ],
      unit: 'บาท',
      hint: 'ขออนุมัติเฉพาะส่วนที่ขาด เมื่ออนุมัติแล้ว งบส่วนนี้ถูกกันไว้ให้คำขอนี้ แล้วส่งคำขอได้ตามปกติ',
    })
    expect(view.rows).toEqual([])
  })
})

describe('[FR-BUD-101/AC2] each overrun asked for the request, with where it stands and what its requester may cancel', () => {
  it('a waiting one locks the request and may be cancelled by who asked; an approved one is set aside until a day', () => {
    const view = overrunPanelView(
      t,
      offer({
        overruns: [
          overrun({ id: 'o2', number: 'OB-CON-2569-0002', status: 'APPROVED', approvedAt: '2026-10-07T03:00:00.000Z', lapsesAt: '2026-11-06T03:00:00.000Z' }),
          overrun({ status: 'REJECTED', mine: false }),
          overrun({ id: 'o3', number: 'OB-CON-2569-0003' }),
        ],
      }),
      day,
    )!
    expect(view.short).toBeNull()
    expect(view.canAsk).toBe(false)
    expect(view.rows.map((r) => [r.number, r.href, r.statusLabel, r.shortfall, r.hint, r.cancel])).toEqual([
      ['OB-CON-2569-0002', '/budgets/overruns/o2', 'อนุมัติแล้ว รอใช้', 'ยอดที่ขอเกินงบ 60,000.00 บาท', 'งบส่วนนี้กันไว้ให้คำขอนี้ถึง 2026-11-06 ส่งคำขอก่อนวันนั้น', true],
      ['OB-CON-2569-0001', '/budgets/overruns/o1', 'ไม่อนุมัติ', 'ยอดที่ขอเกินงบ 60,000.00 บาท', null, false],
      ['OB-CON-2569-0003', '/budgets/overruns/o3', 'รออนุมัติ', 'ยอดที่ขอเกินงบ 60,000.00 บาท', 'รอผู้อนุมัติตัดสิน ระหว่างนี้แก้ยอดเงินหรือบรรทัดงบของคำขอไม่ได้ และยังส่งคำขอไม่ได้', true],
    ])
  })

  it('only who asked cancels, and only while it waits or before the submit uses it (§6.4)', () => {
    const can = (status: OverrunStatus, mine = true) => overrunCancellable(status, mine)
    expect((['PENDING_APPROVAL', 'APPROVED', 'CONSUMED', 'RETURNED', 'REJECTED', 'CANCELLED', 'LAPSED'] as const).filter((s) => can(s))).toEqual(['PENDING_APPROVAL', 'APPROVED'])
    expect(can('PENDING_APPROVAL', false)).toBe(false)
  })

  it('every state is a badge with an icon and words in Thai and English (NFR-A11Y-03)', () => {
    for (const status of Object.keys(OVERRUN_BADGES) as OverrunStatus[]) {
      expect(OVERRUN_BADGES[status].icon).not.toBeNull()
      expect(t(`status.${status}`)).not.toContain('status.')
      expect(tEn(`status.${status}`)).not.toContain('status.')
      expect(t(`detail.hint.${status}`)).not.toContain('detail.')
    }
    expect([OVERRUN_BADGES.PENDING_APPROVAL.tone, OVERRUN_BADGES.APPROVED.tone, OVERRUN_BADGES.REJECTED.tone, OVERRUN_BADGES.LAPSED.tone]).toEqual(['warn', 'ok', 'danger', 'neutral'])
  })

  it('its page tells where what it funded went: used, back at use, back after use', () => {
    const consumed = overrun({
      status: 'CONSUMED',
      request: { id: 'r1', number: 'PR-CON-2569-0007', title: 'งานเปิดตัวโครงการ' },
      used: money('55000.00'),
      returned: money('5000.00'),
      approvedAt: '2026-10-07T03:00:00.000Z',
      lapsesAt: '2026-11-06T03:00:00.000Z',
      consumedAt: '2026-10-08T03:00:00.000Z',
      mine: false,
    })
    expect(overrunRequestLabel(consumed.request)).toBe('PR-CON-2569-0007')
    expect(overrunFacts(t, consumed, day).map((f) => [f.label, f.value])).toEqual([
      ['คำขอต้นทาง', 'PR-CON-2569-0007 · งานเปิดตัวโครงการ'],
      ['บรรทัดงบ', 'CON-OPEX · งบดำเนินงาน'],
      ['ยอดที่คำขอต้องใช้ตอนขอ (ก่อน VAT)', '70,000.00 บาท'],
      ['ยอดที่ขอเกินงบ', '60,000.00 บาท'],
      ['ใช้กับคำขอแล้ว', '55,000.00 บาท'],
      ['คืนบรรทัดงบตอนใช้หรือหมดอายุ', '5,000.00 บาท'],
      ['เหตุผล', 'งานต้องจัดก่อนสิ้นเดือน'],
      ['ผู้ขอ', 'สมชาย ขอซื้อ'],
      ['ขอเมื่อ', '2026-10-06'],
      ['อนุมัติเมื่อ', '2026-10-07'],
      ['ใช้เมื่อ', '2026-10-08'],
    ])
    // Waiting: nothing used or returned yet, so the page does not list zeros
    expect(overrunFacts(t, overrun(), day).map((f) => f.key)).toEqual(['request', 'line', 'requestNet', 'shortfall', 'reason', 'submittedBy', 'submittedAt'])
  })
})

describe('[FR-BUD-101/AC1] a refusal says what happened and how to fix it', () => {
  const key = (code: string, details: Record<string, unknown> = {}) => overrunErrorKey(toOverrunFailure({ code, details }))

  it('maps the service codes to their words', () => {
    expect(key('DOA_NOT_CONFIGURED')).toBe('DOA_NOT_CONFIGURED')
    expect(key('VALIDATION_FAILED', { reason: 'NOT_OVER_BUDGET' })).toBe('NOT_OVER_BUDGET')
    expect(key('VALIDATION_FAILED', { field: 'budgetLineId', reason: 'LINE_NOT_OPEN' })).toBe('LINE_NOT_OPEN')
    expect(key('VALIDATION_FAILED', { field: 'reason' })).toBe('REASON')
    expect(key('VALIDATION_FAILED', { field: 'requestId' })).toBe('INPUT')
    expect(key('INVALID_STATE_TRANSITION', { reason: 'OVERRUN_EXISTS' })).toBe('OVERRUN_EXISTS')
    expect(key('INVALID_STATE_TRANSITION', { from: 'SUBMITTED' })).toBe('STATE')
    expect(key('FORBIDDEN', { capability: 'budget.overrun.submit' })).toBe('FORBIDDEN')
    expect(key('APPROVER_NOT_FOUND')).toBe('NO_APPROVER')
    expect(key('RATE_LIMITED')).toBe('BUSY')
    expect(key('SOMETHING_NEW')).toBe('FAILED')
    expect(t(`errors.${key('DOA_NOT_CONFIGURED')}`)).toBe('ผังอำนาจที่มีผลยังไม่มีข้อการขออนุมัติเกินงบ จึงส่งไม่ได้ แจ้งผู้ดูแลผังอำนาจ')
    expect(tEn(`errors.${key('VALIDATION_FAILED', { reason: 'NOT_OVER_BUDGET' })}`)).toBe('The budget line has enough for this request now. No over-budget approval is needed; send the request.')
  })

  it('the reason is required before anything is sent', () => {
    expect(overrunReasonError('  ab ', 1000)).toBe('REASON')
    expect(overrunReasonError('งานด่วน', 1000)).toBeNull()
    expect(overrunReasonError('x'.repeat(1001), 1000)).toBe('REASON_TOO_LONG')
    expect(t('errors.REASON_TOO_LONG', { max: 1000 })).toBe('เหตุผลยาวเกิน 1000 ตัวอักษร ย่อให้สั้นลง')
  })

  it('the request form says the request is locked while its over-budget approval waits (OVERRUN_PENDING)', () => {
    const locked = toFormFailure({ code: 'INVALID_STATE_TRANSITION', details: { reason: 'OVERRUN_PENDING' } })
    expect([failureKey(locked), failureStep(locked)]).toEqual(['OVERRUN_PENDING', null])
    expect(createTranslator({ locale: 'th', messages: th, namespace: 'requestForm' })('errors.OVERRUN_PENDING')).toContain('รอผลการขออนุมัติเกินงบ')
    // A request sent or cancelled elsewhere still reads as before
    expect(failureKey(toFormFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'SUBMITTED' } }))).toBe('STATE')
  })
})

describe('[FR-BUD-101/AC2] the approver finds it in the inbox, and the dashboard shows what it funded', () => {
  it('the inbox names the OB number and the source request', () => {
    const tt = createTranslator({ locale: 'th', messages: th, namespace: 'tasks' }) as unknown as TasksT
    const task = (requestNumber: string | null) => ({ subject: { kind: 'BUDGET_OVERRUN', number: 'OB-CON-2569-0001', requestNumber, requestTitle: 'งานเปิดตัวโครงการ', amountSatang: 6_000_000n } }) as unknown as InboxTaskDto
    expect(taskTitle(tt, task('PR-CON-2569-0007'))).toBe('ขอเกินงบ OB-CON-2569-0001 · PR-CON-2569-0007')
    expect(taskTitle(tt, task(null))).toBe('ขอเกินงบ OB-CON-2569-0001 · งานเปิดตัวโครงการ')
  })

  it('"เติมจากเกินงบ" sits with the line\'s other changes before the planned amount', () => {
    const tb = createTranslator({ locale: 'th', messages: th, namespace: 'budgets' }) as unknown as BudgetsT
    const changes = { initial: money('100000.00'), transferredIn: money('0.00'), transferredOut: money('0.00'), increased: money('0.00'), decreased: money('0.00'), overrun: money('60000.00') }
    const view = changesView(tb, changes, money('160000.00'), 'CON-OPEX', '/budgets/l1')
    expect(view.rows.map((r) => [r.term, r.amount, r.total ?? false]).slice(-2)).toEqual([
      ['เติมจากเกินงบ', '60,000.00', false],
      ['งบปัจจุบัน', '160,000.00', true],
    ])
    expect(view.rows.at(-2)!.link.label).toBe('เติมจากเกินงบ 60,000.00 บาท ของ CON-OPEX: ดูความเคลื่อนไหวในบัญชีงบ')
  })
})

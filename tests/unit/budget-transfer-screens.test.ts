import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { changesView, type BudgetsT } from '@/app/(workspace)/budgets/_present'
import { routeText, transferLabel, type TransferT } from '@/app/(workspace)/budgets/transfers/_present'
import {
  bahtText,
  destinationLines,
  kindsOffered,
  senderActions,
  sameTransfer,
  sourceLines,
  transferFormErrors,
  transferInput,
  type TransferFormValues,
  type TransferLineOption,
} from '@/ui/budgets/transfer-model'
import { toTransferFailure, transferErrorField, transferErrorKey } from '@/ui/budgets/transfer-outcome'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The screens of budget transfers and adjustments (S6-15 · FR-BUD-103): which lines each kind offers the member (AC1 ·
// BR-BUD-10: a source they may give from, any other line as the destination of a transfer, a line they may raise for
// an increase), what the form checks before it sends and what it sends, how a refusal reads — BUDGET_INSUFFICIENT with
// its shortfall, DOA_NOT_CONFIGURED without the rule (AC4) — and the dashboard's breakdown of a line (AC3). Expected
// values are written out by hand. The pages run in tests/e2e/budget-transfer.spec.ts at 375 and 1440 px.

const baht = (amount: string) => ({ amount })
const line = (id: string, available: string, canGive: boolean, canIncrease = canGive): TransferLineOption => ({ id, code: id.toUpperCase(), nameTh: `งบ ${id}`, departmentCode: 'FIN', available: baht(available), canGive, canIncrease })
// A department head of FIN: gives from and raises the FIN lines, may send to the CON line, never from it
const finA = line('fin-a', '500000.00', true)
const finB = line('fin-b', '0.00', true)
const con = line('con', '900000.00', false)
const LINES = [finA, finB, con]

const values = (v: Partial<TransferFormValues>): TransferFormValues => ({ kind: 'TRANSFER', fromBudgetLineId: '', toBudgetLineId: '', amount: '', reason: '', ...v })

describe('[FR-BUD-103/AC1] the form offers only the lines the member may use for the kind', () => {
  it('a transfer gives from a line the member may give from, to any other line of the year', () => {
    expect(sourceLines('TRANSFER', LINES).map((l) => l.id)).toEqual(['fin-a', 'fin-b'])
    expect(destinationLines('TRANSFER', LINES, 'fin-a').map((l) => l.id)).toEqual(['fin-b', 'con'])
    expect(destinationLines('TRANSFER', LINES, '').map((l) => l.id)).toEqual(['fin-a', 'fin-b', 'con'])
  })

  it('an increase has only a destination the member may raise; a decrease only a source', () => {
    expect(sourceLines('INCREASE', LINES)).toEqual([])
    expect(destinationLines('INCREASE', LINES, '').map((l) => l.id)).toEqual(['fin-a', 'fin-b'])
    expect(sourceLines('DECREASE', LINES).map((l) => l.id)).toEqual(['fin-a', 'fin-b'])
    expect(destinationLines('DECREASE', LINES, 'fin-a')).toEqual([])
  })

  it('offers a kind only when the member has a line for it', () => {
    expect(kindsOffered(LINES)).toEqual(['TRANSFER', 'INCREASE', 'DECREASE'])
    // one line to give from and nothing else: no transfer, which needs another line
    expect(kindsOffered([finA])).toEqual(['INCREASE', 'DECREASE'])
    // a member who may give from nothing
    expect(kindsOffered([con])).toEqual([])
  })

  it('checks the lines, the amount and the reason before it sends', () => {
    expect(transferFormErrors(values({}), LINES)).toEqual({ from: { key: 'FROM' }, to: { key: 'TO' }, amount: { key: 'AMOUNT' }, reason: { key: 'REASON' } })
    // a line the member may not give from is not a source, whatever the browser sends
    expect(transferFormErrors(values({ fromBudgetLineId: 'con', toBudgetLineId: 'fin-a', amount: '1', reason: 'ย้ายงบ' }), LINES)).toEqual({ from: { key: 'FROM' } })
    expect(transferFormErrors(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'fin-a', amount: '1', reason: 'ย้ายงบ' }), LINES)).toEqual({ to: { key: 'TO' } })
    expect(transferFormErrors(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '0.00', reason: 'ย้ายงบ' }), LINES)).toEqual({ amount: { key: 'AMOUNT_NOT_POSITIVE' } })
    expect(transferFormErrors(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '1.005', reason: 'ย้ายงบ' }), LINES)).toEqual({ amount: { key: 'AMOUNT' } })
    expect(transferFormErrors(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '300,000', reason: ' ab ' }), LINES)).toEqual({ reason: { key: 'REASON' } })
    expect(transferFormErrors(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '300,000', reason: 'ย้ายงบไปงานก่อสร้าง' }), LINES)).toEqual({})
    // an increase needs no source and adds to the line whatever it has left
    expect(transferFormErrors(values({ kind: 'INCREASE', toBudgetLineId: 'fin-b', amount: '50000', reason: 'งบเพิ่มกลางปี' }), LINES)).toEqual({})
    expect(transferFormErrors(values({ kind: 'INCREASE', toBudgetLineId: 'con', amount: '50000', reason: 'งบเพิ่มกลางปี' }), LINES)).toEqual({ to: { key: 'TO' } })
  })

  it('says before sending what the source lacks, to the satang, as the server would (BUDGET_INSUFFICIENT)', () => {
    expect(transferFormErrors(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '500000.01', reason: 'ย้ายงบ' }), LINES)).toEqual({ amount: { key: 'INSUFFICIENT', shortfall: '0.01' } })
    expect(transferFormErrors(values({ kind: 'DECREASE', fromBudgetLineId: 'fin-b', amount: '1,250.50', reason: 'คืนงบ' }), LINES)).toEqual({ amount: { key: 'INSUFFICIENT', shortfall: '1,250.50' } })
    expect(transferFormErrors(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '500000.00', reason: 'ย้ายงบ' }), LINES)).toEqual({})
  })

  it('sends only the lines the kind takes, the amount as plain baht and the reason trimmed', () => {
    expect(transferInput(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: ' 300,000.5 ', reason: ' ย้ายงบ ' }))).toEqual({ kind: 'TRANSFER', fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '300000.5', reason: 'ย้ายงบ' })
    expect(transferInput(values({ kind: 'INCREASE', fromBudgetLineId: 'fin-a', toBudgetLineId: 'fin-b', amount: '10', reason: 'เพิ่มงบ' }))).toEqual({ kind: 'INCREASE', toBudgetLineId: 'fin-b', amount: '10', reason: 'เพิ่มงบ' })
    expect(transferInput(values({ kind: 'DECREASE', fromBudgetLineId: 'fin-a', toBudgetLineId: 'fin-b', amount: '10', reason: 'ลดงบ' }))).toEqual({ kind: 'DECREASE', fromBudgetLineId: 'fin-a', amount: '10', reason: 'ลดงบ' })
    expect(bahtText('1,000,000.00')).toBe('1000000.00')
    expect(bahtText('-5')).toBeNull()
    expect(bahtText('12.345')).toBeNull()
  })

  it('a draft kept from a refused send is sent again only for the same details', () => {
    const a = transferInput(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '300000', reason: 'ย้ายงบ' }))
    expect(sameTransfer(a, transferInput(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '300,000.00', reason: 'ย้ายงบ ' })))).toBe(true)
    expect(sameTransfer(a, transferInput(values({ fromBudgetLineId: 'fin-a', toBudgetLineId: 'con', amount: '300000.01', reason: 'ย้ายงบ' })))).toBe(false)
    expect(sameTransfer(a, transferInput(values({ fromBudgetLineId: 'fin-b', toBudgetLineId: 'con', amount: '300000', reason: 'ย้ายงบ' })))).toBe(false)
  })

  it('its sender sends it while a draft or returned, and cancels it until it is decided; nobody else does', () => {
    expect(senderActions('DRAFT', true)).toEqual({ send: true, cancel: true })
    expect(senderActions('RETURNED', true)).toEqual({ send: true, cancel: true })
    expect(senderActions('PENDING_APPROVAL', true)).toEqual({ send: false, cancel: true })
    for (const s of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) expect(senderActions(s, true)).toEqual({ send: false, cancel: false })
    for (const s of ['DRAFT', 'RETURNED', 'PENDING_APPROVAL'] as const) expect(senderActions(s, false)).toEqual({ send: false, cancel: false })
  })

  it('names a transfer by its number, a draft in words, and where the money goes without an arrow', () => {
    const t = createTranslator({ locale: 'th', messages: th, namespace: 'budgetTransfer' }) as unknown as TransferT
    const ref = (code: string) => ({ id: code, code, nameTh: `งบ ${code}` })
    expect(transferLabel(t, { number: 'BT-FIN-2569-0001' })).toBe('BT-FIN-2569-0001')
    expect(transferLabel(t, { number: null })).toBe('ร่างที่ยังไม่มีเลข')
    expect(routeText(t, { from: ref('FIN-OPEX'), to: ref('CON-OPEX') })).toBe('จาก FIN-OPEX ไป CON-OPEX')
    expect(routeText(t, { from: null, to: ref('CON-OPEX') })).toBe('ไป CON-OPEX')
    expect(routeText(t, { from: ref('FIN-OPEX'), to: null })).toBe('จาก FIN-OPEX')
  })
})

describe('[FR-BUD-103/AC4] a refusal says what happened and how to fix it', () => {
  const t = createTranslator({ locale: 'th', messages: th, namespace: 'budgetTransfer' })
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'budgetTransfer' })

  it('the DOA in effect has no BUDGET_TRANSFER rule: DOA_NOT_CONFIGURED, said for the form as a whole', () => {
    const f = toTransferFailure({ code: 'DOA_NOT_CONFIGURED', details: { documentType: 'BUDGET_TRANSFER' } })
    expect(transferErrorKey(f)).toBe('DOA_NOT_CONFIGURED')
    expect(transferErrorField(f)).toBeNull()
    expect(t(`errors.${transferErrorKey(f)}`)).toBe('ผังอำนาจที่มีผลยังไม่มีข้อการโอนงบ จึงส่งไม่ได้')
    expect(t('noRule')).toBe('ผังอำนาจที่มีผลยังไม่มีข้อการโอนงบ จึงส่งไม่ได้')
    expect(tEn(`errors.${transferErrorKey(f)}`)).toBe('The DOA in effect has no budget transfer rule, so it cannot be sent.')
  })

  it('not enough left: BUDGET_INSUFFICIENT with the shortfall, beside the amount', () => {
    const f = toTransferFailure({ code: 'BUDGET_INSUFFICIENT', details: { available: '500000.00', shortfall: '1250.5' } })
    expect(f).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT', shortfall: '1250.5' })
    expect(transferErrorField(f)).toBe('amount')
    expect(t(`errors.${transferErrorKey(f)}`, { shortfall: '1,250.50' })).toBe('งบคงเหลือไม่พอ ขาดอีก 1,250.50 บาท')
  })

  it('the lines refused by the service are said beside the field they are about', () => {
    expect(transferErrorField(toTransferFailure({ code: 'VALIDATION_FAILED', details: { field: 'toBudgetLineId', reason: 'SAME_LINE' } }))).toBe('to')
    expect(transferErrorField(toTransferFailure({ code: 'VALIDATION_FAILED', details: { field: 'fromBudgetLineId', reason: 'LINE_NOT_OPEN' } }))).toBe('from')
    expect(transferErrorField(toTransferFailure({ code: 'VALIDATION_FAILED', details: { field: 'toBudgetLineId', reason: 'UNKNOWN' } }))).toBe('to')
    expect(transferErrorKey(toTransferFailure({ code: 'VALIDATION_FAILED', details: { reason: 'LINES_DO_NOT_FIT_KIND' } }))).toBe('LINES_DO_NOT_FIT_KIND')
    expect(transferErrorKey(toTransferFailure({ code: 'VALIDATION_FAILED', details: { field: 'reason' } }))).toBe('INPUT')
    expect(transferErrorField(toTransferFailure({ code: 'VALIDATION_FAILED', details: { field: 'reason' } }))).toBe('reason')
    expect(transferErrorKey(toTransferFailure({ code: 'FORBIDDEN' }))).toBe('FORBIDDEN')
    expect(transferErrorKey(toTransferFailure({ code: 'INVALID_STATE_TRANSITION' }))).toBe('STATE')
    expect(transferErrorKey(toTransferFailure({ code: 'APPROVER_NOT_FOUND' }))).toBe('NO_APPROVER')
  })
})

describe('[FR-BUD-103/AC3] the dashboard shows how each line came to its planned amount', () => {
  const t = createTranslator({ locale: 'th', messages: th, namespace: 'budgets' }) as unknown as BudgetsT
  const money = (amount: string) => ({ amount, currency: 'THB' as const })

  it('initial, transferred in and out, increased, decreased, then the planned amount — each linking to what makes it up', () => {
    const changes = { initial: money('1000000.00'), transferredIn: money('300000.00'), transferredOut: money('0.00'), increased: money('50000.5'), decreased: money('20000.00') }
    const view = changesView(t, changes, money('1330000.50'), 'FIN-OPEX', '/budgets/l1')
    expect(view.toggle).toBe('ที่มาของงบ')
    expect(view.rows.map((r) => [r.term, r.amount, r.link.href, r.total ?? false])).toEqual([
      ['งบตั้งต้น', '1,000,000.00', '/budgets/l1#planned', false],
      ['โอนเข้า', '300,000.00', '/budgets/l1#movements', false],
      ['โอนออก', '0.00', '/budgets/l1#movements', false],
      ['ปรับเพิ่ม', '50,000.50', '/budgets/l1#movements', false],
      ['ปรับลด', '20,000.00', '/budgets/l1#movements', false],
      ['งบปัจจุบัน', '1,330,000.50', '/budgets/l1#planned', true],
    ])
    expect(view.rows[1]!.link.label).toBe('โอนเข้า 300,000.00 บาท ของ FIN-OPEX: ดูความเคลื่อนไหวในบัญชีงบ')
    expect(view.rows[0]!.link.label).toBe('งบตั้งต้น 1,000,000.00 บาท ของ FIN-OPEX: ดูการนำเข้างบ')
    expect(view.rows[5]!.link.label).toBe('งบปัจจุบัน 1,330,000.50 บาท ของ FIN-OPEX: ดูการนำเข้างบ')
  })
})

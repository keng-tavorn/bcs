import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsolidatePanel } from '@/ui/procurement/consolidate-panel'
import { POOL_NO_ANSWER, poolActionErrorKey, toPoolFailure } from '@/ui/procurement/outcome'
import { PoolBoard, type PoolRequestView } from '@/ui/procurement/pool-board'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The procurement pool against §9.9 principle 7 (src/ui/procurement): while a choice of supplier is sent, only the
// button pressed says it is working, in its own words; and a choice or a round that got no answer says it is not
// certain it was made, and which button to press again — never that it failed, since an urgent request may have got its
// draft PO already. The hook both parts run through (src/ui/procurement/use-outcome-action.ts) is set by each test;
// the presses run in the browser (tests/e2e/procurement.spec.ts).

const hook = vi.hoisted(() => ({ pending: false, outcome: null as unknown }))
vi.mock('@/ui/procurement/use-outcome-action', () => ({
  useOutcomeAction: () => ({ pending: hook.pending, outcome: hook.outcome, run: async () => hook.outcome, clear: () => undefined }),
}))

afterEach(() => {
  hook.pending = false
  hook.outcome = null
})

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const shutButton = (words: string) => new RegExp(`<button type="button"[^>]*disabled=""[^>]*>${literally(words)}</button>`)

const REQUEST: PoolRequestView = {
  id: 'r-1',
  title: 'PR-2569-00012 · ไม้อัดและตะปู',
  number: 'PR-2569-00012',
  href: '/requests/r-1',
  meta: ['ผู้ขอ สมชาย'],
  urgent: false,
  suggested: null,
  blocked: null,
  lines: [{ id: 'l-1', no: 1, description: 'ไม้อัด', kind: 'สินค้า', quantity: '20 แผ่น', unitPrice: '1,500.00', amount: '30,000.00', includesVat: false, supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }],
}
const board = () => render(<PoolBoard requests={[REQUEST]} suppliers={[{ id: 's-1', label: 'S-001 · บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }]} assign={async () => ({ ok: true })} />)
const panel = () => render(<ConsolidatePanel next="รอบอัตโนมัติถัดไป" ready={1} consolidate={async () => ({ ok: true })} />)
const assign = { th: th.procurement.pool.assign, en: en.procurement.pool.assign }

describe('[FR-P2P-001/AC2] while a choice of supplier is sent, only the button pressed says so, in its own words', () => {
  it('"ใช้ผู้ขายนี้กับบรรทัดที่เลือก" says "กำลังใช้ผู้ขายนี้"; taking the supplier off waits shut under its own words', () => {
    hook.pending = true
    const html = board()
    expect(assign.th.working).toBe('กำลังใช้ผู้ขายนี้')
    expect(html).toMatch(shutButton(assign.th.working))
    expect(html).toMatch(shutButton(assign.th.clear))
    expect(html).not.toContain(assign.th.clearing)
    expect(html).not.toContain('กำลังบันทึก')
  })

  it('taking the supplier off has words of its own for its press, in Thai and in English', () => {
    expect(assign.th.clearing).toBe('กำลังเอาผู้ขายออก')
    expect(assign.en.working).toBe('Using this supplier')
    expect(assign.en.clearing).toBe('Removing the supplier')
    for (const words of [assign.th.working, assign.th.clearing, assign.en.working, assign.en.clearing]) expect(words).not.toMatch(/บันทึก|Saving/)
  })
})

describe('[FR-P2P-001/AC2] [FR-P2P-002/AC3] a choice or a round that got no answer says it is not certain, and which button to press again', () => {
  it('the choice of supplier and the round each say their own words, never "not saved"', () => {
    hook.outcome = POOL_NO_ANSWER
    const chosen = board()
    expect(chosen).toContain(th.procurement.pool.errors.NO_ANSWER_ASSIGN)
    expect(chosen).not.toContain(th.procurement.pool.errors.FAILED)
    const round = panel()
    expect(round).toContain(th.procurement.pool.errors.NO_ANSWER_ROUND)
    expect(round).not.toContain(th.procurement.pool.errors.FAILED)
  })

  it('names the button to press again, in Thai and in English', () => {
    for (const messages of [th, en]) {
      const pool = messages.procurement.pool
      for (const [words, button] of [
        [pool.errors.NO_ANSWER_ASSIGN, pool.assign.submit],
        [pool.errors.NO_ANSWER_CLEAR, pool.assign.clear],
        [pool.errors.NO_ANSWER_ROUND, pool.round.confirm],
      ] as const) {
        expect(words).toContain(`“${button}”`)
        expect(words).toMatch(messages === th ? /^ไม่ได้รับคำตอบจากระบบ จึงไม่แน่ใจว่า/ : /^No answer came back, so it is not certain/)
        expect(words).not.toMatch(/ไม่สำเร็จ|Not saved/)
      }
    }
  })

  it('maps no answer to the words of each action, and every answer as before', () => {
    expect(poolActionErrorKey(POOL_NO_ANSWER, 'assign')).toBe('NO_ANSWER_ASSIGN')
    expect(poolActionErrorKey(POOL_NO_ANSWER, 'clear')).toBe('NO_ANSWER_CLEAR')
    expect(poolActionErrorKey(POOL_NO_ANSWER, 'round')).toBe('NO_ANSWER_ROUND')
    expect(poolActionErrorKey(toPoolFailure({ code: 'FORBIDDEN' }), 'round')).toBe('FORBIDDEN')
    expect(poolActionErrorKey(toPoolFailure({ code: 'VALIDATION_FAILED', details: { reason: 'NO_CHANGE' } }), 'clear')).toBe('NO_CHANGE')
    expect(poolActionErrorKey(toPoolFailure({ code: 'MODULE_DISABLED' }), 'assign')).toBe('FAILED')
  })
})

import { createTranslator, NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PayRunTaskT } from '@/app/(workspace)/_tracking/assistant-present'
import { askPart, assistantPanel, flagNote, invoiceNotes, priceNote, stepNote, type ApInvoiceT, type PanelT } from '@/app/(workspace)/_tracking/document-assistant'
import type { BriefView } from '@/app/_lib/brief-present'
import type { PriceReferenceDto } from '@/server/queries/price-reference'
import { AssistantPanel } from '@/ui/assistants/document-panel'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// NEW-122 (ADR-079 · FR-INT-012 AC7): the panel "จากผู้ช่วย" in Thai and English. What the assistants found comes from
// what the page read already — the step waiting now and its due time, the request's flags, the decider's reference
// price, the invoice's alerts — each with one way on and the icon of the work (no Sparkles); the AI's parts (the Brief
// with "ช่วยได้" "ไม่ช่วย", the shortcuts to "ถาม BCS AI") only when given, so with the AI off the rules' part is left.

const NOW = new Date('2026-10-12T03:00:00Z')
const somchai = { id: 'm-somchai', name: { th: 'สมชาย ใจดี', en: 'Somchai Jaidee' } }
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000)

const words = (locale: 'th' | 'en') => {
  const messages = locale === 'th' ? th : en
  return {
    t: createTranslator({ locale, messages, namespace: 'assistantPanel' }) as unknown as PanelT,
    ta: createTranslator({ locale, messages, namespace: 'apInvoice' }) as unknown as ApInvoiceT,
    tp: createTranslator({ locale, messages, namespace: 'payRun.task' }) as unknown as PayRunTaskT,
  }
}

const reference = {
  windowDays: 180,
  lines: [
    { lineNo: 1, description: 'ปูนซีเมนต์', count: 4, deviationBp: 600, alert: 'HIGH' },
    { lineNo: 2, description: 'เหล็กเส้น', count: 3, deviationBp: 1250, alert: 'HIGH' },
    { lineNo: 3, description: 'ทราย', count: 5, deviationBp: -900, alert: 'LOW' },
  ],
} as unknown as PriceReferenceDto

const brief: BriefView = {
  title: 'สรุปจาก AI',
  note: 'AI อาจผิดพลาด ตรวจกับเอกสาร',
  pending: null,
  sentences: ['คำขอนี้ยอด 45,000.00 บาท ตามข้อ PR-03'],
  factsOnly: null,
  factsTitle: 'ข้อเท็จจริงจากระบบ',
  facts: [{ label: 'ยอดตามฐาน DOA', value: '45,000.00 บาท' }],
  agentActionId: '01900000-0000-7000-8000-000000000001',
  feedback: 'HELPFUL',
}

describe('[FR-INT-012/AC7] what the assistants found in the document', () => {
  it('the step waiting now: past due, due within a day, or nothing; the decider reads that it waits for them', () => {
    const { t } = words('th')
    const late = stepNote(t, 'th', NOW, 'me', { assignee: somchai, onBehalfOf: null, dueAt: hours(-2), overdue: true }, '/requests/r1?tab=overview#route')
    expect(late).toMatchObject({ key: 'STEP_OVERDUE', icon: 'AlarmClock', tone: 'danger', action: { href: '/requests/r1?tab=overview#route', label: 'ดูเส้นทางอนุมัติ' } })
    expect(late!.title).toMatch(/^ขั้นที่รออยู่เกินกำหนดแล้ว \(ครบเมื่อ 12 ต\.ค\. 2569 08:00 น\.\)$/)
    expect(late!.why).toBe('ยังรอ สมชาย ใจดี ตัดสิน · ระบบเตือนผู้อนุมัติตามเวลาแล้ว')
    const soon = stepNote(t, 'th', NOW, 'me', { assignee: somchai, onBehalfOf: null, dueAt: hours(3), overdue: false }, '#route')
    expect(soon).toMatchObject({ key: 'STEP_DUE_SOON', icon: 'Hourglass', tone: 'warn' })
    expect(stepNote(t, 'th', NOW, 'me', { assignee: somchai, onBehalfOf: null, dueAt: hours(30), overdue: false }, '#route')).toBeNull()
    expect(stepNote(t, 'th', NOW, 'me', { assignee: somchai, onBehalfOf: null, dueAt: null, overdue: false }, '#route')).toBeNull()
    expect(stepNote(t, 'th', NOW, 'me', null, '#route')).toBeNull()
    // the decider, or the member a delegate acts for
    expect(stepNote(t, 'th', NOW, 'm-somchai', { assignee: somchai, onBehalfOf: null, dueAt: hours(3), overdue: false }, '#route')!.why).toBe('งานนี้รอคุณตัดสินที่แถบตัดสิน')
    expect(stepNote(t, 'th', NOW, 'm-boss', { assignee: somchai, onBehalfOf: { id: 'm-boss', name: { th: 'หัวหน้า', en: null } }, dueAt: hours(3), overdue: false }, '#route')!.why).toBe('งานนี้รอคุณตัดสินที่แถบตัดสิน')
  })

  it('the request’s flags, and the line furthest above its reference price', () => {
    const { t } = words('th')
    expect(flagNote(t, [], '#request-flags')).toBeNull()
    const flags = flagNote(
      t,
      [
        { kind: 'SPLIT', routeNo: 1, matched: [{ id: 'r2', label: 'PR-2569-00002' }], combinedSatang: '9000000', individualRule: 'PR-02', combinedRule: 'PR-03', reason: null },
        { kind: 'DUPLICATE', routeNo: 1, matched: [{ id: 'r2', label: 'PR-2569-00002' }, { id: 'r3', label: 'PR-2569-00003' }], combinedSatang: null, individualRule: null, combinedRule: null, reason: 'ซื้อคนละหน้างาน' },
      ],
      '/requests/r1?tab=overview#request-flags',
    )!
    expect(flags).toMatchObject({ key: 'REQUEST_FLAG:DUPLICATE+SPLIT', icon: 'Copy', tone: 'warn' })
    expect(flags.title).toBe('คำขอนี้อาจซ้ำกับคำขอเดิม และ อาจแบ่งซื้อจนยอดข้ามช่วงอำนาจอนุมัติ')
    expect(flags.why).toBe('ระบบตรวจตอนส่งคำขอ · เกี่ยวกับ PR-2569-00002, PR-2569-00003')
    const price = priceNote(t, reference, '/tasks/t1#price-reference')!
    expect(price).toMatchObject({ key: 'PRICE_HIGH:2', icon: 'Tag', action: { href: '/tasks/t1#price-reference' } })
    expect(price.title).toBe('บรรทัด 2 ราคาสูงกว่าราคาอ้างอิง 12.50%')
    expect(price.why).toBe('เหล็กเส้น · เทียบค่ากลางของ PO 3 ใบใน 180 วันล่าสุด')
    expect(priceNote(t, { ...reference, lines: reference.lines.filter((l) => l.alert !== 'HIGH') }, '#')).toBeNull()
  })

  it('the invoice’s alerts: its differences, a number used before, the supplier’s flags', () => {
    const { t, ta, tp } = words('th')
    const notes = invoiceNotes(t, ta, tp, {
      id: 'i1',
      supplierId: 's1',
      exceptions: [
        { type: 'PRICE_OVER', status: 'OPEN' },
        { type: 'QTY_NOT_RECEIVED', status: 'OPEN' },
      ],
      duplicateNumber: true,
      paymentFlags: ['BANK_ACCOUNT_RECENTLY_CHANGED', 'REGISTRY_CHANGED'],
    })
    expect(notes.map((n) => [n.key, n.icon, n.tone, n.action.href])).toEqual([
      ['INVOICE_DIFFERENCES:2', 'Scale', 'warn', '/finance/invoices/i1#invoice-exceptions'],
      ['INVOICE_DUPLICATE_NUMBER', 'Copy', 'warn', '/finance/invoices/i1?tab=details#invoice-header'],
      ['INVOICE_SUPPLIER_FLAGS:BANK_ACCOUNT_RECENTLY_CHANGED+REGISTRY_CHANGED', 'ShieldAlert', 'danger', '/suppliers/s1'],
    ])
    expect(notes[0]!.title).toBe('ใบนี้มีรายการไม่ตรง 2 รายการ')
    expect(notes[0]!.why).toBe('ราคาสูงกว่า PO เกินเกณฑ์ · จำนวนเกินที่รับของแล้ว · ดูทางแก้ของแต่ละรายการ')
    expect(notes[2]!.title).toMatch(/^ผู้ขาย: .+ และอีก 1 เรื่อง$/)
    // A difference whose variance approval was asked for waits for its approver
    const asked = invoiceNotes(t, ta, tp, { id: 'i1', supplierId: 's1', exceptions: [{ type: 'PRICE_OVER', status: 'ACCEPT_REQUESTED' }], duplicateNumber: false, paymentFlags: [] })
    expect(asked).toEqual([expect.objectContaining({ tone: 'info', why: 'ขออนุมัติส่วนต่างแล้ว รอผู้อนุมัติ' })])
    expect(invoiceNotes(t, ta, tp, { id: 'i1', supplierId: 's1', exceptions: [], duplicateNumber: false, paymentFlags: [] })).toEqual([])
  })

  it('in English, every word filled', () => {
    const { t, ta, tp } = words('en')
    const notes = [
      stepNote(t, 'en', NOW, 'me', { assignee: somchai, onBehalfOf: null, dueAt: hours(-1), overdue: true }, '#'),
      stepNote(t, 'en', NOW, 'me', { assignee: somchai, onBehalfOf: null, dueAt: hours(5), overdue: false }, '#'),
      flagNote(t, [{ kind: 'DUPLICATE', routeNo: 1, matched: [{ id: 'r2', label: 'PR-2569-00002' }], combinedSatang: null, individualRule: null, combinedRule: null, reason: null }], '#'),
      priceNote(t, reference, '#'),
      ...invoiceNotes(t, ta, tp, { id: 'i1', supplierId: 's1', exceptions: [{ type: 'VAT_MISMATCH', status: 'OPEN' }], duplicateNumber: true, paymentFlags: ['SHARED_BANK_ACCOUNT'] }),
    ]
    expect(notes[0]!.why).toBe('Still waiting for Somchai Jaidee to decide · the approvers were reminded on time')
    expect(notes[2]!.title).toBe('This request may repeat an earlier request')
    expect(notes[4]!.title).toBe('This invoice has 1 difference')
    for (const n of notes) expect(n!.title + n!.why + n!.action.label).not.toMatch(/[{}]/)
  })
})

describe('[FR-INT-012/AC7] [FR-INT-012/AC8] the panel: the AI’s parts only when on', () => {
  it('the shortcuts carry the document’s number; none without one or while "ถาม BCS AI" is off', () => {
    const { t } = words('th')
    expect(askPart(t, 'REQUEST', 'PR-2569-00012', true)).toMatchObject({ draft: 'คำขอ PR-2569-00012 ', summarize: 'สรุปคำขอ PR-2569-00012', labels: { ask: 'ถามเรื่องนี้', summarize: 'สรุปให้' } })
    expect(askPart(t, 'PURCHASE_ORDER', 'PO-2569-00004', true)!.summarize).toBe('สรุปใบสั่งซื้อ PO-2569-00004')
    expect(askPart(t, 'INVOICE', 'AP-2569-00002', true)!.summarize).toBe('สรุปใบแจ้งหนี้ AP-2569-00002')
    expect(askPart(t, 'REQUEST', null, true)).toBeNull()
    expect(askPart(t, 'REQUEST', 'PR-2569-00012', false)).toBeNull()
    expect(askPart(words('en').t, 'PURCHASE_ORDER', 'PO-2569-00004', true)).toMatchObject({ draft: 'PO PO-2569-00004 ', summarize: 'Summarize PO PO-2569-00004' })
  })

  const render = (view: ReturnType<typeof assistantPanel>) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="th" messages={th}>
        <AssistantPanel view={view} give={async () => ({ ok: true })} />
      </NextIntlClientProvider>,
    )

  it('with the AI on: the Brief apart with Sparkles and the reader’s own "ช่วยได้" pressed, the found notes, the shortcuts', () => {
    const { t } = words('th')
    const view = assistantPanel(t, { brief, notes: [stepNote(t, 'th', NOW, 'me', { assignee: somchai, onBehalfOf: null, dueAt: hours(3), overdue: false }, '#route'), null], ask: askPart(t, 'REQUEST', 'PR-2569-00012', true) })
    expect(view.brief!.feedback).toEqual({ agentActionId: brief.agentActionId, given: 'HELPFUL' })
    expect(view.found.notes).toHaveLength(1)
    const html = render(view)
    expect(html).toContain('จากผู้ช่วย')
    expect(html).toContain('id="ai-brief-title"')
    expect(html).toContain('ผลนี้ช่วยคุณไหม')
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?ช่วยได้/)
    expect(html).toContain('ถามเรื่องนี้')
    expect(html).toContain('สรุปให้')
    // No decision button: the Brief decides nothing (BR-AI-01)
    expect(html).not.toMatch(/>อนุมัติ<|>ไม่อนุมัติ<|>ตีกลับ/)
  })

  it('with the AI off: the rules’ part alone, no Sparkles; nothing found is said so', () => {
    const { t } = words('th')
    const html = render(assistantPanel(t, { brief: null, notes: [null], ask: null }))
    expect(html).toContain('ผู้ช่วยเจอในเอกสารนี้')
    expect(html).toContain('ยังไม่เจอเรื่องที่ต้องระวังในเอกสารนี้')
    expect(html).not.toContain('lucide-sparkles')
    expect(html).not.toContain('ถามเรื่องนี้')
    expect(html).not.toContain('ผลนี้ช่วยคุณไหม')
    // A Brief whose sentences the reader may not see has no buttons to press
    const factsOnly = render(assistantPanel(t, { brief: { ...brief, sentences: null, agentActionId: null, feedback: null }, notes: [], ask: null }))
    expect(factsOnly).toContain('สรุปจาก AI')
    expect(factsOnly).not.toContain('ผลนี้ช่วยคุณไหม')
  })
})

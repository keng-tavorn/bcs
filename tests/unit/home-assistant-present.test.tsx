import { createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { assistantNotes, type PayRunTaskT } from '@/app/(workspace)/_tracking/assistant-present'
import type { HomeT } from '@/app/(workspace)/_tracking/home-present'
import { SUGGESTION_KINDS } from '@/lib/assistant-suggestions'
import type { SuggestionDto } from '@/server/services/assistants/suggestions'
import { AssistantNote } from '@/ui/assistants/assistant-note'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// NEW-121 (ADR-078 · FR-VIS-006 AC7): every kind of the home card "ผู้ช่วยเจอให้คุณ" in Thai and English, with its figures
// formatted (a percent from basis points, a date as each language writes it), one way on, and no Sparkles.

const due = new Date('2026-10-12T09:30:00Z')
const name = { th: 'สมชาย ใจดี', en: 'Somchai Jaidee' }
const ALL: SuggestionDto[] = [
  { kind: 'FOLLOW_OVERDUE', key: 'FOLLOW_OVERDUE:t0', tone: 'DANGER', href: '/requests/r0', at: due, number: 'PR-2569-00001', title: 'วัสดุ', waitingFor: name, dueAt: due },
  { kind: 'SUPPLIER_FLAGS', key: 'SUPPLIER_FLAGS:s:BANK_ACCOUNT_RECENTLY_CHANGED+REGISTRY_CHANGED', tone: 'DANGER', href: '/finance/invoices/i0', at: null, supplier: { th: 'ผู้ขายหนึ่ง', en: 'Supplier One' }, flags: ['BANK_ACCOUNT_RECENTLY_CHANGED', 'REGISTRY_CHANGED'], invoices: 2 },
  { kind: 'FOLLOW_DUE_SOON', key: 'FOLLOW_DUE_SOON:t1', tone: 'WARN', href: '/requests/r1', at: due, number: 'PR-2569-00002', title: 'ปูน', waitingFor: name, dueAt: due },
  { kind: 'REQUEST_FLAG', key: 'REQUEST_FLAG:t2:DUPLICATE+SPLIT', tone: 'WARN', href: '/tasks/t2', at: null, number: 'PR-2569-00003', title: 'เหล็ก', flags: ['DUPLICATE', 'SPLIT'] },
  { kind: 'PRICE_HIGH', key: 'PRICE_HIGH:t3:1', tone: 'WARN', href: '/tasks/t3', at: null, number: 'PR-2569-00004', lineNo: 1, description: 'สว่านไฟฟ้า', deviationBp: 1250, samples: 3, windowDays: 180 },
  { kind: 'BUDGET_LOW', key: 'BUDGET_LOW:y:2', tone: 'WARN', href: '/budgets', at: null, count: 2, lowPct: 10, first: { code: 'CON-01', availableBp: 100 } },
  { kind: 'AGREEMENT_EXPIRING', key: 'AGREEMENT_EXPIRING:a:1', tone: 'INFO', href: '/catalog/manage', at: null, count: 1, days: 30, first: { item: { th: 'ถุงมือผ้า', en: 'Cloth gloves' }, supplier: { th: 'ผู้ขายหนึ่ง', en: null }, validTo: '2026-10-22' } },
]

const notesIn = (locale: 'th' | 'en') => {
  const messages = locale === 'th' ? th : en
  const t = createTranslator({ locale, messages, namespace: 'home' }) as unknown as HomeT
  const tp = createTranslator({ locale, messages, namespace: 'payRun.task' }) as unknown as PayRunTaskT
  return assistantNotes(t, tp, locale, ALL)
}

describe('[FR-VIS-006/AC7] the words of each suggestion', () => {
  it('every kind is in the fixture, so every kind is worded here', () => {
    expect(new Set(ALL.map((s) => s.kind))).toEqual(new Set(SUGGESTION_KINDS))
  })

  it('in Thai', () => {
    const notes = notesIn('th')
    expect(notes.map((n) => n.title)).toEqual([
      'PR-2569-00001 เกินกำหนดอนุมัติแล้ว',
      'ผู้ขายหนึ่ง: บัญชีเพิ่งเปลี่ยน และอีก 1 เรื่อง',
      expect.stringMatching(/^PR-2569-00002 จะครบกำหนดอนุมัติ 12 ต\.ค\. 2569 16:30 น\.$/),
      'PR-2569-00003 อาจซ้ำกับคำขอเดิม และ อาจแบ่งซื้อจนยอดข้ามช่วงอำนาจอนุมัติ',
      'PR-2569-00004 บรรทัด 1 ราคาสูงกว่าราคาอ้างอิง 12.50%',
      'งบ 2 บรรทัดเหลือต่ำกว่า 10%',
      'ราคาตกลง 1 รายการจะหมดอายุภายใน 30 วัน',
    ])
    expect(notes[0]!.why).toMatch(/^รอ สมชาย ใจดี · ครบกำหนดเมื่อ 12 ต\.ค\. 2569 16:30 น\. · /)
    expect(notes[5]!.why).toBe('น้อยที่สุดคือ CON-01 เหลือ 1.00%')
    expect(notes[6]!.why).toMatch(/^ใกล้สุดคือ ถุงมือผ้า ของ ผู้ขายหนึ่ง สิ้นสุด 22 ต\.ค\. 2569/)
    expect(notes.map((n) => n.tone)).toEqual(['danger', 'danger', 'warn', 'warn', 'warn', 'warn', 'info'])
    expect(notes.map((n) => n.action.href)).toEqual(ALL.map((s) => s.href))
  })

  it('in English, with the English names where there are', () => {
    const notes = notesIn('en')
    expect(notes[0]!.title).toBe('PR-2569-00001 is past its approval due time')
    expect(notes[0]!.why).toMatch(/^Waiting for Somchai Jaidee · due /)
    expect(notes[3]!.title).toBe('PR-2569-00003 may repeat an earlier request and may be split to stay under an approval limit')
    expect(notes[5]!.title).toBe('2 budget lines are below 10%')
    // a supplier without an English name keeps its Thai one
    expect(notes[6]!.why).toMatch(/^First: Cloth gloves from ผู้ขายหนึ่ง, ending /)
    for (const n of notes) expect(n.title + n.why + n.action.label).not.toMatch(/[{}]/)
  })

  it('draws the icon of the work, its words and one link — never the Sparkles of AI', () => {
    const html = renderToStaticMarkup(<AssistantNote note={notesIn('th')[4]!} />)
    expect(html).toContain('href="/tasks/t3"')
    expect(html).toContain('lucide-tag')
    expect(html).not.toContain('lucide-sparkles')
    expect(html).toContain('role="listitem"')
  })
})

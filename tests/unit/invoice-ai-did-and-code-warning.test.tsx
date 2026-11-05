import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CodingForm, type CodingLineView } from '@/ui/ap/invoice/coding-form'
import { InvoiceAiReview, type InvoiceAiReviewView } from '@/ui/ap/invoice/invoice-ai'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

// NEW-119: "AI ทำอะไรให้" above the invoice's AI review — what the AI did and what is left, counted from the review —
// and the coding form's warning in the line when the chosen account code is not the one the history used (BR-AP-10):
// a warning, not a dialog, and the confirm button stays (the code may still be chosen).

const render = (locale: 'th' | 'en', node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en}>
      {node}
    </NextIntlClientProvider>,
  )
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

const LINE_ID = '11111111-1111-4111-8111-111111111111'
const review = (notes: InvoiceAiReviewView['notes']): InvoiceAiReviewView => ({
  agentActionId: '22222222-2222-4222-8222-222222222222',
  fileId: '33333333-3333-4333-8333-333333333333',
  proposed: { supplierInvoiceNo: 'INV-1', invoiceDate: '2026-10-01', [`lines.${LINE_ID}.quantity`]: '5' },
  requiredPaths: [],
  confirmedPaths: ['supplierInvoiceNo'],
  reading: null,
  notes,
})
const aiReview = (locale: 'th' | 'en', r: InvoiceAiReviewView, current: Record<string, string>) =>
  text(
    render(
      locale,
      <InvoiceAiReview
        invoiceId="inv"
        version={1}
        review={r}
        current={current}
        lines={[{ poLineId: LINE_ID, description: 'ปูนซีเมนต์', uom: 'ถุง' }]}
        update={async () => ({ ok: true }) as never}
        openFile={async () => null}
      />,
    ),
  )

describe('[FR-AI-303/AC6] "AI ทำอะไรให้" on the invoice read by the AI', () => {
  it('[FR-AI-303/AC6] lists the file read, the fields filled, what the checks found and what the person has confirmed', () => {
    // One value changed by FINANCE counts as confirmed; one saved; one left
    const out = aiReview('th', review([{ code: 'TOTAL_MISMATCH', tone: 'warning' }]), { supplierInvoiceNo: 'INV-1', invoiceDate: '2026-10-02', [`lines.${LINE_ID}.quantity`]: '5' })
    expect(out).toContain('AI ทำอะไรให้')
    expect(out).toContain('ทำแล้ว: อ่านไฟล์ใบแจ้งหนี้ที่แนบ')
    expect(out).toContain('ทำแล้ว: สร้างร่างและเติมให้ 3 ช่อง')
    expect(out).toContain('ทำแล้ว: ตรวจค่าที่อ่านได้ เจอ 1 เรื่องที่ต้องดู')
    expect(out).toContain('ยังเหลือ: คุณยืนยันแล้ว 2 จาก 3 ช่อง · แก้เอง 1 ช่อง')
  })

  it('[FR-AI-303/AC6] nothing found and every value confirmed: the last line is done too, in English as well', () => {
    const all = { ...review([]), confirmedPaths: ['supplierInvoiceNo', 'invoiceDate', `lines.${LINE_ID}.quantity`] }
    const current = { supplierInvoiceNo: 'INV-1', invoiceDate: '2026-10-01', [`lines.${LINE_ID}.quantity`]: '5' }
    expect(aiReview('th', all, current)).toContain('ทำแล้ว: คุณยืนยันแล้ว 3 จาก 3 ช่อง · แก้เอง 0 ช่อง')
    const out = aiReview('en', all, current)
    expect(out).toContain('What the AI did for you')
    expect(out).toContain('Done: Checked what it read and found nothing to look at')
    expect(out).toContain('Done: You confirmed 3 of 3 fields · changed 0 yourself')
  })
})

const coding = (locale: 'th' | 'en', line: Partial<CodingLineView>) =>
  render(
    locale,
    <CodingForm
      invoiceId="inv"
      version={1}
      lines={[
        {
          id: LINE_ID, lineNo: 1, description: 'ปูนซีเมนต์', accountCode: null, costCenterId: null, costCenterReason: '', whtIncomeTypeCode: null,
          budgetCostCenterId: 'cc-1', confirmed: false, suggestion: { accountCode: '510101', sourceText: 'ใช้ 3 ครั้งใน 12 เดือน', fromHistory: true }, ...line,
        },
      ]}
      choices={{ accountCodes: [{ value: '510101', label: '510101' }, { value: '520202', label: '520202' }], costCenters: [{ value: 'cc-1', label: 'CC1' }], incomeTypes: [{ value: '-', label: 'ไม่หัก' }] }}
      confirm={async () => ({ ok: true }) as never}
    />,
  )

describe('[FR-AP-108/AC1] a warning in the line when the code is not the one used before', () => {
  it('[FR-AP-108/AC1] the history code chosen: no warning', () => {
    expect(text(coding('th', {}))).not.toContain('ต่างจาก 510101')
  })

  it('[FR-AP-108/AC1] another code than the history’s: a status in the line, no dialog, and the confirm button stays usable', () => {
    const html = coding('th', { accountCode: '520202' })
    expect(text(html)).toContain('รหัส 520202 ต่างจาก 510101 ที่เคยใช้กับผู้ขายและหมวดนี้ (ใช้ 3 ครั้งใน 12 เดือน) เลือกต่อได้')
    expect(html).toMatch(/role="status"/)
    expect(html).not.toMatch(/role="(alert)?dialog"/)
    // The button carries only its type and class: no disabled attribute
    expect(html).toMatch(/<button type="button" class="[^"]*">ยืนยันรหัสบัญชีทุกบรรทัด<\/button>/)
    expect(text(coding('en', { accountCode: '520202' }))).toContain('520202 differs from 510101, used before for this supplier and category')
  })

  it('[FR-AP-108/AC1] a code from the budget line is not a history: no warning when another is chosen', () => {
    const out = text(coding('th', { accountCode: '520202', suggestion: { accountCode: '510101', sourceText: 'จากบรรทัดงบ', fromHistory: false } }))
    expect(out).not.toContain('ต่างจาก 510101')
  })
})

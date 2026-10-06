import fc from 'fast-check'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { FieldDef } from '@/core/forms/fields'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { formatEnglishBeDay, formatThaiDay } from '@/core/thai/day'
import { LiffProvider } from '@/ui/liff/liff-provider'
import { LiffCameraAttach } from '@/ui/liff/requests/camera-attach'
import { LiffCatalog } from '@/ui/liff/requests/catalog'
import { LiffDetailsStep } from '@/ui/liff/requests/details-step'
import { createEarlySaver, EARLY_SAVE_TIMEOUT_MS, earlyDraft, type EarlyBase, type EarlyState } from '@/ui/liff/requests/early-save'
import { evaluate } from '@/ui/liff/requests/engine'
import { LiffField } from '@/ui/liff/requests/field'
import { newUuid } from '@/ui/liff/requests/key'
import { openingLines, previewLinesOf } from '@/ui/liff/requests/lines'
import { LiffRequesterScreen, type LiffRequesterProps } from '@/ui/liff/requests/requester-box'
import { openFileWith } from '@/ui/liff/requests/review-step'
import { liffFormStart } from '@/ui/liff/requests/start'
import { LiffTrackList } from '@/ui/liff/requests/track-list'
import { draftPayload, formReducer, initialValues, plainNumber, savableLine, type FormAction, type FormLine, type FormValues } from '@/ui/request-form/model'
import type { BudgetView, RequestFormData } from '@/ui/request-form/types'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S5-06 · the LIFF request pages' own parts (src/ui/liff/requests): where the short form starts — worked out on the
// server so the first JavaScript of the page carries none of the rules (§9.4) — and that the engine the browser loads
// on the first touch agrees with it; the lean field, the first step, the catalogue and the list as markup. Static
// markup only (no DOM here); how they behave in the LINE-sized browser runs in tests/e2e/liff-requests.spec.ts with axe.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** Inside the LIFF bootstrap, as every page under /liff is (a LIFF session; no SDK in a static render) */
const inLiff = (node: ReactNode) => html(<LiffProvider config={{ liffId: null, mock: null, session: 'liff' }}>{node}</LiffProvider>)

const yesNo = { Y: { th: 'ใช่', en: 'Yes' }, N: { th: 'ไม่ใช่', en: 'No' } }
const FIELDS: FieldDef[] = [
  {
    id: 'category',
    type: 'select',
    required: true,
    options: ['HARDWARE', 'SOFTWARE'],
    label: { th: 'หมวด', en: 'Category' },
    optionLabels: { HARDWARE: { th: 'ฮาร์ดแวร์', en: 'Hardware' }, SOFTWARE: { th: 'ซอฟต์แวร์และไลเซนส์', en: 'Software and licences' } },
  },
  { id: 'assetTag', type: 'text', label: { th: 'เลขทะเบียนทรัพย์สิน', en: 'Asset tag' }, help: { th: 'ถ้าทราบแล้ว', en: 'If known' } },
  { id: 'processesPersonalData', type: 'select', required: true, options: ['Y', 'N'], label: { th: 'ผู้ขายจะประมวลผลข้อมูลส่วนบุคคลแทนบริษัทหรือไม่', en: 'Personal data?' }, optionLabels: yesNo },
]

const LINE = { id: '00000000-0000-4000-8000-000000000001', code: 'IT-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที', departmentId: 'd-it', departmentName: 'ฝ่ายไอที', costCenterCode: 'CC-IT', costCenterName: 'ศูนย์ต้นทุนฝ่ายไอที', granted: false }
const SITE = { id: '00000000-0000-4000-8000-000000000002', code: 'HQ-STORE', name: 'คลังสำนักงานใหญ่', address: null }

function itForm(draft: RequestFormData['draft'] = null): RequestFormData {
  return {
    type: { code: 'IT_PURCHASE', name: 'ซื้ออุปกรณ์/ซอฟต์แวร์ไอที', description: 'ฮาร์ดแวร์ ซอฟต์แวร์ ไลเซนส์', documentType: 'PURCHASE_REQUEST' },
    form: { fields: FIELDS, visibility: [{ field: 'assetTag', when: { field: 'category', op: 'eq', value: 'HARDWARE' } }], rules: [], lines: { serviceEndDate: { when: { field: 'category', op: 'eq', value: 'SOFTWARE' } } } },
    requesterDepartmentName: 'ฝ่ายไอที',
    budgetLines: [LINE],
    defaultBudgetLineId: LINE.id,
    vatRateBp: 700,
    attachmentKinds: ['DPA', 'JUSTIFICATION', 'PHOTO', 'OTHER'],
    deliverySites: [SITE],
    defaultDeliverySiteId: SITE.id,
    suppliers: [],
    draft,
  }
}

/** The values the LIFF form opens with in the browser: what the server worked out, and the lines of the page's data */
const openingOf = (data: RequestFormData): FormValues => ({ ...liffFormStart(data).values, lines: openingLines(data) })

const DRAFT_LINES = [
  { id: '00000000-0000-4000-8000-000000000004', reserved: null, description: 'เซิร์ฟเวอร์', quantity: '1', uom: 'เครื่อง', unitPrice: '60,000.00', vatable: true, serviceEndDate: null },
  { id: '00000000-0000-4000-8000-000000000005', reserved: null, description: 'สายไฟ', quantity: '', uom: 'เส้น', unitPrice: '', vatable: true, serviceEndDate: null },
] as const

const serverDraft = (lines: NonNullable<RequestFormData['draft']>['lines'], status: 'DRAFT' | 'RETURNED' = 'DRAFT'): NonNullable<RequestFormData['draft']> => ({
  requestId: '00000000-0000-4000-8000-000000000003',
  version: 2,
  status,
  title: 'เซิร์ฟเวอร์สำรองข้อมูล',
  budgetLineId: LINE.id,
  priceIncludesVat: false,
  formData: { category: 'HARDWARE' },
  lines,
  quotations: [],
  nonLowestQuoteReason: '',
  attachments: [],
  returnReason: null,
  deliverySiteId: null,
  suggestedSupplierId: null,
})

describe('[FR-INT-003/AC1] [FR-INT-002/AC1] the LIFF form starts as the server works it out, and the browser’s engine agrees', () => {
  it('[FR-INT-003/AC1] a new form opens with the default budget line and site (BR-FORM-02), one empty line, and the fields the rules show', () => {
    const start = liffFormStart(itForm())
    expect(start.values.budgetLineId).toBe(LINE.id)
    expect(start.values.deliverySiteId).toBe(SITE.id)
    expect(openingLines(itForm())).toHaveLength(1)
    expect(previewLinesOf(openingOf(itForm()))).toEqual([])
    // The asset tag shows for hardware only (FR-INT-002 AC1): nothing is chosen yet
    expect(start.visible).toEqual(['category', 'processesPersonalData'])
    expect(start.titleMax).toBe(200)
  })

  it('[FR-INT-002/AC1] the engine shows the asset tag as soon as hardware is chosen, and agrees with the server on the opening values', () => {
    const data = itForm()
    const start = liffFormStart(data)
    expect([...evaluate(data, openingOf(data), []).visible]).toEqual(start.visible)
    const hardware = { ...openingOf(data), fields: { category: 'HARDWARE' } }
    expect([...evaluate(data, hardware, []).visible]).toEqual(['category', 'assetTag', 'processesPersonalData'])
    // Software: the lines must carry the day the service ends (BR-FORM-05)
    expect(evaluate(data, { ...openingOf(data), fields: { category: 'SOFTWARE' } }, []).endDateRequired).toBe(true)
  })

  it('[FR-INT-004/AC1] a draft opens with its own values; the preview is asked about its complete lines, numbers as plain text', () => {
    const data = itForm(serverDraft([...DRAFT_LINES]))
    const start = liffFormStart(data)
    expect(start.values.title).toBe('เซิร์ฟเวอร์สำรองข้อมูล')
    // A draft keeps what it saved, "no site chosen" too
    expect(start.values.deliverySiteId).toBe('')
    expect(start.visible).toContain('assetTag')
    expect(previewLinesOf(openingOf(data))).toEqual([{ quantity: '1', unitPrice: '60000.00', vatable: true }])
  })

  it('[§9.4] the draft’s lines are written into the page once: the start carries none, and the browser opens with the workspace’s values', () => {
    const data = itForm(serverDraft([...DRAFT_LINES]))
    const start = liffFormStart(data)
    expect(start).not.toHaveProperty('previewLines')
    expect(start.values).not.toHaveProperty('lines')
    expect(JSON.stringify(start)).not.toContain(DRAFT_LINES[0].id)
    expect(openingOf(data)).toEqual(initialValues(data))
  })
})

describe('[FR-INT-004/AC1] [§9.4] the lines of the LIFF form in the browser follow the workspace’s form rules (src/ui/request-form/model.ts)', () => {
  const text = fc.oneof(fc.constantFrom('', ' ', '1', '0', '00', '0.5', '1,234.50', ' 12 ', '1.2345', '1.23456', '12.345', '-1', '1e3', 'abc', '99999999999999', '100,000.00'), fc.string({ maxLength: 8 }))
  const line = fc.record({
    key: fc.uuid(),
    id: fc.option(fc.uuid(), { nil: null }),
    reserved: fc.constant(null),
    description: fc.constantFrom('', '  ', 'ไม้อัด', 'สายไฟ VAF'),
    quantity: text,
    uom: fc.constantFrom('', ' ', 'แผ่น', 'm'),
    unitPrice: text,
    vatable: fc.boolean(),
    serviceEndDate: fc.constantFrom('', '2570-01-31'),
  }) satisfies fc.Arbitrary<FormLine>

  it('[FR-INT-004/AC1] the preview is asked about the lines the workspace would save, with the same plain numbers', () => {
    fc.assert(
      fc.property(fc.array(line, { maxLength: 6 }), (lines) => {
        const expected = lines.filter(savableLine).map((l) => ({ quantity: plainNumber(l.quantity), unitPrice: plainNumber(l.unitPrice), vatable: l.vatable }))
        expect(previewLinesOf({ lines })).toEqual(expected)
      }),
      { numRuns: 500 },
    )
  })

  it('[§9.4] a form opens with the same lines as the workspace’s: a draft’s own, a returned request’s with what they hold, or one empty line', () => {
    const draftLine = fc.record({
      id: fc.uuid(),
      reserved: fc.option(fc.constantFrom('0.00', '0.01', '1500.00').map((amount) => ({ amount, currency: 'THB' as const })), { nil: null }),
      description: fc.constantFrom('', 'ไม้อัด'),
      quantity: text,
      uom: fc.constantFrom('', 'แผ่น'),
      unitPrice: text,
      vatable: fc.boolean(),
      serviceEndDate: fc.option(fc.constantFrom('2570-01-31'), { nil: null }),
    })
    fc.assert(
      fc.property(fc.option(fc.array(draftLine, { maxLength: 4 }), { nil: null }), fc.boolean(), fc.constantFrom('DRAFT', 'RETURNED') as fc.Arbitrary<'DRAFT' | 'RETURNED'>, (lines, purchase, status) => {
        const form = itForm(lines === null ? null : serverDraft(lines, status))
        const data: RequestFormData = purchase ? form : { ...form, type: { ...form.type, documentType: 'SUPPLIER_REQUEST' } }
        expect(openingLines(data)).toEqual(initialValues(data).lines)
        expect(openingOf(data)).toEqual(initialValues(data))
      }),
      { numRuns: 300 },
    )
  })
})

describe('[NFR-A11Y-03] the LIFF form’s fields: the same questions and words, an icon and words for every error', () => {
  it('[NFR-A11Y-03] a yes/no question is a row of radio buttons under its question; a refused answer is words with an icon, tied to the question', () => {
    const page = html(<LiffField def={FIELDS[2]!} value="N" onChange={() => undefined} locale="th" error="ตอบข้อนี้ก่อนส่ง" />)
    expect(page).toMatch(/<fieldset[^>]*aria-describedby="field-processesPersonalData-error"/)
    expect(page).toContain('<legend')
    expect(page).toContain('ผู้ขายจะประมวลผลข้อมูลส่วนบุคคลแทนบริษัทหรือไม่')
    expect(page).toContain('(จำเป็น)')
    expect(page.match(/type="radio"/g)).toHaveLength(2)
    expect(page).toMatch(/<input type="radio"[^>]*name="processesPersonalData"[^>]*checked=""[^>]*value="N"/)
    expect(page).toMatch(/<p id="field-processesPersonalData-error"[^>]*><svg[^>]*aria-hidden="true"[^>]*>.*<\/svg><span>ตอบข้อนี้ก่อนส่ง<\/span><\/p>/)
  })

  it('[NFR-A11Y-03] a text question carries its hint, tied to it, and no error until there is one', () => {
    const page = html(<LiffField def={FIELDS[1]!} value="" onChange={() => undefined} locale="th" />)
    expect(page).toMatch(/<label for="field-assetTag"[^>]*>เลขทะเบียนทรัพย์สิน/)
    expect(page).toMatch(/<input[^>]*id="field-assetTag"[^>]*aria-describedby="field-assetTag-hint"/)
    expect(page).toContain('<p id="field-assetTag-hint" class="text-ink-muted">ถ้าทราบแล้ว</p>')
    expect(page).not.toContain('-error')
  })
})

describe('[FR-INT-004/AC1] the first step of the LIFF form shows the budget line it opened with and what is left on it', () => {
  const props = (budget: BudgetView | null) => {
    const data = itForm()
    const start = liffFormStart(data)
    return { data, values: openingOf(data), update: () => undefined, locale: 'th' as const, visible: new Set(start.visible), showErrors: false, budget, previewLoading: false, fieldErrors: {}, titleMax: start.titleMax }
  }

  it('[FR-INT-004/AC1] the line, the department that pays and what is left on it, for that line only', () => {
    const page = html(
      <LiffDetailsStep {...props({ kind: 'LINE', budgetLineId: LINE.id, available: { amount: '25000.00', currency: 'THB' }, need: { amount: '0.00', currency: 'THB' }, enough: true, shortfall: { amount: '0.00', currency: 'THB' } } as BudgetView)} />,
    )
    expect(page).toMatch(/<option value="00000000-0000-4000-8000-000000000001" selected="">IT-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที<\/option>/)
    expect(page).toContain('ฝ่ายไอที')
    expect(page).toContain('งบคงเหลือของบรรทัดนี้')
    expect(page).toContain('25,000.00 บาท')
    // The title is the first thing asked, required, with the service's limit
    expect(page).toMatch(/<input id="request-title"[^>]*maxLength="200"/)
  })

  it('[FR-INT-004/AC1] a line the requester may no longer use says so instead of an amount', () => {
    const page = html(<LiffDetailsStep {...props({ kind: 'NOT_USABLE' })} />)
    expect(page).toContain('ใช้บรรทัดนี้ไม่ได้ เลือกบรรทัดอื่น')
    expect(page).not.toContain('บาท</span>')
  })
})

describe('[FR-INT-001/AC1] [FR-INT-008/AC2] the catalogue and the list of LIFF', () => {
  it('[FR-INT-001/AC1] every request type is one tap target that says when to use it and opens its LIFF form', () => {
    const page = html(
      <LiffCatalog
        types={[
          { code: 'BUY_GOODS', name: 'ซื้อของ', description: 'วัสดุ อุปกรณ์ สินค้าทั่วไป', documentType: 'PURCHASE_REQUEST' },
          { code: 'NEW_SUPPLIER', name: 'ขอเพิ่มผู้ขายรายใหม่', description: null, documentType: 'SUPPLIER_REQUEST' },
        ]}
        formBase="/liff/requests/new"
      />,
    )
    expect(page).toMatch(/<a href="\/liff\/requests\/new\/BUY_GOODS" class="[^"]*min-h-11[^"]*">.*ซื้อของ.*ใช้เมื่อ: วัสดุ อุปกรณ์ สินค้าทั่วไป.*เริ่มคำขอ ซื้อของ.*<\/a>/)
    expect(page).toContain('ประเภทนี้ยังไม่มีคำอธิบายว่าใช้เมื่อไร')
    expect(page).toContain('ประเภทคำขอที่เปิดใช้ 2 ประเภท')
    // A card is a plain border, no shadow (§9.9)
    expect(page).not.toContain('shadow')
  })

  it('[FR-INT-008/AC2] a request’s row: its LIFF page, its status as an icon and words, whom it waits for, its total as money', () => {
    const page = html(
      <LiffTrackList
        rows={[
          {
            id: 'r1',
            href: '/liff/requests/r1',
            title: 'PR-2569-00012 · ไม้อัดและตะปู',
            meta: ['ส่งเมื่อ 4 ต.ค. 2569'],
            status: 'PENDING_APPROVAL',
            statusLabel: 'รออนุมัติ',
            now: 'รอ วีระ ปฏิบัติการ (รองประธานสายงาน สายปฏิบัติการ) อนุมัติ',
            nowStates: [{ kind: 'waiting', text: 'ค้างมา 2 ชั่วโมงทำการ' }],
            amount: '44,940.00',
            amountIsMoney: true,
          },
        ]}
        labels={{ list: 'คำขอของฉัน', status: 'สถานะ', now: 'ตอนนี้อยู่ที่', amount: 'ยอดรวม VAT (บาท)', unit: 'บาท' }}
      />,
    )
    expect(page).toMatch(/<ul aria-label="คำขอของฉัน"/)
    expect(page).toMatch(/<a href="\/liff\/requests\/r1" class="[^"]*min-h-11[^"]*">PR-2569-00012 · ไม้อัดและตะปู<\/a>/)
    expect(page).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*<\/svg><span>รออนุมัติ<\/span>/)
    expect(page).toContain('รอ วีระ ปฏิบัติการ (รองประธานสายงาน สายปฏิบัติการ) อนุมัติ')
    expect(page).toContain('ค้างมา 2 ชั่วโมงทำการ')
    expect(page).toMatch(/<span class="money[^"]*">44,940.00<span class="sr-only"> บาท<\/span><\/span>/)
  })
})

describe('[FR-PLT-002/AC3] a date question of the LIFF form reads with the same Buddhist-era words as the workspace’s form', () => {
  /** "YYYY-MM-DD" of a day counted from 1 January 1970 */
  const dayOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10)

  it('[FR-PLT-002/AC3] every day from 1990 to 2060, and random days of ten centuries, in Thai and in English', () => {
    for (let n = Date.UTC(1990, 0, 1) / 86_400_000; n <= Date.UTC(2060, 11, 31) / 86_400_000; n++) {
      const day = dayOf(n)
      expect(formatThaiDay(day)).toBe(formatThaiDate(day))
      expect(formatEnglishBeDay(day)).toBe(formatEnglishBeDate(day))
    }
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(1000, 0, 1) / 86_400_000, max: Date.UTC(9999, 11, 31) / 86_400_000 }), (n) => {
        const day = dayOf(n)
        return formatThaiDay(day) === formatThaiDate(day) && formatEnglishBeDay(day) === formatEnglishBeDate(day)
      }),
    )
    expect(formatThaiDay('2027-10-31')).toBe('31 ต.ค. 2570')
    expect(formatEnglishBeDay('2027-10-31')).toBe('31 Oct 2570')
  })

  it('[FR-PLT-002/AC3] what is not a day of the calendar has no words', () => {
    for (const day of ['', '2027-02-29', '2027-04-31', '2027-13-01', '2027-00-10', '27-10-31', '2027-10-31T00:00:00Z']) {
      expect(formatThaiDay(day)).toBeNull()
      expect(formatEnglishBeDay(day)).toBeNull()
    }
    expect(formatThaiDay('2028-02-29')).toBe('29 ก.พ. 2571')
  })

  it('[FR-PLT-002/AC3] the chosen day shows under the date question in the reader’s language', () => {
    const def: FieldDef = { id: 'neededBy', type: 'date', label: { th: 'ต้องการใช้วันที่', en: 'Needed by' } }
    expect(html(<LiffField def={def} value="2027-10-31" onChange={() => undefined} locale="th" />)).toContain('วันที่เลือก: 31 ต.ค. 2570')
    const english = html(<LiffField def={def} value="2027-10-31" onChange={() => undefined} locale="en" />, 'en')
    expect(english).toContain('31 Oct 2570')
    expect(english).not.toContain('BE')
  })
})

describe('[FR-INT-006/AC1] a save made as the page goes away before the engine arrived carries what the engine would save', () => {
  const apply = (values: FormValues, actions: readonly FormAction[]) => actions.reduce((v, a) => formReducer(v, a), values)
  const STEP_ONE: readonly FormAction[] = [
    { type: 'title', value: '  เซิร์ฟเวอร์สำรองข้อมูล  ' },
    { type: 'field', id: 'category', value: 'HARDWARE' },
    { type: 'field', id: 'assetTag', value: 'IT-0042' },
  ]

  it('[FR-INT-006/AC1] a new form: the step-1 parts with the same values as the workspace’s first save, the site the form opened with included', () => {
    const data = itForm()
    const values = apply(openingOf(data), STEP_ONE)
    const early = earlyDraft(values, data.type.name, true, 200)
    const full = draftPayload(values, data.type.name, true).draft as unknown as Record<string, unknown>
    expect(early).toEqual({ title: 'เซิร์ฟเวอร์สำรองข้อมูล', budgetLineId: LINE.id, deliverySiteId: SITE.id, priceIncludesVat: false, formData: { category: 'HARDWARE', assetTag: 'IT-0042' } })
    for (const [key, value] of Object.entries(early)) expect(full[key], key).toEqual(value)
    // Without a title the draft takes the type's name, as the workspace's first save does
    expect(earlyDraft(openingOf(data), data.type.name, true, 200).title).toBe(data.type.name)
  })

  it('[FR-INT-006/AC1] a saved draft: only what step 1 changes, a cleared budget line as null, nothing about its lines', () => {
    const data = itForm({
      requestId: '00000000-0000-4000-8000-000000000003',
      version: 2,
      status: 'DRAFT',
      title: 'เซิร์ฟเวอร์',
      budgetLineId: LINE.id,
      priceIncludesVat: false,
      formData: { category: 'SOFTWARE' },
      lines: [{ id: '00000000-0000-4000-8000-000000000004', reserved: null, description: 'เซิร์ฟเวอร์', quantity: '1', uom: 'เครื่อง', unitPrice: '60,000.00', vatable: true, serviceEndDate: null }],
      quotations: [],
      nonLowestQuoteReason: '',
      attachments: [],
      returnReason: null,
      deliverySiteId: SITE.id,
      suggestedSupplierId: null,
    })
    const values = apply(openingOf(data), [...STEP_ONE, { type: 'budgetLine', value: '' }])
    const early = earlyDraft(values, data.type.name, false, 200)
    const full = draftPayload(values, data.type.name, false).draft as unknown as Record<string, unknown>
    expect(early).toEqual({ title: 'เซิร์ฟเวอร์สำรองข้อมูล', budgetLineId: null, priceIncludesVat: false, formData: { category: 'HARDWARE', assetTag: 'IT-0042' } })
    for (const [key, value] of Object.entries(early)) expect(full[key], key).toEqual(value)
    expect(early).not.toHaveProperty('lines')
    expect(early).not.toHaveProperty('deliverySiteId')
  })
})

describe('[§9.9] [§9.4] what the requester does on their request in LIFF: the main button at the bottom of the screen', () => {
  const actions: LiffRequesterProps['actions'] = { answer: async () => ({ ok: true }) }
  const base: LiffRequesterProps = { requestId: 'r1', question: null, returned: null, draft: false, editHref: null, actions }
  const screen = (props: Partial<LiffRequesterProps>) =>
    inLiff(
      <LiffRequesterScreen {...base} {...props} header={<h2>ไม้อัดและตะปู</h2>}>
        <p>ไทม์ไลน์</p>
      </LiffRequesterScreen>,
    )

  it('[§9.9] a question: the question and the answer field under the heading, the send button in the bar, tied to the answer’s form', () => {
    const page = screen({ question: { infoRequestId: 'i1', text: 'ขอใบเสนอราคาอีกราย', askedLine: 'วีระ ปฏิบัติการ ถามเมื่อ 4 ต.ค. 2569 10:00 น.' } })
    expect(page).toMatch(/<section aria-labelledby="[^"]+-title"[^>]*><h2 id="[^"]+-title"[^>]*>สิ่งที่ต้องทำ<\/h2>/)
    expect(page).toContain('ขอใบเสนอราคาอีกราย')
    expect(page).toMatch(/<label for="[^"]+-answer"[^>]*>คำตอบของคุณ/)
    const form = /<form id="([^"]+)"/.exec(page)?.[1]
    expect(form).toBeTruthy()
    // The bar comes after the content column, as a labelled region, with the one main action
    expect(page.indexOf('<section aria-label="สิ่งที่ทำได้กับคำขอนี้"')).toBeGreaterThan(page.indexOf('ไทม์ไลน์'))
    expect(page).toMatch(new RegExp(`<button type="submit"[^>]*form="${form}"[^>]*>ส่งคำตอบให้ผู้อนุมัติ</button>`))
  })

  it('[§9.9] a returned request: the reason under the heading; in the bar one main action, the form whose last step shows the budget, the new route and the documents before it sends it again — nothing here sends it at once', () => {
    const page = screen({ returned: { reason: 'แยกรายการตามความหนา' }, editHref: '/liff/requests/r1/edit' })
    expect(page).toContain('ผู้อนุมัติตีกลับให้แก้ไข')
    expect(page).toContain('เหตุผล: แยกรายการตามความหนา')
    expect(page).toContain('กด แก้ไขคำขอ แล้วตรวจงบคงเหลือ เส้นทางอนุมัติใหม่ และเอกสารที่ต้องแนบในขั้นตรวจและส่ง ก่อนกด ส่งขออนุมัติอีกครั้ง')
    const bar = page.slice(page.indexOf('<section aria-label="สิ่งที่ทำได้กับคำขอนี้"'))
    expect(bar).toMatch(/<a href="\/liff\/requests\/r1\/edit" class="[^"]*bg-primary[^"]*"[^>]*>แก้ไขคำขอ<\/a>/)
    expect(bar).not.toContain('<button')
    expect(page).not.toMatch(/>ส่งขออนุมัติอีกครั้ง</)
  })

  it('[§9.4] a draft: the way back to the form is the main button', () => {
    const draft = screen({ draft: true, editHref: '/liff/requests/r1/edit' })
    expect(draft).toContain('คำขอนี้ยังเป็นร่าง')
    expect(draft).toMatch(/<a href="\/liff\/requests\/r1\/edit" class="[^"]*bg-primary[^"]*min-h-11|<a href="\/liff\/requests\/r1\/edit" class="[^"]*min-h-11[^"]*bg-primary/)
  })

  it('[§9.9] with nothing to do — a request cancelled or answered while the page was open — neither "สิ่งที่ต้องทำ" nor a bar shows', () => {
    // The page keeps this box once it was shown, so its confirmations stay; with none held and nothing to do, nothing of it
    // is left on the screen: no empty heading over a cancelled request
    for (const props of [{}, { draft: true, editHref: null }, { returned: null }]) {
      const page = screen(props)
      expect(page).not.toContain('สิ่งที่ต้องทำ')
      expect(page).not.toContain('<section')
      expect(page).not.toContain('aria-label="สิ่งที่ทำได้กับคำขอนี้"')
      // The request itself is all there is
      expect(page).toContain('ไม้อัดและตะปู')
      expect(page).toContain('ไทม์ไลน์')
    }
  })
})

describe('[FR-INT-005/AC3] [§9.4] the camera of the LIFF request form', () => {
  it('[FR-INT-005/AC3] opens the phone’s back camera (accept image/*, capture environment), behind a 44 px label that says what it does', () => {
    const page = inLiff(
      <LiffCameraAttach
        taken={[]}
        busy={false}
        ready={async () => 'go'}
        requestUpload={async () => ({ ok: false, reason: 'FAILED' })}
        completeUpload={async () => ({ ok: false, reason: 'FAILED' })}
        onAttach={async () => true}
      />,
    )
    expect(page).toMatch(/<label for="([^"]+)" class="[^"]*min-h-11[^"]*">.*แนบรูปถ่าย<input id="\1" type="file" accept="image\/\*" capture="environment" class="sr-only"/)
    expect(page).toContain('รูปจะถูกย่อในเครื่องก่อนส่ง')
    // Words true on both kinds of device (§9.9 rule 7): a computer ignores capture and opens a file chooser
    expect(page).toContain('บนโทรศัพท์จะเปิดกล้อง บนคอมพิวเตอร์ให้เลือกไฟล์รูป')
    expect(page).not.toContain('ถ่ายรูปแนบคำขอ')
    // The camera icon is decoration: the words name the control
    expect(page).toMatch(/<svg[^>]*aria-hidden="true"/)
  })
})

/** The LIFF autosave route as the early saver sees it: every request waits until the test answers it, drops it or the time limit aborts it */
function fakeAutosaveRoute() {
  interface Call {
    readonly body: { idempotencyKey: string; requestId: string | null; requestTypeCode: string; expectedVersion: number | null; draft: Record<string, unknown> }
    readonly keepalive: boolean | undefined
    readonly signal: AbortSignal
    readonly answer: (json: unknown) => void
    readonly drop: () => void
  }
  const calls: Call[] = []
  const fetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal!
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')))
      calls.push({
        body: JSON.parse(String(init.body)) as Call['body'],
        keepalive: init.keepalive,
        signal,
        answer: (json) => resolve(Response.json(json)),
        drop: () => reject(new TypeError('Failed to fetch')),
      })
    })
  return { calls, fetch }
}

describe('[FR-INT-006/AC1] the early save of the LIFF form: one at a time, an unanswered one again with its key, a leave in between not lost', () => {
  const DRAFT = '00000000-0000-4000-8000-000000000009'
  const valuesWith = (title: string) => ({ ...openingOf(itForm()), title })

  function saverOf(base: EarlyBase = { requestId: null, version: null }) {
    const route = fakeAutosaveRoute()
    let values = valuesWith('เซิร์ฟเวอร์สำรองข้อมูล')
    const seen: Array<{ state: EarlyState; created: boolean }> = []
    const saver = createEarlySaver({
      url: '/liff/requests/new/autosave',
      requestTypeCode: 'IT_PURCHASE',
      typeName: 'ซื้ออุปกรณ์/ซอฟต์แวร์ไอที',
      titleMax: 200,
      base,
      values: () => values,
      onState: (state, created) => seen.push({ state, created }),
      fetch: route.fetch,
    })
    const edit = (title: string) => {
      values = valuesWith(title)
      saver.changed()
    }
    return { route, saver, seen, edit }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('[FR-INT-006/AC1] a save whose answer was lost goes again as it was, with its key, so the draft is made once; the next save is based on it', async () => {
    const { route, saver, seen, edit } = saverOf()
    // Nothing typed: nothing is sent
    saver.save()
    expect(route.calls).toHaveLength(0)

    edit('เซิร์ฟเวอร์สำรองข้อมูล')
    saver.save()
    expect(route.calls).toHaveLength(1)
    const first = route.calls[0]!
    expect(first.keepalive).toBe(true)
    expect(first.body).toMatchObject({ requestId: null, requestTypeCode: 'IT_PURCHASE', expectedVersion: null, draft: { title: 'เซิร์ฟเวอร์สำรองข้อมูล' } })
    expect(z.uuid().safeParse(first.body.idempotencyKey).success).toBe(true)
    expect(saver.state()).toMatchObject({ saving: true, unanswered: false })

    // The connection drops before the answer: the save may or may not have reached the server
    first.drop()
    await vi.waitFor(() => expect(saver.state()).toMatchObject({ saving: false, unanswered: true, unsaved: true }))
    edit('เซิร์ฟเวอร์สำรองข้อมูล 2 เครื่อง')
    saver.save()
    // The same request again, key included: had it reached the server, the server answers it again (one draft)
    expect(route.calls[1]!.body).toEqual(first.body)
    route.calls[1]!.answer({ ok: true, requestId: DRAFT, version: 0, lineIds: [] })
    await vi.waitFor(() => expect(saver.state()).toEqual({ saving: false, unanswered: false, unsaved: true, base: { requestId: DRAFT, version: 0 } }))
    // That answer made the draft (the page takes the draft's address)
    expect(seen.filter((s) => s.created)).toHaveLength(1)

    // What was typed since goes next, based on the draft and version it made, as a new submission
    saver.save()
    const third = route.calls[2]!
    expect(third.body).toMatchObject({ requestId: DRAFT, expectedVersion: 0, draft: { title: 'เซิร์ฟเวอร์สำรองข้อมูล 2 เครื่อง' } })
    expect(third.body.idempotencyKey).not.toBe(first.body.idempotencyKey)
    third.answer({ ok: true, requestId: DRAFT, version: 1, lineIds: [] })
    await vi.waitFor(() => expect(saver.state()).toEqual({ saving: false, unanswered: false, unsaved: false, base: { requestId: DRAFT, version: 1 } }))
    expect(seen.filter((s) => s.created)).toHaveLength(1)
  })

  it('[FR-INT-006/AC1] a leave while a save runs is not lost: once that save has its answer, what changed since goes, based on it', async () => {
    const { route, saver, edit } = saverOf({ requestId: DRAFT, version: 4 })
    edit('ไม้อัด')
    saver.save()
    // Back to the chat and into the form again, more typed, and gone again while the first save is on its way
    edit('ไม้อัดและตะปู')
    saver.save()
    expect(route.calls).toHaveLength(1)
    route.calls[0]!.answer({ ok: true, requestId: DRAFT, version: 5, lineIds: [] })
    await vi.waitFor(() => expect(route.calls).toHaveLength(2))
    expect(route.calls[1]!.body).toMatchObject({ requestId: DRAFT, expectedVersion: 5, draft: { title: 'ไม้อัดและตะปู' } })
    route.calls[1]!.answer({ ok: true, requestId: DRAFT, version: 6, lineIds: [] })
    await vi.waitFor(() => expect(saver.state()).toEqual({ saving: false, unanswered: false, unsaved: false, base: { requestId: DRAFT, version: 6 } }))
    // Nothing new: nothing more is sent
    saver.save()
    expect(route.calls).toHaveLength(2)
  })

  it('[FR-INT-006/AC1] a save with no answer within the time limit is given up, counted unanswered, and goes again later with its key', async () => {
    vi.useFakeTimers()
    const { route, saver, edit } = saverOf()
    edit('ไม้อัด')
    saver.save()
    const first = route.calls[0]!
    await vi.advanceTimersByTimeAsync(EARLY_SAVE_TIMEOUT_MS - 1)
    expect(first.signal.aborted).toBe(false)
    expect(saver.state().saving).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(first.signal.aborted).toBe(true)
    await vi.waitFor(() => expect(saver.state()).toMatchObject({ saving: false, unanswered: true }))
    // The engine's autosave waits for it (the form's shell): the next try is the same request
    saver.save()
    expect(route.calls[1]!.body).toEqual(first.body)
  })

  it('[FR-INT-006/AC1] a refusal is an answer: nothing is sent again by itself, and the edits stay unsaved for the engine’s autosave, which says why', async () => {
    const { route, saver, edit } = saverOf({ requestId: DRAFT, version: 2 })
    edit('ไม้อัด')
    saver.save()
    route.calls[0]!.answer({ ok: false, code: 'CONFLICT_VERSION', current: 3 })
    await vi.waitFor(() => expect(saver.state()).toEqual({ saving: false, unanswered: false, unsaved: true, base: { requestId: DRAFT, version: 2 } }))
    expect(route.calls).toHaveLength(1)
  })
})

describe('[§4.3] the idempotency keys of the LIFF request pages are uuids, also where crypto.randomUUID is missing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('[§4.3] an older LINE WebView without randomUUID still gets version-4 uuids, which the server actions and the autosave route accept', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(array: T) => real.getRandomValues(array as unknown as Uint8Array) as unknown as T })
    expect(typeof globalThis.crypto.randomUUID).toBe('undefined')
    const keys = Array.from({ length: 200 }, () => newUuid())
    for (const key of keys) {
      expect(z.uuid().safeParse(key).success, key).toBe(true)
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('[FR-LINE-003/AC1] a file of the LIFF form opens through LINE inside the LINE app, and in a window of its own elsewhere', () => {
  it('[FR-LINE-003/AC1] in the LINE app the short-lived address comes first and LINE opens it; the page opens no window', async () => {
    const throughLine: string[] = []
    const open = vi.fn(() => null)
    expect(await openFileWith({ line: (href) => throughLine.push(href), open }, async () => 'https://files.example/q.pdf?sig=1')).toBe(true)
    expect(throughLine).toEqual(['https://files.example/q.pdf?sig=1'])
    expect(open).not.toHaveBeenCalled()
    // No address (no right to the file, or the session ended): nothing opens, and the form says so
    expect(await openFileWith({ line: (href) => throughLine.push(href), open }, async () => null)).toBe(false)
    expect(throughLine).toHaveLength(1)
  })

  it('[FR-LINE-003/AC1] in a browser the window opens with the tap, without a way back to the page, and gets the address once it is there', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    expect(await openFileWith({ line: null, open: () => tab as unknown as Window }, async () => 'https://files.example/p.jpg?sig=2')).toBe(true)
    expect(tab.opener).toBeNull()
    expect(tab.location.href).toBe('https://files.example/p.jpg?sig=2')
    expect(tab.close).not.toHaveBeenCalled()
    const refused = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    expect(await openFileWith({ line: null, open: () => refused as unknown as Window }, async () => null)).toBe(false)
    expect(refused.close).toHaveBeenCalledOnce()
    // A window the browser blocked: nothing to close, not opened
    expect(await openFileWith({ line: null, open: () => null }, async () => 'https://files.example/p.jpg?sig=3')).toBe(false)
  })
})

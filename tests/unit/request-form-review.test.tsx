import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiffProvider } from '@/ui/liff/liff-provider'
import { LiffReviewStep, type LiffReviewProps } from '@/ui/liff/requests/review-step'
import type { StepProps } from '@/ui/request-form/details-items'
import { formInput, initialValues, totalsOf, type FormValues } from '@/ui/request-form/model'
import { ReviewStep, type ReviewProps, type SendBlock } from '@/ui/request-form/review-step'
import type { BudgetView, RequestFormData } from '@/ui/request-form/types'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-INT-004 AC2 · §9.9 principle 3 (told before sending, one message): on the last step of the request form,
// "ตรวจก่อนส่ง" says the request can be sent — "ข้อมูลที่ตรวจได้บนหน้านี้ครบแล้ว กดส่งได้" — only when nothing stops the send
// button. Over budget the button cannot send and says why and by how much, and "ตรวจก่อนส่ง" leads with the same: what is
// left on the line and what the request lacks, with the button's advice, marked as a point to fix before sending; saving
// stopped, what stopped it in words of its own (the button's sentence is on the page once, beside the button), and a
// request sent or cancelled elsewhere is never told to load the latest version (nor, on the workspace's form, by its
// button, which gives the same reason). Both forms: the workspace's review step,
// which holds its button, and the LIFF one, whose button sits in the bar at the bottom and whose shell hands it what
// stops that button (src/ui/liff/requests/request-form.tsx). Static markup; the forms in a browser run in
// tests/e2e/request-form.spec.ts, tests/e2e/liff-requests.spec.ts and demo scene 4 (tests/e2e/demo/04-budget-blocks.spec.ts).
// Over budget with nothing else to fix — the case where the ready line used to show beside a button that could not send
// — is reached in a browser by demo scene 4 only (LIFF). The over-budget tests of the two specs ask for 963,000.00 baht
// with VAT (web) and for what the run left on the line and 35,000.00 more (LIFF), which the runs so far put above
// 100,000.00 baht with VAT, where the quotation rule (ATT-QUOTES) is listed too. For the workspace's form, these tests are
// that case.

type Locale = 'th' | 'en'

const html = (node: ReactNode, locale: Locale) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** The words of some markup, without its tags */
const words = (markup: string) => markup.replace(/<[^>]+>/g, '')

/** "ตรวจก่อนส่ง": its section of the step, to the end of it */
function beforeSending(page: string): string {
  const start = page.indexOf('<section aria-labelledby="review-problems"')
  expect(start, 'the step has its "ตรวจก่อนส่ง"').toBeGreaterThanOrEqual(0)
  return page.slice(start, page.indexOf('</section>', start) + '</section>'.length)
}

const timesIn = (text: string, part: string) => text.split(part).length - 1

const READY = { th: th.requestForm.review.ready, en: en.requestForm.review.ready }

const LINE = { id: '00000000-0000-4000-8000-000000000001', code: 'IT-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที', departmentId: 'd-it', departmentName: 'ฝ่ายไอที', costCenterCode: 'CC-IT', costCenterName: 'ศูนย์ต้นทุนฝ่ายไอที', granted: false }

const DATA: RequestFormData = {
  type: { code: 'IT_PURCHASE', name: 'ซื้ออุปกรณ์/ซอฟต์แวร์ไอที', description: null, documentType: 'PURCHASE_REQUEST' },
  form: { fields: [], visibility: [], rules: [], lines: {} },
  requesterDepartmentName: 'ฝ่ายไอที',
  budgetLines: [LINE],
  defaultBudgetLineId: LINE.id,
  vatRateBp: 700,
  attachmentKinds: ['OTHER'],
  draft: null,
}

/** A backup server of 60,000.00 before VAT on the line, as in demo scene 4 */
const VALUES: FormValues = {
  ...initialValues(DATA),
  title: 'เซิร์ฟเวอร์สำรองข้อมูล',
  lines: [{ key: 'line-0', id: null, reserved: null, description: 'เซิร์ฟเวอร์สำรองข้อมูล', quantity: '1', uom: 'เครื่อง', unitPrice: '60000.00', vatable: true, serviceEndDate: '' }],
}
const TOTALS = totalsOf(VALUES, DATA.vatRateBp)

const baht = (amount: string) => ({ amount, currency: 'THB' as const })
/** What the server says is left on the line: 80,000.00, enough for 60,000.00 before VAT */
const ENOUGH: BudgetView = { kind: 'LINE', budgetLineId: LINE.id, available: baht('80000.00'), need: baht('60000.00'), enough: true, shortfall: baht('0.00') }
/** 25,000.00 left: 35,000.00 short of 60,000.00 before VAT (BR-BUD-03) */
const SHORT: BudgetView = { kind: 'LINE', budgetLineId: LINE.id, available: baht('25000.00'), need: baht('60000.00'), enough: false, shortfall: baht('35000.00') }

const stepProps = (budget: BudgetView | null, locale: Locale): StepProps => ({
  data: DATA,
  values: VALUES,
  update: () => undefined,
  locale,
  input: formInput(VALUES, [], TOTALS, DATA.type.code),
  visible: new Set<string>(),
  totals: TOTALS,
  showErrors: true,
  budget,
  previewLoading: false,
  fieldErrors: {},
})

/** The workspace's step 4 with its send button */
const web = (budget: BudgetView | null, more: Partial<ReviewProps> = {}, locale: Locale = 'th') =>
  html(
    <ReviewStep
      {...stepProps(budget, locale)}
      rules={[]}
      problems={[]}
      route={null}
      attachmentCount={0}
      onGoTo={() => undefined}
      onSubmit={() => undefined}
      onReload={() => undefined}
      submitting={false}
      submitError={null}
      saveStop={null}
      {...more}
    />,
    locale,
  )

const FILES: LiffReviewProps['files'] = {
  attachments: [],
  setAttachments: () => undefined,
  draftId: async () => null,
  requestId: null,
  actions: {
    requestUpload: async () => ({ ok: false, reason: 'FAILED' }),
    completeUpload: async () => ({ ok: false, reason: 'FAILED' }),
    attach: async () => ({ ok: true }),
    detach: async () => ({ ok: true }),
    downloadUrl: async () => null,
  },
  ready: async () => 'go',
  saveBlocked: false,
}

/** The block the LIFF form's shell works out over budget: 25,000.00 left, 35,000.00 short */
const BUDGET_BLOCK: SendBlock = { kind: 'BUDGET', available: 2_500_000n, shortfall: 3_500_000n }

/** The LIFF form's step 3, told by its shell what stops the button in the bar */
const liff = (sendBlock: SendBlock | null, more: Partial<LiffReviewProps> = {}, locale: Locale = 'th') =>
  html(
    <LiffProvider config={{ liffId: null, mock: null, session: 'liff' }}>
      <LiffReviewStep
        {...stepProps(sendBlock?.kind === 'BUDGET' ? SHORT : ENOUGH, locale)}
        rules={[]}
        nets={{}}
        lowest={[]}
        problems={[]}
        route={null}
        onGoTo={() => undefined}
        sendBlock={sendBlock}
        submitError={null}
        onReload={() => undefined}
        files={FILES}
        {...more}
      />
    </LiffProvider>,
    locale,
  )

describe('[§9.9] the workspace’s check and send: "ตรวจก่อนส่ง" says the request can be sent only when its button can send', () => {
  it('[FR-INT-004/AC2] enough budget and nothing to fix: it says the request can be sent, and the button can send', () => {
    const page = web(ENOUGH)
    expect(words(beforeSending(page))).toContain(READY.th)
    expect(page).not.toContain('id="submit-blocked"')
    const send = /<button[^>]*>ส่งขออนุมัติ<\/button>/.exec(page)?.[0]
    expect(send).toBeDefined()
    expect(send).not.toContain('disabled=""')
  })

  it('[FR-INT-004/AC2] over budget: it leads with what is left and what is lacking, as the button does, and never says the request can be sent', () => {
    const page = web(SHORT)
    const section = words(beforeSending(page))
    expect(section).not.toContain(READY.th)
    expect(section).toContain('งบไม่พอ: คงเหลือ 25,000.00 บาท ขาด 35,000.00 บาท ลดยอดหรือเลือกบรรทัดงบอื่น (ต้องแก้ก่อนส่ง)')
    // The button cannot send and says why beside it; its sentence is on the page once, there
    const send = /<button[^>]*>ส่งขออนุมัติ<\/button>/.exec(page)?.[0]
    expect(send).toContain('disabled=""')
    expect(send).toContain('aria-describedby="submit-blocked"')
    expect(timesIn(words(page), 'ส่งไม่ได้เพราะงบไม่พอ: คงเหลือ 25,000.00 บาท ขาด 35,000.00 บาท ลดยอดหรือเลือกบรรทัดงบอื่น')).toBe(1)
    expect(section).not.toContain('ส่งไม่ได้เพราะงบไม่พอ')
  })

  it('[FR-INT-004/AC2] over budget with something else to fix: the budget first, the reason the button names, then the rest', () => {
    const section = words(beforeSending(web(SHORT, { problems: [{ kind: 'ATTACHMENTS', ruleId: 'ATT-QUOTE' }] })))
    const budget = section.indexOf('งบไม่พอ: คงเหลือ 25,000.00 บาท ขาด 35,000.00 บาท')
    expect(budget).toBeGreaterThan(-1)
    expect(budget).toBeLessThan(section.indexOf('เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTE'))
    expect(section).not.toContain(READY.th)
  })

  it('[FR-INT-004/AC2] the line the requester chose has room: a balance the server sent for another line stops nothing', () => {
    const page = web({ ...SHORT, budgetLineId: '00000000-0000-4000-8000-000000000009' })
    expect(words(beforeSending(page))).toContain(READY.th)
    expect(page).not.toContain('id="submit-blocked"')
  })

  it('[FR-INT-006/AC2] saving stopped (the draft was changed elsewhere): it says to load the latest version first, in words of its own, not that the request can be sent', () => {
    const page = web(ENOUGH, { saveStop: 'conflict' })
    const section = words(beforeSending(page))
    expect(section).not.toContain(READY.th)
    expect(section).toContain('ร่างนี้ถูกแก้จากที่อื่น โหลดฉบับล่าสุดแล้วตรวจอีกครั้งก่อนส่ง')
    // The button cannot send and says why beside it; its sentence is on the page once, there
    const send = /<button[^>]*>ส่งขออนุมัติ<\/button>/.exec(page)?.[0]
    expect(send).toContain('disabled=""')
    expect(send).toContain('aria-describedby="submit-blocked"')
    expect(timesIn(words(page), 'ส่งไม่ได้จนกว่าจะโหลดร่างฉบับล่าสุด')).toBe(1)
    expect(section).not.toContain('ส่งไม่ได้จนกว่าจะโหลดร่างฉบับล่าสุด')
  })

  it('[§9.9] saving stopped (the request was sent or cancelled elsewhere): it says so, never to load the latest version, nor that the request can be sent', () => {
    const page = web(ENOUGH, { saveStop: 'closed' })
    const section = words(beforeSending(page))
    expect(section).not.toContain(READY.th)
    expect(section).toContain('คำขอนี้ส่งหรือยกเลิกจากที่อื่นไปแล้ว จึงส่งจากหน้านี้ไม่ได้')
    expect(section).not.toContain('โหลด')
    // The button cannot send and says the same beside it, once on the page: loading the latest version would not help
    const send = /<button[^>]*>ส่งขออนุมัติ<\/button>/.exec(page)?.[0]
    expect(send).toContain('disabled=""')
    expect(send).toContain('aria-describedby="submit-blocked"')
    expect(words(/<[^>]*id="submit-blocked"[^>]*>[\s\S]*?<\/p>/.exec(page)?.[0] ?? '')).toBe('ส่งไม่ได้เพราะคำขอนี้ส่งหรือยกเลิกจากที่อื่นไปแล้ว')
    expect(timesIn(words(page), 'ส่งไม่ได้เพราะคำขอนี้ส่งหรือยกเลิกจากที่อื่นไปแล้ว')).toBe(1)
    expect(words(page)).not.toContain('ส่งไม่ได้จนกว่าจะโหลดร่างฉบับล่าสุด')
  })

  it('[FR-INT-004/AC2] in English as well', () => {
    const section = words(beforeSending(web(SHORT, {}, 'en')))
    expect(section).not.toContain(READY.en)
    expect(section).toContain('The budget is not enough: 25,000.00 baht left, 35,000.00 baht short. Lower the amount or choose another budget line (fix before sending)')
    expect(words(beforeSending(web(ENOUGH, {}, 'en')))).toContain(READY.en)
    const closedPage = web(ENOUGH, { saveStop: 'closed' }, 'en')
    const closed = words(beforeSending(closedPage))
    expect(closed).toContain('This request was already sent or cancelled elsewhere, so it cannot be sent from this page')
    expect(closed).not.toContain(READY.en)
    expect(words(/<[^>]*id="submit-blocked"[^>]*>[\s\S]*?<\/p>/.exec(closedPage)?.[0] ?? '')).toBe('It cannot be sent because this request was already sent or cancelled elsewhere')
  })
})

describe('[FR-LINE-003/AC1] [§9.9] the LIFF form’s check and send: "ตรวจก่อนส่ง" says what stops the button in the bar', () => {
  it('[§9.9] nothing stops the button: it says the request can be sent', () => {
    const section = beforeSending(liff(null))
    expect(section).toMatch(/<div role="status"[^>]*>.*ข้อมูลที่ตรวจได้บนหน้านี้ครบแล้ว กดส่งได้/)
  })

  it('[FR-INT-004/AC2] over budget: what is left and what is lacking, with the button’s figures and advice, and never that it can be sent', () => {
    const section = words(beforeSending(liff(BUDGET_BLOCK)))
    expect(section).not.toContain(READY.th)
    expect(section).toContain('งบไม่พอ: คงเหลือ 25,000.00 บาท ขาด 35,000.00 บาท ลดยอดหรือเลือกบรรทัดงบอื่น (ต้องแก้ก่อนส่ง)')
    // The bar says it in its own sentence ("ส่งไม่ได้เพราะงบไม่พอ: …"), once on the screen
    expect(section).not.toContain('ส่งไม่ได้เพราะ')
  })

  it('[FR-INT-004/AC2] over budget with something else to fix: the budget first, then the rest, each with its mark', () => {
    const section = words(beforeSending(liff(BUDGET_BLOCK, { problems: [{ kind: 'LINE_INCOMPLETE', lineNo: 2 }] })))
    const budget = section.indexOf('งบไม่พอ: คงเหลือ 25,000.00 บาท ขาด 35,000.00 บาท')
    expect(budget).toBeGreaterThan(-1)
    expect(budget).toBeLessThan(section.indexOf('รายการที่ 2 ยังกรอกไม่ครบ (ต้องแก้ก่อนส่ง)'))
    expect(section).not.toContain(READY.th)
  })

  it('[§9.9] a problem that must be fixed stops the button: the list holds it, with no point of its own and no ready line', () => {
    const section = words(beforeSending(liff({ kind: 'PROBLEMS' }, { problems: [{ kind: 'TITLE' }] })))
    expect(section).toContain('ยังไม่ได้ใส่ชื่อคำขอ (ต้องแก้ก่อนส่ง)')
    expect(section).not.toContain(READY.th)
    expect(section).not.toContain('ส่งไม่ได้')
  })

  it('[FR-INT-006/AC2] saving stopped (the draft was changed elsewhere): it says to load the latest version first, in words of its own, not that the request can be sent', () => {
    const section = words(beforeSending(liff({ kind: 'SAVE', stop: 'conflict' })))
    expect(section).not.toContain(READY.th)
    expect(section).toContain('ร่างนี้ถูกแก้จากที่อื่น โหลดฉบับล่าสุดแล้วตรวจอีกครั้งก่อนส่ง')
    // The bar says it in its own sentence ("ส่งไม่ได้จนกว่าจะโหลดร่างฉบับล่าสุด"), once on the screen
    expect(section).not.toContain('ส่งไม่ได้')
  })

  it('[§9.9] saving stopped (the request was sent or cancelled elsewhere): it says so, never to load the latest version, nor that the request can be sent', () => {
    const section = words(beforeSending(liff({ kind: 'SAVE', stop: 'closed' })))
    expect(section).not.toContain(READY.th)
    expect(section).toContain('คำขอนี้ส่งหรือยกเลิกจากที่อื่นไปแล้ว จึงส่งจากหน้านี้ไม่ได้')
    expect(section).not.toContain('โหลด')
  })

  it('[FR-INT-004/AC2] in English as well', () => {
    const section = words(beforeSending(liff(BUDGET_BLOCK, {}, 'en')))
    expect(section).not.toContain(READY.en)
    expect(section).toContain('The budget is not enough: 25,000.00 baht left, 35,000.00 baht short. Lower the amount or choose another budget line (fix before sending)')
    expect(words(beforeSending(liff(null, {}, 'en')))).toContain(READY.en)
    const conflict = words(beforeSending(liff({ kind: 'SAVE', stop: 'conflict' }, {}, 'en')))
    expect(conflict).toContain('This draft was changed elsewhere. Load the latest version and check it again before sending')
    expect(conflict).not.toContain(READY.en)
  })
})

describe('[§9.9] one message: the point of "ตรวจก่อนส่ง" over budget is the send button’s reason', () => {
  it('[FR-INT-004/AC2] it is the button’s words after its opening "it cannot be sent because", in Thai and in English', () => {
    expect(th.requestForm.submit.blockedBudget).toBe(`ส่งไม่ได้เพราะ${th.requestForm.review.budgetShort}`)
    expect(en.requestForm.submit.blockedBudget).toBe(`It cannot be sent because ${en.requestForm.review.budgetShort.charAt(0).toLowerCase()}${en.requestForm.review.budgetShort.slice(1)}`)
  })

  it('[FR-INT-006/AC2] saving stopped: its points never hold the button’s sentence, which stays the only one on the page, in Thai and in English', () => {
    for (const m of [th, en]) {
      for (const point of [m.requestForm.review.saveConflict, m.requestForm.review.saveClosed]) {
        expect(point).not.toContain(m.requestForm.submit.blockedSave)
        expect(point).not.toContain(m.requestForm.submit.blockedClosed)
      }
    }
  })

  it('[§9.9] sent or cancelled elsewhere: the button and the point give the same reason, and neither names loading the latest version, in Thai and in English', () => {
    expect(th.requestForm.submit.blockedClosed).toBe(`ส่งไม่ได้เพราะ${th.requestForm.review.saveClosed.split(' ')[0]}`)
    expect(en.requestForm.submit.blockedClosed).toBe(`It cannot be sent because ${en.requestForm.review.saveClosed.split(', so ')[0]!.replace(/^This/, 'this')}`)
    for (const text of [th.requestForm.submit.blockedClosed, th.requestForm.review.saveClosed]) expect(text).not.toContain('โหลด')
    for (const text of [en.requestForm.submit.blockedClosed, en.requestForm.review.saveClosed]) expect(text.toLowerCase()).not.toContain('load')
  })
})

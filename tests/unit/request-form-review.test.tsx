import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiffProvider } from '@/ui/liff/liff-provider'
import { LiffReviewStep, type LiffReviewProps } from '@/ui/liff/requests/review-step'
import type { StepProps } from '@/ui/request-form/details-items'
import { formInput, initialValues, totalsOf, type FormValues } from '@/ui/request-form/model'
import { closedWhy, toFormFailure, type FormFailure } from '@/ui/request-form/outcome'
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
// that case. FR-INT-005 AC1 and AC2: an attachment rule not met is a point to fix before sending as well, beside its way
// to the documents, while the button still sends the request for the server to refuse with the rule's code
// (ATTACHMENT_RULE_FAILED) — in a browser: the web's quotation test in tests/e2e/request-form.spec.ts and demo scene 3 (LIFF).

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

/** The point of a list that holds `text`: its <li>, once */
function pointOf(list: string, text: string): string {
  const points = [...list.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]).filter((point) => words(point).includes(text))
  expect(points, `one point holds "${text}"`).toHaveLength(1)
  return points[0]!
}

/** The words of the buttons of some markup, in order */
const waysOf = (markup: string) => [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])

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
    expect(budget).toBeLessThan(section.indexOf('เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTE (ต้องแก้ก่อนส่ง)'))
    expect(section).not.toContain(READY.th)
  })

  it('[FR-INT-005/AC1] [FR-INT-005/AC2] an attachment rule not met is a point to fix before sending, as the budget is, beside its way to the documents; the button still sends, for the server to answer with the rule', () => {
    const problems: ReviewProps['problems'] = [{ kind: 'ATTACHMENTS', ruleId: 'ATT-QUOTES' }]
    const page = web(ENOUGH, { problems })
    const section = beforeSending(page)
    expect(words(pointOf(section, 'เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES'))).toBe('เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES (ต้องแก้ก่อนส่ง)ไปแก้ที่ขั้น ใบเสนอราคาและเอกสาร')
    expect(waysOf(pointOf(section, 'เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES'))).toEqual(['ไปแก้ที่ขั้น ใบเสนอราคาและเอกสาร'])
    expect(words(section)).not.toContain(READY.th)
    // AC2: the button still sends — the server refuses with ATTACHMENT_RULE_FAILED and the rule's code, shown beside it
    const send = /<button[^>]*>ส่งขออนุมัติ<\/button>/.exec(page)?.[0]
    expect(send).toBeDefined()
    expect(send).not.toContain('disabled=""')
    expect(page).not.toContain('id="submit-blocked"')
    const english = beforeSending(web(ENOUGH, { problems }, 'en'))
    expect(words(pointOf(english, 'Documents are missing under rule ATT-QUOTES'))).toBe('Documents are missing under rule ATT-QUOTES (fix before sending)Fix it in Quotations and documents')
    expect(words(english)).not.toContain(READY.en)
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

  it('[FR-INT-005/AC1] [§9.9] a problem this step fixes itself, under its quotations and documents, says what to do there and leads to it; one fixed on another step leads to that step', () => {
    const problems: LiffReviewProps['problems'] = [{ kind: 'ATTACHMENTS', ruleId: 'ATT-QUOTES' }, { kind: 'QUOTATION_FILE', quotationNo: 1 }, { kind: 'TITLE' }]
    const ways = (locale: Locale) => waysOf(beforeSending(liff(null, { problems }, locale)))
    expect(ways('th')).toEqual(['แนบให้ครบตามกฎ ATT-QUOTES ในส่วน ใบเสนอราคาและเอกสาร', 'ไปแก้ที่ส่วน ใบเสนอราคาและเอกสาร', 'ไปแก้ที่ขั้น รายละเอียดคำขอ'])
    expect(ways('en')).toEqual(['Attach what rule ATT-QUOTES asks for under Quotations and documents', 'Fix it under Quotations and documents', 'Fix it in Request details'])
    // The rule not met is marked as one to fix before sending, as the title is: each beside its way to the fix
    const section = beforeSending(liff(null, { problems }))
    expect(words(pointOf(section, 'เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES'))).toBe('เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES (ต้องแก้ก่อนส่ง)แนบให้ครบตามกฎ ATT-QUOTES ในส่วน ใบเสนอราคาและเอกสาร')
    expect(words(pointOf(section, 'ยังไม่ได้ใส่ชื่อคำขอ'))).toBe('ยังไม่ได้ใส่ชื่อคำขอ (ต้องแก้ก่อนส่ง)ไปแก้ที่ขั้น รายละเอียดคำขอ')
  })

  it('[FR-INT-005/AC1] [FR-INT-005/AC2] an attachment rule not met is a point to fix before sending, though nothing stops the bar’s button: the server answers the send with the rule', () => {
    // The shell stops the button only for what would send something other than the screen (sendBlock null here): the
    // point still says the rule must be met first, with its way to the rule's entry in the documents
    const problems: LiffReviewProps['problems'] = [{ kind: 'ATTACHMENTS', ruleId: 'ATT-QUOTES' }]
    const section = beforeSending(liff(null, { problems }))
    expect(words(pointOf(section, 'เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES'))).toBe('เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES (ต้องแก้ก่อนส่ง)แนบให้ครบตามกฎ ATT-QUOTES ในส่วน ใบเสนอราคาและเอกสาร')
    expect(words(section)).not.toContain(READY.th)
    expect(words(section)).not.toContain('ส่งไม่ได้')
    const english = beforeSending(liff(null, { problems }, 'en'))
    expect(words(pointOf(english, 'Documents are missing under rule ATT-QUOTES'))).toBe(
      'Documents are missing under rule ATT-QUOTES (fix before sending)Attach what rule ATT-QUOTES asks for under Quotations and documents',
    )
    expect(words(english)).not.toContain(READY.en)
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

describe('[FR-INT-005/AC2] [§9.9] every point of "ตรวจก่อนส่ง" is one to fix before sending: what the button still sends, the server refuses', () => {
  /**
   * A point of each kind that does not stop the button, each refused by the server when it is sent: no budget line, a
   * question not answered (FORM), a service line without its end (SERVICE_END_DATE), a quotation without its file
   * (FILE_REQUIRED), none chosen (QUOTE-SELECTED), a dearer one without its reason (QUOTE-LOWEST), a rule not met
   * (ATTACHMENT_RULE_FAILED)
   */
  const SENT_BUT_REFUSED: ReviewProps['problems'] = [
    { kind: 'BUDGET_LINE' },
    { kind: 'FIELD_REQUIRED', fieldId: 'category' },
    { kind: 'SERVICE_END_DATE', lineNo: 1 },
    { kind: 'QUOTATION_FILE', quotationNo: 1 },
    { kind: 'QUOTATION_CHOOSE' },
    { kind: 'QUOTATION_REASON' },
    { kind: 'ATTACHMENTS', ruleId: 'ATT-QUOTES' },
  ]
  const POINTS: Record<Locale, readonly string[]> = {
    th: [
      'ยังไม่ได้เลือกบรรทัดงบ',
      'ยังไม่ได้ตอบ “category”',
      'รายการที่ 1 ยังไม่มีวันสิ้นสุดบริการ',
      'ใบเสนอราคาที่ 1 ยังไม่มีไฟล์',
      'ยังไม่ได้เลือกใบเสนอราคาที่จะใช้',
      'ใบเสนอราคาที่เลือกไม่ใช่ยอดก่อน VAT ต่ำสุด ใส่เหตุผล',
      'เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES',
    ],
    en: [
      'No budget line chosen yet',
      '“category” is not answered',
      'Item 1 has no service end date',
      'Quotation 1 has no file',
      'No quotation chosen to use',
      'The chosen quotation is not the lowest before VAT: give a reason',
      'Documents are missing under rule ATT-QUOTES',
    ],
  }
  const MUST_FIX: Record<Locale, string> = { th: '(ต้องแก้ก่อนส่ง)', en: '(fix before sending)' }

  for (const locale of ['th', 'en'] as const) {
    it(`[FR-INT-005/AC2] the workspace’s step and the LIFF one mark each of them, e.g. "ใบเสนอราคาที่ 1 ยังไม่มีไฟล์ (ต้องแก้ก่อนส่ง)" (${locale})`, () => {
      const forms = { web: web(ENOUGH, { problems: SENT_BUT_REFUSED }, locale), liff: liff(null, { problems: SENT_BUT_REFUSED }, locale) }
      for (const [form, page] of Object.entries(forms)) {
        const section = beforeSending(page)
        for (const point of POINTS[locale]) expect(words(pointOf(section, point)), `${form}: ${point}`).toContain(`${point} ${MUST_FIX[locale]}`)
        expect(timesIn(words(section), MUST_FIX[locale]), `${form}: every point is marked`).toBe(SENT_BUT_REFUSED.length)
        expect(words(section), form).not.toContain(READY[locale])
      }
      // None of them stops the workspace's button: the server answers the send, beside it
      const send = new RegExp(`<button[^>]*>${locale === 'th' ? 'ส่งขออนุมัติ' : en.requestForm.submit.send}</button>`).exec(forms.web)?.[0]
      expect(send).toBeDefined()
      expect(send).not.toContain('disabled=""')
    })
  }
})

describe('[FR-INT-005/AC2] [§9.9] the LIFF form’s refusal of a send says what to do and leads there: to another step, or to its place on this one', () => {
  /**
   * The refusal at the end of the step, after "ตรวจก่อนส่ง" — right above the send button in the bar, where the requester
   * pressed it, as the workspace's review step puts it above its button: its notice, which nothing on the step follows
   */
  function refusal(submitError: FormFailure, locale: Locale = 'th'): string {
    const page = liff(null, { submitError }, locale)
    const start = page.indexOf('role="alert"')
    expect(start, 'the step shows the refusal').toBeGreaterThanOrEqual(0)
    expect(timesIn(page, 'role="alert"'), 'the refusal is on the step once').toBe(1)
    const problems = page.indexOf('<section aria-labelledby="review-problems"')
    expect(problems, 'the step has its "ตรวจก่อนส่ง"').toBeGreaterThanOrEqual(0)
    expect(start, 'the refusal comes after "ตรวจก่อนส่ง"').toBeGreaterThan(page.indexOf('</section>', problems))
    const notice = page.slice(start)
    expect(notice, 'nothing on the step follows the refusal').not.toContain('<section')
    return notice
  }
  const ways = (notice: string) => [...notice.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
  const RULE = toFormFailure({ code: 'ATTACHMENT_RULE_FAILED', details: { rule: 'ATT-QUOTES', failures: [{ rule: 'ATT-QUOTES', missing: [{ kind: 'ATTACHMENT', attachment: 'QUOTATION', need: 3, have: 1 }] }] } })
  const SUPPLIER = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'suggestedSupplierId', reason: 'UNKNOWN' } })

  it('[§9.9] whatever the server refused, the refusal is the last thing on the step, right above the send button in the bar — never only at the top of a long step', () => {
    const said: ReadonlyArray<readonly [FormFailure, string]> = [
      [RULE, 'แนบเอกสารยังไม่ครบตามกฎ ATT-QUOTES'],
      [toFormFailure({ code: 'BUDGET_INSUFFICIENT', details: { available: '25000.00', shortfall: '35000.00' } }), 'งบไม่พอ คงเหลือ 25,000.00 บาท ขาด 35,000.00 บาท'],
      [toFormFailure({ code: 'NO_HIGHER_AUTHORITY', details: { adminsNotified: 1 } }), `${th.requestForm.errors.NO_HIGHER_AUTHORITY} ${th.requestForm.errors.adminsTold}`],
      [{ ok: false, code: 'DRAFT_NOT_SAVED' }, th.requestForm.errors.DRAFT_NOT_SAVED],
      [toFormFailure({ code: 'CONFLICT_VERSION' }), th.requestForm.errors.CONFLICT_VERSION],
    ]
    for (const [submitError, text] of said) expect(words(refusal(submitError)), submitError.code).toContain(text)
    // The version conflict keeps its way to the latest version inside the notice
    expect(ways(refusal(toFormFailure({ code: 'CONFLICT_VERSION' })))).toEqual([th.requestForm.save.reload])
    // The step still opens with its summary
    const page = liff(null, { submitError: RULE })
    expect(page.indexOf('<section aria-labelledby="review-summary"')).toBeGreaterThanOrEqual(0)
    expect(page.indexOf('<section aria-labelledby="review-summary"')).toBeLessThan(page.indexOf('role="alert"'))
  })

  it('[FR-INT-005/AC2] fixed in the quotations and documents of this step: it names that part — not a step this form does not have — and leads to it', () => {
    const rule = refusal(RULE)
    expect(words(rule)).toContain('แนบเอกสารยังไม่ครบตามกฎ ATT-QUOTES: ขาด ใบเสนอราคา 3 ไฟล์ (มี 1) แนบในส่วนใบเสนอราคาและเอกสารแล้วส่งอีกครั้ง')
    expect(ways(rule)).toEqual(['ไปแก้ที่ส่วน ใบเสนอราคาและเอกสาร'])
    const supplier = refusal(SUPPLIER)
    expect(words(supplier)).toContain('ผู้ขายที่แนะนำเลิกใช้แล้ว เลือกผู้ขายรายอื่นหรือไม่ระบุในส่วนใบเสนอราคาและเอกสาร')
    expect(ways(supplier)).toEqual(['ไปแก้ที่ส่วน ใบเสนอราคาและเอกสาร'])
    for (const notice of [rule, supplier]) expect(words(notice)).not.toContain('ขั้นใบเสนอราคาและเอกสาร')
  })

  it('[§9.9] fixed on another step: it leads to that step', () => {
    expect(ways(refusal(toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'deliverySiteId', reason: 'UNKNOWN' } })))).toEqual(['ไปแก้ที่ขั้น รายการที่ขอ'])
    expect(ways(refusal(toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'formData.category', reason: 'FORM' } })))).toEqual(['ไปแก้ที่ขั้น รายละเอียดคำขอ'])
  })

  it('[FR-INT-005/AC2] in English as well', () => {
    const rule = refusal(RULE, 'en')
    expect(words(rule)).toContain('Attach them in Quotations and documents, then send again')
    expect(ways(rule)).toEqual(['Fix it under Quotations and documents'])
    expect(ways(refusal(SUPPLIER, 'en'))).toEqual(['Fix it under Quotations and documents'])
  })
})

describe('[FR-INT-006/AC2] [§9.9] a request closed to the form is said by what closed it, never a guess between two (D-05 round 4)', () => {
  const CAUSES = ['SENT', 'CANCELLED', 'NOT_FOUND', 'FORBIDDEN'] as const
  const POINT = {
    SENT: 'คำขอนี้ส่งจากที่อื่นไปแล้ว จึงส่งจากหน้านี้ไม่ได้',
    CANCELLED: 'คำขอนี้ถูกยกเลิกจากที่อื่นไปแล้ว จึงส่งจากหน้านี้ไม่ได้',
    NOT_FOUND: 'ไม่พบคำขอนี้แล้ว จึงส่งจากหน้านี้ไม่ได้',
    FORBIDDEN: 'บัญชีนี้แก้ไขคำขอนี้ไม่ได้แล้ว จึงส่งจากหน้านี้ไม่ได้',
  } as const

  it('the server’s answer names the cause: the status it gives, or that the request is gone or not this account’s', () => {
    expect(closedWhy(toFormFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'PENDING_APPROVAL', command: 'request.edit' } }))).toBe('SENT')
    expect(closedWhy(toFormFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'APPROVED' } }))).toBe('SENT')
    expect(closedWhy(toFormFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED' } }))).toBe('CANCELLED')
    expect(closedWhy(toFormFailure({ code: 'NOT_FOUND' }))).toBe('NOT_FOUND')
    expect(closedWhy(toFormFailure({ code: 'FORBIDDEN' }))).toBe('FORBIDDEN')
    // No status named: only then both
    expect(closedWhy(toFormFailure({ code: 'INVALID_STATE_TRANSITION' }))).toBe('ELSEWHERE')
  })

  for (const why of CAUSES) {
    it(`${why}: "ตรวจก่อนส่ง" and the button give that one reason, the button's once, and never to load the latest version`, () => {
      const page = web(ENOUGH, { saveStop: 'closed', closedWhy: why })
      const section = words(beforeSending(page))
      expect(section).toContain(POINT[why])
      expect(section).not.toContain(th.requestForm.review.saveClosed)
      const send = /<button[^>]*>ส่งขออนุมัติ<\/button>/.exec(page)?.[0]
      expect(send).toContain('disabled=""')
      expect(words(/<[^>]*id="submit-blocked"[^>]*>[\s\S]*?<\/p>/.exec(page)?.[0] ?? '')).toBe(th.requestForm.submit.blockedClosedBy[why])
      expect(timesIn(words(page), th.requestForm.submit.blockedClosedBy[why])).toBe(1)
      expect(section).not.toContain('โหลด')
      expect(words(page)).not.toContain('ส่งไม่ได้จนกว่าจะโหลดร่างฉบับล่าสุด')
      // The LIFF step says the same point when its shell names the cause
      expect(words(beforeSending(liff({ kind: 'SAVE', stop: 'closed', why })))).toContain(POINT[why])
    })
  }

  it('the button’s reason is the point’s cause after "ส่งไม่ได้เพราะ", for every cause, in Thai and in English', () => {
    for (const why of CAUSES) {
      expect(th.requestForm.submit.blockedClosedBy[why], why).toBe(`ส่งไม่ได้เพราะ${th.requestForm.review.saveClosedBy[why].split(' ')[0]}`)
      expect(en.requestForm.submit.blockedClosedBy[why], why).toBe(`It cannot be sent because ${en.requestForm.review.saveClosedBy[why].split(', so ')[0]!.replace(/^This/, 'this')}`)
      for (const m of [th, en]) expect(m.requestForm.review.saveClosedBy[why].toLowerCase(), why).not.toMatch(/โหลด|load/)
    }
  })

  it('a refusal because the request was sent or cancelled meanwhile says which, and leads to the request’s page', () => {
    const sent = web(ENOUGH, { submitError: toFormFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'PENDING_APPROVAL' } }), requestHref: '/requests/r-1' })
    expect(words(sent)).toContain(th.requestForm.errors.STATE_SENT)
    expect(sent).toMatch(new RegExp(`<a href="/requests/r-1"[^>]*>${th.requestForm.page.openRequest}</a>`))
    const cancelled = web(ENOUGH, { submitError: toFormFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED' } }), requestHref: '/requests/r-1' })
    expect(words(cancelled)).toContain(th.requestForm.errors.STATE_CANCELLED)
    expect(words(cancelled)).not.toContain(th.requestForm.errors.STATE)
    // Without a status the words stay "sent or cancelled"
    expect(words(web(ENOUGH, { submitError: toFormFailure({ code: 'INVALID_STATE_TRANSITION' }) }))).toContain(th.requestForm.errors.STATE)
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

describe('[§9.9] enough budget and "it can be sent" are supporting information on a request not sent yet: --info, never the approved mark of --primary', () => {
  /** A section of the step by the id of its heading, to its end */
  function sectionOf(page: string, id: string): string {
    const start = page.indexOf(`<section aria-labelledby="${id}"`)
    expect(start, `the step has its section "${id}"`).toBeGreaterThanOrEqual(0)
    return page.slice(start, page.indexOf('</section>', start) + '</section>'.length)
  }
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  /** A line of words after its icon: the line's classes and the icon's attributes */
  function markOf(markup: string, text: string): { line: string; icon: string } {
    const found = new RegExp(`<p class="([^"]*)"><svg([^>]*)>(?:(?!</svg>)[\\s\\S])*</svg><span>${escape(text)}</span></p>`).exec(markup)
    expect(found, `"${text}" with its icon`).not.toBeNull()
    return { line: found![1]!, icon: found![2]! }
  }

  it('[FR-INT-004/AC1] "งบพอ": the info icon in --info and medium words in ink, on the workspace’s form and the LIFF one (the same BudgetStatus); "งบไม่พอ" stays --danger', () => {
    for (const page of [web(ENOUGH), liff(null)]) {
      const budget = sectionOf(page, 'review-budget')
      const enough = markOf(budget, th.requestForm.budget.enough)
      expect(enough.line.split(' ')).toEqual(expect.arrayContaining(['font-medium', 'text-ink']))
      expect(enough.icon).toContain('lucide-info')
      expect(enough.icon).toContain('text-info')
      expect(enough.icon).toContain('aria-hidden="true"')
      expect(budget).not.toContain('text-primary')
      expect(budget).not.toContain('lucide-circle-check')
    }
    const short = markOf(sectionOf(web(SHORT), 'review-budget'), 'งบไม่พอ ขาด 35,000.00 บาท ลดยอดหรือเลือกบรรทัดงบอื่น')
    expect(short.line).toContain('text-danger')
    expect(short.icon).toContain('lucide-circle-alert')
  })

  it('[FR-INT-004/AC2] the workspace’s ready line: the info icon in --info beside words in ink, with nothing of --primary', () => {
    const section = beforeSending(web(ENOUGH))
    const ready = markOf(section, READY.th)
    expect(ready.line).toContain('text-ink')
    expect(ready.icon).toContain('lucide-info')
    expect(ready.icon).toContain('text-info')
    expect(section).not.toContain('text-primary')
    expect(section).not.toContain('lucide-circle-check')
  })

  it('[FR-INT-004/AC2] the LIFF ready line: an info notice — its rule and icon in --info — still a status for screen readers', () => {
    const section = beforeSending(liff(null))
    const notice = new RegExp(`<div role="status" class="([^"]*)"><svg([^>]*)>(?:(?!</svg>)[\\s\\S])*</svg><div class="min-w-0">${escape(READY.th)}</div></div>`).exec(section)
    expect(notice, 'the ready notice').not.toBeNull()
    expect(notice![1]).toContain('border-info')
    expect(notice![2]).toContain('text-info')
    expect(section).not.toMatch(/(?:border|text)-primary/)
  })
})

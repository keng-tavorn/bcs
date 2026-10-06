import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formDefinition } from '@/server/forms/schema'
import { loadSeedForms } from '@/server/seed/forms'
import { LiffDetailsStep } from '@/ui/liff/requests/details-step'
import { DetailsStep, type StepProps } from '@/ui/request-form/details-items'
import { documentFieldIds } from '@/ui/request-form/document-fields'
import { DocumentsStep } from '@/ui/request-form/documents-step'
import { applicableRules, formInput, initialValues, problemStep, totalsOf, visibleFieldIds, type FormValues } from '@/ui/request-form/model'
import { failureStep, toFormFailure } from '@/ui/request-form/outcome'
import type { RequestFormData } from '@/ui/request-form/types'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-INT-002 AC1 · FR-INT-005 AC1 · §9.9 principle 2 (ask, step by step, only what is needed): a question the attachment
// rules ask to be answered — the single-source reason that ATT-QUOTES takes with one quotation (BR-FORM-04) — is asked
// beside the documents, in the step that shows the rules and the quotations, not with the request's details, and the
// demo forms ask it only while the rule applies, above 100,000.00 baht with VAT. A problem or a refusal about it leads to
// that step. Static markup of the workspace's steps 1 and 3 and of the LIFF form's step 1 (whose step 3 draws the same
// documents step); the scenes in a browser: demo scene 3 (tests/e2e/demo/03-pin-in-liff.spec.ts).

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

const SEED = loadSeedForms()
/** The purchase types of the demo, each with the single-source reason and ATT-QUOTES */
const PURCHASES = ['BUY_GOODS', 'HIRE_SERVICE', 'CONTRACT_WORK', 'IT_PURCHASE'] as const
const REASON = 'singleSourceJustification'

const LINE = { id: '00000000-0000-4000-8000-000000000001', code: 'CON-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายก่อสร้าง', departmentId: 'd-con', departmentName: 'ฝ่ายก่อสร้าง', costCenterCode: 'CC-CON', costCenterName: 'ศูนย์ต้นทุนฝ่ายก่อสร้าง', granted: false }

const DATA: RequestFormData = {
  type: { code: 'BUY_GOODS', name: 'ซื้อของ', description: null, documentType: 'PURCHASE_REQUEST' },
  form: formDefinition(SEED.get('BUY_GOODS')),
  requesterDepartmentName: 'ฝ่ายก่อสร้าง',
  budgetLines: [LINE],
  defaultBudgetLineId: LINE.id,
  vatRateBp: 700,
  attachmentKinds: ['QUOTATION', 'OTHER'],
  draft: null,
}

/** The demo's BUY_GOODS form with one line of `unitPrice` baht before VAT, as each step gets it */
function formAt(unitPrice: string): StepProps {
  const values: FormValues = {
    ...initialValues(DATA),
    title: 'ปั๊มน้ำบาดาล',
    lines: [{ key: 'line-0', id: null, reserved: null, description: 'ปั๊มน้ำบาดาล', quantity: '1', uom: 'เครื่อง', unitPrice, vatable: true, serviceEndDate: '' }],
  }
  const totals = totalsOf(values, DATA.vatRateBp)
  const input = formInput(values, [], totals, DATA.type.code)
  return { data: DATA, values, update: () => undefined, locale: 'th', input, visible: visibleFieldIds(DATA.form, input), totals, showErrors: true, budget: null, previewLoading: false, fieldErrors: {} }
}

const documentsStep = (step: StepProps, locale: 'th' | 'en' = 'th') =>
  html(
    <DocumentsStep
      {...step}
      locale={locale}
      rules={applicableRules(step.data.form, step.input)}
      nets={{}}
      lowest={[]}
      attachments={[]}
      uploads={{ requestUpload: async () => ({ ok: false, reason: 'FAILED' }), completeUpload: async () => ({ ok: false, reason: 'FAILED' }) }}
      onAttach={async () => undefined}
      onDetach={async () => undefined}
      onOpenFile={() => undefined}
      fileError={null}
      busy={false}
    />,
    locale,
  )

const liffDetails = (step: StepProps) =>
  html(<LiffDetailsStep data={step.data} values={step.values} update={step.update} locale="th" visible={step.visible} showErrors={false} budget={null} previewLoading={false} fieldErrors={{}} titleMax={200} />)

/** "เอกสารที่ต้องแนบ": its section of the documents step, to the end of it */
function requiredDocuments(page: string): string {
  const start = page.indexOf('<section aria-labelledby="required-documents"')
  expect(start, 'the step has its required documents').toBeGreaterThanOrEqual(0)
  return page.slice(start, page.indexOf('</section>', start) + '</section>'.length)
}

describe('[FR-INT-002/AC1] [FR-INT-005/AC1] the single-source reason is asked beside the documents, and only while ATT-QUOTES applies', () => {
  it('the demo’s purchase forms show the reason under the same condition as the rule that takes it: above 100,000.00 baht with VAT', () => {
    for (const code of PURCHASES) {
      const form = formDefinition(SEED.get(code))
      const quotes = form.rules.find((r) => r.id === 'ATT-QUOTES')
      expect(quotes, code).toBeDefined()
      expect(form.visibility.find((v) => v.field === REASON)?.when, code).toEqual(quotes!.when)
      expect(documentFieldIds(form.rules), code).toEqual(new Set([REASON]))
      // Its hint says the amount as the rule does: with VAT, two decimals
      const help = form.fields.find((f) => f.id === REASON)?.help
      expect(help?.th, code).toBe('ใช้เมื่อยอดรวม VAT เกิน 100,000.00 บาท และมีใบเสนอราคาไม่ครบ 3 ราย')
      expect(help?.en, code).toBe('Needed when the total with VAT is over 100,000.00 baht with fewer than 3 quotations')
    }
  })

  it('above 100,000.00 baht with VAT: asked under the rule in the documents step, and in neither form’s details step', () => {
    const above = formAt('150000.00')
    expect(above.visible.has(REASON)).toBe(true)
    expect(html(<DetailsStep {...above} />)).not.toContain(`field-${REASON}`)
    expect(liffDetails(above)).not.toContain(`field-${REASON}`)
    const documents = requiredDocuments(documentsStep(above))
    // After the rule's entry, which names the reason among what it asks for
    const rule = documents.indexOf('data-rule="ATT-QUOTES"')
    const box = documents.indexOf(`<textarea id="field-${REASON}"`)
    expect(rule).toBeGreaterThanOrEqual(0)
    expect(box).toBeGreaterThan(rule)
    expect(documents).toMatch(new RegExp(`<label for="field-${REASON}"[^>]*>เหตุผลกรณีมีผู้ขายรายเดียว`))
    expect(documents).toContain('ใช้เมื่อยอดรวม VAT เกิน 100,000.00 บาท และมีใบเสนอราคาไม่ครบ 3 ราย')
    expect(requiredDocuments(documentsStep(above, 'en'))).toContain('Needed when the total with VAT is over 100,000.00 baht with fewer than 3 quotations')
  })

  it('at 100,000.00 baht with VAT or less: not asked at all — no rule asks for quotations', () => {
    const below = formAt('50000.00')
    expect(below.visible.has(REASON)).toBe(false)
    expect(applicableRules(DATA.form, below.input)).toEqual([])
    expect(html(<DetailsStep {...below} />)).not.toContain(`field-${REASON}`)
    expect(liffDetails(below)).not.toContain(`field-${REASON}`)
    expect(documentsStep(below)).not.toContain(`field-${REASON}`)
  })

  it('a problem or a refusal about such a question leads to the documents step; any other question’s to the details', () => {
    const asked = documentFieldIds(DATA.form.rules)
    expect(problemStep({ kind: 'FIELD_REQUIRED', fieldId: REASON }, asked)).toBe('documents')
    expect(problemStep({ kind: 'FIELD_REQUIRED', fieldId: 'scopeOfWork' }, asked)).toBe('details')
    const refused = (field: string) => toFormFailure({ code: 'VALIDATION_FAILED', details: { field: `formData.${field}`, reason: 'FORM' } })
    expect(failureStep(refused(REASON), asked)).toBe('documents')
    expect(failureStep(refused('scopeOfWork'), asked)).toBe('details')
    // A form whose rules ask for no question: every question is a detail
    expect(failureStep(refused(REASON))).toBe('details')
  })
})

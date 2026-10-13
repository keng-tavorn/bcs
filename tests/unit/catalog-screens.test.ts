import { describe, expect, it } from 'vitest'
import { agreementFormErrors, agreementState, canEndAgreement, itemFormErrors, itemFormValues, lastDayOf, validToOf } from '@/ui/catalog/model'
import { catalogErrorField, catalogErrorKey, toCatalogFailure } from '@/ui/catalog/outcome'
import { asksOffAgreementReason, catalogPickOf, catalogProblems, lineAgreement, supplierToSuggest, type CatalogPick } from '@/ui/request-form/catalog-lines'
import { draftPayload, emptyLine, formReducer, initialValues, problemStep, type FormValues } from '@/ui/request-form/model'
import { failureKey, failureStep, toFormFailure } from '@/ui/request-form/outcome'
import type { CatalogItemOption, RequestFormData } from '@/ui/request-form/types'

// S6-10 on screen (FR-INT-102, BR-PRC-06): the request form's catalogue lines — the agreed price of the suggested
// supplier locks the line's price, another supplier needs the request's reason — and the manage page's rules (the
// period picked as first and last day, where each agreed price stands, the refusals in words). Pure; the server checks
// the same again (tests/integration/catalog.test.ts).

const SUP_A = '00000000-0000-4000-8000-00000000000a'
const SUP_B = '00000000-0000-4000-8000-00000000000b'
const SUP_C = '00000000-0000-4000-8000-00000000000c'
const ITEM = '00000000-0000-4000-8000-000000000101'
const PLAIN = '00000000-0000-4000-8000-000000000102'

const CEMENT: CatalogItemOption = {
  id: ITEM,
  code: 'CEM-01',
  nameTh: 'ปูนซีเมนต์ 50 กก.',
  nameEn: 'Cement 50 kg',
  uom: 'ถุง',
  categoryCode: 'CEMENT',
  refUnitPriceSatang: '18000',
  agreements: [
    { supplierId: SUP_A, supplierCode: 'A', supplierName: 'ร้าน ก', unitPriceSatang: '16550' },
    { supplierId: SUP_B, supplierCode: 'B', supplierName: 'ร้าน ข', unitPriceSatang: '15900' },
  ],
}
const SAND: CatalogItemOption = { id: PLAIN, code: 'SAND', nameTh: 'ทราย', nameEn: null, uom: 'คิว', categoryCode: 'SAND', refUnitPriceSatang: '50000', agreements: [] }

function formData(more: Partial<RequestFormData> = {}): RequestFormData {
  return {
    type: { code: 'BUY_GOODS', name: 'ซื้อของ', description: null, documentType: 'PURCHASE_REQUEST' },
    form: { fields: [], visibility: [], rules: [], lines: {} },
    requesterDepartmentName: null,
    budgetLines: [],
    defaultBudgetLineId: null,
    vatRateBp: 700,
    attachmentKinds: [],
    suppliers: [
      { id: SUP_A, code: 'A', name: 'ร้าน ก' },
      { id: SUP_B, code: 'B', name: 'ร้าน ข' },
      { id: SUP_C, code: 'C', name: 'ร้าน ค' },
    ],
    catalogItems: [],
    draft: null,
    ...more,
  }
}

const OFFERED = [SUP_A, SUP_B, SUP_C]
const cement: CatalogPick = catalogPickOf(CEMENT)
const pick = (v: FormValues, item: CatalogPick, key = 'line-0') => formReducer(v, { type: 'pickCatalog', key, item, offered: OFFERED })

describe('[FR-INT-102/AC2] a line picked from the catalogue takes the agreed price of the suggested supplier', () => {
  it('reads the agreed prices as baht with two decimals, from satang, and suggests the supplier of the lowest one the form offers', () => {
    expect(cement.refUnitPrice).toBe('180.00')
    expect(cement.agreements.map((a) => a.unitPrice)).toEqual(['165.50', '159.00'])
    expect(supplierToSuggest(cement, OFFERED)).toBe(SUP_B)
    // A supplier the form does not offer (deactivated) is never suggested
    expect(supplierToSuggest(cement, [SUP_A, SUP_C])).toBe(SUP_A)
    expect(supplierToSuggest(cement, [SUP_C])).toBeNull()
  })

  it('with no supplier suggested yet: the line takes the name, unit and item, the supplier of the lowest agreed price, and its price, locked', () => {
    const v = pick(initialValues(formData()), cement)
    const line = v.lines[0]!
    expect(line).toMatchObject({ description: 'ปูนซีเมนต์ 50 กก.', uom: 'ถุง', catalogItemId: ITEM, unitPrice: '159.00' })
    expect(v.suggestedSupplierId).toBe(SUP_B)
    expect(lineAgreement(line, v)).toMatchObject({ kind: 'LOCKED', agreement: { supplierId: SUP_B } })
    expect(catalogProblems(v)).toEqual([])
  })

  it('a supplier changed to another with an agreed price re-prices the line; to one without, the price stays and a reason is asked', () => {
    const v = pick(initialValues(formData()), cement)
    const toA = formReducer(v, { type: 'suggestedSupplier', value: SUP_A })
    expect(toA.lines[0]!.unitPrice).toBe('165.50')
    const toC = formReducer(toA, { type: 'suggestedSupplier', value: SUP_C })
    expect(toC.lines[0]!.unitPrice).toBe('165.50')
    expect(lineAgreement(toC.lines[0]!, toC).kind).toBe('OFF')
    expect(asksOffAgreementReason(toC)).toBe(true)
    expect(catalogProblems(toC)).toEqual([{ kind: 'AGREEMENT_REASON' }])
    const reasoned = formReducer(toC, { type: 'offAgreementReason', value: 'ร้าน ค ส่งของถึงหน้างานได้เร็วกว่า' })
    expect(catalogProblems(reasoned)).toEqual([])
    // The reason waits for a later step ("ถัดไป" does not stop on it) and is fixed on the items step
    expect(problemStep({ kind: 'AGREEMENT_REASON' })).toBe('items')
  })

  it('an item with an agreed price on a request priced with VAT, or an item taken out of the catalogue, must be fixed before sending', () => {
    const v = formReducer(pick(initialValues(formData()), cement), { type: 'priceIncludesVat', value: true })
    expect(catalogProblems(v)).toEqual([{ kind: 'AGREEMENT_BEFORE_VAT', lineNo: 1 }])
    const unlisted: FormValues = { ...initialValues(formData()), lines: [{ ...emptyLine('l'), description: 'ปูน', catalogItemId: ITEM }] }
    expect(lineAgreement(unlisted.lines[0]!, unlisted).kind).toBe('UNLISTED')
    expect(catalogProblems(unlisted)).toEqual([{ kind: 'CATALOG_UNLISTED', lineNo: 1 }])
  })

  it('an item without agreed prices fills a blank price with its reference price; unlinking keeps the words and the price', () => {
    const v = pick(initialValues(formData()), catalogPickOf(SAND))
    expect(v.lines[0]).toMatchObject({ description: 'ทราย', uom: 'คิว', unitPrice: '500.00', catalogItemId: PLAIN })
    expect(v.suggestedSupplierId).toBe('')
    expect(lineAgreement(v.lines[0]!, v).kind).toBe('LISTED')
    const unlinked = formReducer(v, { type: 'unlinkCatalog', key: 'line-0' })
    expect(unlinked.lines[0]).toMatchObject({ description: 'ทราย', unitPrice: '500.00', catalogItemId: null })
    expect(lineAgreement(unlinked.lines[0]!, unlinked).kind).toBe('NONE')
  })

  it('every save says whether each line is a catalogue item, with the item’s category, and the reason; a cleared reason is cleared', () => {
    const v = { ...pick(initialValues(formData()), cement), title: 'ปูน' }
    const typed = formReducer(v, { type: 'line', key: 'line-0', patch: { quantity: '10' } })
    const fresh = draftPayload(typed, 'ซื้อของ', true).draft
    expect(fresh.lines).toEqual([{ id: null, description: 'ปูนซีเมนต์ 50 กก.', quantity: '10', uom: 'ถุง', unitPrice: '159.00', vatable: true, catalogItemId: ITEM, categoryCode: 'CEMENT' }])
    expect(fresh).not.toHaveProperty('offAgreementReason')
    const reasoned = formReducer(typed, { type: 'offAgreementReason', value: ' ด่วน ' })
    expect(draftPayload(reasoned, 'ซื้อของ', false).draft.offAgreementReason).toBe('ด่วน')
    expect(draftPayload(typed, 'ซื้อของ', false).draft.offAgreementReason).toBeNull()
  })

  it('a draft opens with its catalogue items and today’s agreed price; a form without the catalogue (LIFF) leaves the reason as saved', () => {
    const draft = {
      requestId: 'r1',
      version: 3,
      status: 'DRAFT' as const,
      title: 'ปูน',
      budgetLineId: null,
      priceIncludesVat: false,
      formData: {},
      lines: [{ id: 'l1', reserved: null, description: 'ปูน', quantity: '10', uom: 'ถุง', unitPrice: '170.00', vatable: true, serviceEndDate: null, catalogItemId: ITEM }],
      quotations: [],
      nonLowestQuoteReason: '',
      attachments: [],
      returnReason: null,
      suggestedSupplierId: SUP_A,
      offAgreementReason: 'เดิม',
    }
    const web = initialValues(formData({ draft, catalogItems: [CEMENT] }))
    expect(web.lines[0]!.unitPrice).toBe('165.50')
    expect(web.offAgreementReason).toBe('เดิม')
    const liff = initialValues(formData({ draft, catalogItems: undefined }))
    expect(liff).not.toHaveProperty('catalog')
    expect(liff).not.toHaveProperty('offAgreementReason')
    expect(liff.lines[0]!.unitPrice).toBe('170.00')
    const sent = draftPayload(liff, 'ซื้อของ', false).draft
    expect(sent).not.toHaveProperty('offAgreementReason')
    expect(sent.lines?.[0]).toMatchObject({ catalogItemId: ITEM })
    expect(sent.lines?.[0]).not.toHaveProperty('categoryCode')
  })

  it('the server’s refusals of agreed prices are said in words and fixed on the items step', () => {
    const locked = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines.1.unitPrice', reason: 'AGREEMENT_PRICE_LOCKED' } })
    expect(failureKey(locked)).toBe('AGREEMENT_PRICE_LOCKED')
    expect(failureStep(locked)).toBe('items')
    const off = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'offAgreementReason', reason: 'AGREEMENT_OFF' } })
    expect([failureKey(off), failureStep(off)]).toEqual(['AGREEMENT_OFF', 'items'])
    const vat = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'priceIncludesVat', reason: 'AGREEMENT_PRICE_BEFORE_VAT' } })
    expect([failureKey(vat), failureStep(vat)]).toEqual(['AGREEMENT_PRICE_BEFORE_VAT', 'items'])
    const unknown = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines.0.catalogItemId', reason: 'UNKNOWN' } })
    expect([failureKey(unknown), failureStep(unknown)]).toEqual(['CATALOG_UNKNOWN', 'items'])
  })
})

describe('[FR-INT-102/AC3] the manage page: items, agreed prices and their periods', () => {
  it('the last day picked (included) becomes the period’s end (not included) and back, across months and years', () => {
    expect(validToOf('2026-12-31')).toBe('2027-01-01')
    expect(validToOf('2028-02-28')).toBe('2028-02-29')
    expect(lastDayOf('2026-03-01')).toBe('2026-02-28')
    expect(lastDayOf(validToOf('2026-10-14'))).toBe('2026-10-14')
  })

  it('where an agreed price stands today, and that only one in effect after today can be ended', () => {
    const today = '2026-10-14'
    expect(agreementState({ validFrom: '2026-10-01', validTo: '2027-01-01' }, today)).toBe('IN_EFFECT')
    expect(agreementState({ validFrom: '2026-10-01', validTo: '2026-10-15' }, today)).toBe('LAST_DAY')
    expect(agreementState({ validFrom: '2026-11-01', validTo: '2027-01-01' }, today)).toBe('UPCOMING')
    expect(canEndAgreement({ validFrom: '2026-10-01', validTo: '2027-01-01' }, today)).toBe(true)
    expect(canEndAgreement({ validFrom: '2026-10-01', validTo: '2026-10-15' }, today)).toBe(false)
    expect(canEndAgreement({ validFrom: '2026-11-01', validTo: '2027-01-01' }, today)).toBe(false)
  })

  it('the item form says what is missing before it is sent; editing opens with the saved values as baht text', () => {
    expect(itemFormErrors(itemFormValues(null), true)).toEqual({ code: 'CODE', nameTh: 'NAME', uom: 'UOM', categoryCode: 'CATEGORY', refUnitPrice: 'PRICE' })
    const values = { ...itemFormValues(null), code: 'CEM-01', nameTh: 'ปูน', uom: 'ถุง', categoryCode: 'CEMENT', refUnitPrice: '1,250.50' }
    expect(itemFormErrors(values, true)).toEqual({})
    expect(itemFormErrors({ ...values, code: 'cem 01' }, true)).toEqual({ code: 'CODE' })
    const saved = itemFormValues({ ...CEMENT, isService: false, accountCode: null, whtIncomeType: null, active: false, agreements: [] })
    expect(saved).toMatchObject({ code: 'CEM-01', nameEn: 'Cement 50 kg', refUnitPrice: '180.00', accountCode: '', active: false })
  })

  it('the agreed-price form wants a supplier, a price above zero and a period in order that is not over', () => {
    const today = '2026-10-14'
    const ok = { supplierId: SUP_A, unitPrice: '165.50', validFrom: today, lastDay: '2026-12-31', sourceRef: '' }
    expect(agreementFormErrors(ok, today)).toEqual({})
    expect(agreementFormErrors({ ...ok, supplierId: '', unitPrice: '0.00' }, today)).toEqual({ supplierId: 'SUPPLIER', unitPrice: 'PRICE_ZERO' })
    expect(agreementFormErrors({ ...ok, lastDay: '2026-10-01' }, today)).toEqual({ lastDay: 'INVALID_PERIOD' })
    expect(agreementFormErrors({ ...ok, validFrom: '2026-01-01', lastDay: '2026-10-13' }, today)).toEqual({ lastDay: 'PERIOD_OVER' })
    expect(agreementFormErrors({ ...ok, unitPrice: '12.345', lastDay: '' }, today)).toEqual({ unitPrice: 'PRICE', lastDay: 'DATE' })
  })

  it('a refusal of the service is said in words, beside the field it is about when there is one', () => {
    const overlap = toCatalogFailure({ code: 'VALIDATION_FAILED', details: { reason: 'AGREEMENT_OVERLAP' } })
    expect([catalogErrorKey(overlap), catalogErrorField(overlap)]).toEqual(['AGREEMENT_OVERLAP', null])
    const over = toCatalogFailure({ code: 'VALIDATION_FAILED', details: { field: 'validTo', reason: 'PERIOD_OVER' } })
    expect([catalogErrorKey(over), catalogErrorField(over)]).toEqual(['PERIOD_OVER', 'lastDay'])
    const exists = toCatalogFailure({ code: 'VALIDATION_FAILED', details: { field: 'code', reason: 'CODE_EXISTS' } })
    expect([catalogErrorKey(exists), catalogErrorField(exists)]).toEqual(['CODE_EXISTS', 'code'])
    const supplier = toCatalogFailure({ code: 'VALIDATION_FAILED', details: { field: 'supplierId', reason: 'UNKNOWN' } })
    expect([catalogErrorKey(supplier), catalogErrorField(supplier)]).toEqual(['SUPPLIER_UNKNOWN', 'supplierId'])
    expect(catalogErrorKey(toCatalogFailure({ code: 'INVALID_STATE_TRANSITION', details: { reason: 'AGREEMENT_NOT_STARTED' } }))).toBe('AGREEMENT_NOT_STARTED')
    expect(catalogErrorKey(toCatalogFailure({ code: 'VALIDATION_FAILED', details: { reason: 'NO_CHANGE' } }))).toBe('NO_CHANGE')
    expect(catalogErrorKey(toCatalogFailure({ code: 'FORBIDDEN' }))).toBe('FORBIDDEN')
    expect(catalogErrorKey(toCatalogFailure({ code: 'IDEMPOTENCY_CONFLICT' }))).toBe('BUSY')
  })
})

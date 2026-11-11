import { describe, expect, it } from 'vitest'
import { catalogPickOf, type CatalogPick } from '@/ui/request-form/catalog-lines'
import { targetOfFailure, targetOfProblem } from '@/ui/request-form/form-steps'
import { draftPayload, formReducer, initialValues, problemStep, type FormValues } from '@/ui/request-form/model'
import { failureKey, failureStep, toFormFailure } from '@/ui/request-form/outcome'
import { lastPreferredDay, lineCategories, preferredProblems, preferredState, preferredToSuggest, showsPreferredReason } from '@/ui/request-form/preferred'
import type { CatalogItemOption, PreferredSupplierOption, RequestFormData } from '@/ui/request-form/types'
import { endReasonReady, newPreferredErrors, preferredErrorField, preferredErrorKey, toPreferredFailure } from '@/ui/sourcing/preferred-model'

// S10-13 on screen (BR-FORM-02 BR-FORM-12 BR-RFX-14 · FR-SRC-204 AC7): the request form fills the preferred supplier of a
// catalogue line's category before the supplier of its lowest agreed price, labels it, warns when the requester chooses
// another (or none) and asks the reason before sending — unless every preferred supplier of the category is risk-exempt.
// Pure; the server checks the same at submit (tests/integration/sourcing-preferred.test.ts).

const SUP_A = '00000000-0000-4000-8000-00000000000a'
const SUP_B = '00000000-0000-4000-8000-00000000000b'
const SUP_C = '00000000-0000-4000-8000-00000000000c'
const ITEM = '00000000-0000-4000-8000-000000000101'
const SAND_ITEM = '00000000-0000-4000-8000-000000000102'

const CEMENT: CatalogItemOption = {
  id: ITEM,
  code: 'CEM-01',
  nameTh: 'ปูนซีเมนต์ 50 กก.',
  nameEn: null,
  uom: 'ถุง',
  categoryCode: 'CEMENT',
  refUnitPriceSatang: '18000',
  // the lowest agreed price is with B: without a preferred supplier the form would suggest B (S6-10)
  agreements: [
    { supplierId: SUP_A, supplierCode: 'A', supplierName: 'ร้าน ก', unitPriceSatang: '16550' },
    { supplierId: SUP_B, supplierCode: 'B', supplierName: 'ร้าน ข', unitPriceSatang: '15900' },
  ],
}
const SAND: CatalogItemOption = { id: SAND_ITEM, code: 'SAND', nameTh: 'ทราย', nameEn: null, uom: 'คิว', categoryCode: 'SAND', refUnitPriceSatang: '50000', agreements: [] }

const preferred = (supplierId: string, more: Partial<PreferredSupplierOption> = {}): PreferredSupplierOption => ({
  id: `p-${supplierId.slice(-1)}`,
  categoryCode: 'CEMENT',
  supplierId,
  supplierCode: supplierId.slice(-1).toUpperCase(),
  supplierName: 'ร้าน',
  awardNumber: 'AWD-2569-00001',
  validTo: '2027-11-09',
  risk: null,
  riskExempt: false,
  ...more,
})

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
const sand: CatalogPick = catalogPickOf(SAND)
const pick = (v: FormValues, item: CatalogPick, key = 'line-0') => formReducer(v, { type: 'pickCatalog', key, item, offered: OFFERED })

describe('[FR-SRC-204/AC7] the form fills the preferred supplier of the category before anything else (BR-FORM-02)', () => {
  it('an item of a category with a preferred supplier suggests it, not the lowest agreed price, and takes its agreed price', () => {
    const v = pick(initialValues(formData({ preferredSuppliers: [preferred(SUP_A)] })), cement)
    expect(v.suggestedSupplierId).toBe(SUP_A)
    expect(v.lines[0]).toMatchObject({ unitPrice: '165.50', catalogItemId: ITEM })
    expect(preferredState(v)).toMatchObject({ kept: [{ supplierId: SUP_A }], left: [], asksReason: false })
    // without one the lowest agreed price is suggested as before (S6-10)
    expect(pick(initialValues(formData()), cement).suggestedSupplierId).toBe(SUP_B)
  })

  it('several preferred suppliers of a category: the first the server sends (latest validFrom) that the form offers', () => {
    const values = { preferred: [preferred('00000000-0000-4000-8000-0000000000ff'), preferred(SUP_C), preferred(SUP_A)] }
    expect(preferredToSuggest(values, 'CEMENT', OFFERED)).toBe(SUP_C)
    expect(preferredToSuggest(values, 'SAND', OFFERED)).toBeNull()
  })

  it('a supplier the requester chose already stays; only the category tells the form', () => {
    let v = formReducer(initialValues(formData({ preferredSuppliers: [preferred(SUP_A)] })), { type: 'suggestedSupplier', value: SUP_C })
    v = pick(v, cement)
    expect(v.suggestedSupplierId).toBe(SUP_C)
    expect(lineCategories(v)).toEqual(['CEMENT'])
    // a line typed freely has no category
    expect(lineCategories(formReducer(v, { type: 'unlinkCatalog', key: 'line-0' }))).toEqual([])
  })
})

describe('[FR-SRC-204/AC7] another supplier warns and needs the reason before sending (BR-FORM-12)', () => {
  const opened = () => pick(initialValues(formData({ preferredSuppliers: [preferred(SUP_A)] })), cement)

  it('changing or clearing the supplier leaves the preferred one: warned, the reason asked, kept in its own field of the save', () => {
    for (const value of [SUP_C, '']) {
      const v = formReducer(opened(), { type: 'suggestedSupplier', value })
      expect(preferredState(v)).toMatchObject({ kept: [], left: [{ supplierId: SUP_A, awardNumber: 'AWD-2569-00001' }], asksReason: true })
      expect(preferredProblems(v)).toEqual([{ kind: 'PREFERRED_REASON' }])
      expect(showsPreferredReason(v)).toBe(true)
      const given = formReducer(v, { type: 'preferredReason', value: '  ร้าน ก ไม่มีของ  ' })
      expect(preferredProblems(given)).toEqual([])
      expect(draftPayload(given, 'ซื้อของ', true).draft).toMatchObject({ preferredSupplierOverrideReason: 'ร้าน ก ไม่มีของ' })
      // the reason of BR-PRC-06 is another field, asked by its own rule
      expect(draftPayload(given, 'ซื้อของ', true).draft.offAgreementReason).toBeUndefined()
    }
  })

  it('a saved draft clears a reason taken away; a form without the catalogue (LIFF) says nothing of it', () => {
    const v = initialValues(formData({ preferredSuppliers: [preferred(SUP_A)], draft: { requestId: 'r', version: 1, status: 'DRAFT', title: 'ปูน', budgetLineId: null, priceIncludesVat: false, formData: {}, lines: [], quotations: [], nonLowestQuoteReason: '', attachments: [], returnReason: null, preferredSupplierOverrideReason: 'เดิม' } }))
    expect(v.preferredSupplierOverrideReason).toBe('เดิม')
    expect(draftPayload(formReducer(v, { type: 'preferredReason', value: ' ' }), 'ซื้อของ', false).draft).toMatchObject({ preferredSupplierOverrideReason: null })
    const liff = initialValues({ ...formData({ preferredSuppliers: [preferred(SUP_A)] }), catalogItems: undefined })
    expect(liff.preferred).toBeUndefined()
    expect('preferredSupplierOverrideReason' in draftPayload(liff, 'ซื้อของ', false).draft).toBe(false)
  })

  it('every preferred supplier of the category at risk (RISK on): warned, the reason not asked; one of them clean: asked', () => {
    const atRisk = preferred(SUP_A, { risk: { tier: 'HIGH', status: 'OVERDUE', registryFlag: 'NONE' }, riskExempt: true })
    const v = formReducer(pick(initialValues(formData({ preferredSuppliers: [atRisk] })), cement), { type: 'suggestedSupplier', value: SUP_C })
    expect(preferredState(v)).toMatchObject({ left: [{ supplierId: SUP_A, riskExempt: true }], asksReason: false })
    expect(preferredProblems(v)).toEqual([])
    const mixed = formReducer(pick(initialValues(formData({ preferredSuppliers: [atRisk, preferred(SUP_B)] })), cement), { type: 'suggestedSupplier', value: SUP_C })
    expect(preferredState(mixed).asksReason).toBe(true)
    // choosing the other preferred supplier of the category keeps to it
    expect(preferredState(formReducer(mixed, { type: 'suggestedSupplier', value: SUP_B }))).toMatchObject({ kept: [{ supplierId: SUP_B }], left: [], asksReason: false })
  })

  it('lines of two categories: each is checked on its own', () => {
    let v = initialValues(formData({ preferredSuppliers: [preferred(SUP_A), preferred(SUP_B, { categoryCode: 'SAND', awardNumber: null })] }))
    v = pick(v, cement)
    v = formReducer(v, { type: 'addLine', key: 'line-1' })
    v = pick(v, sand, 'line-1')
    expect(preferredState(v)).toMatchObject({ kept: [{ supplierId: SUP_A }], left: [{ supplierId: SUP_B, categoryCode: 'SAND', awardNumber: null }], asksReason: true })
  })

  it('the problem and the server\'s refusal both lead to the supplier on the documents step; the last day shown is the day before validTo', () => {
    expect(problemStep({ kind: 'PREFERRED_REASON' })).toBe('documents')
    expect(targetOfProblem({ kind: 'PREFERRED_REASON' })).toEqual({ section: 'supplier' })
    const refused = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'preferredSupplierOverrideReason', reason: 'PREFERRED_OVERRIDE_REASON' } })
    expect(failureKey(refused)).toBe('PREFERRED_OVERRIDE_REASON')
    expect(failureStep(refused)).toBe('documents')
    expect(targetOfFailure(refused)).toEqual({ section: 'supplier' })
    expect([lastPreferredDay('2027-11-09'), lastPreferredDay('2028-03-01')]).toEqual(['2027-11-08', '2028-02-29'])
  })
})

describe('[FR-SRC-204/AC6] the page /suppliers/preferred: the set form and the refusals in words', () => {
  it('the set form asks a category, a supplier, a first day from today, a last day not before it, and a reason', () => {
    const base = { categoryCode: 'CEMENT', supplierId: SUP_A, validFrom: '2026-11-09', lastDay: '', note: 'สัญญาปี 2570' }
    expect(newPreferredErrors(base, '2026-11-09')).toEqual({})
    expect(newPreferredErrors({ ...base, categoryCode: '', supplierId: '', note: 'ab' }, '2026-11-09')).toEqual({ categoryCode: 'CATEGORY', supplierId: 'SUPPLIER', note: 'REASON' })
    expect(newPreferredErrors({ ...base, validFrom: '2026-11-08' }, '2026-11-09')).toEqual({ validFrom: 'PERIOD_PAST' })
    expect(newPreferredErrors({ ...base, lastDay: '2026-11-08' }, '2026-11-09')).toEqual({ lastDay: 'PERIOD' })
    expect(newPreferredErrors({ ...base, lastDay: '2026-11-09' }, '2026-11-09')).toEqual({})
  })

  it('each refusal has its words and, where it is about one, its field', () => {
    const say = (error: { code: string; details?: Record<string, unknown> }) => {
      const f = toPreferredFailure(error)
      return [preferredErrorKey(f), preferredErrorField(f)]
    }
    expect(say({ code: 'PREFERRED_OVERLAP', details: { validTo: '2027-11-09', lastDay: '2027-11-08' } })).toEqual(['OVERLAP', null])
    expect(say({ code: 'VALIDATION_FAILED', details: { field: 'supplierId', reason: 'UNKNOWN' } })).toEqual(['SUPPLIER_UNKNOWN', 'supplierId'])
    expect(say({ code: 'VALIDATION_FAILED', details: { field: 'categoryCode', reason: 'UNKNOWN' } })).toEqual(['CATEGORY_UNKNOWN', 'categoryCode'])
    expect(say({ code: 'VALIDATION_FAILED', details: { field: 'validFrom', reason: 'PERIOD_PAST' } })).toEqual(['PERIOD_PAST', 'validFrom'])
    expect(say({ code: 'VALIDATION_FAILED', details: { field: 'validTo', reason: 'PERIOD' } })).toEqual(['PERIOD', 'lastDay'])
    expect(say({ code: 'INVALID_STATE_TRANSITION', details: { reason: 'EXPIRED' } })).toEqual(['EXPIRED', null])
    expect(say({ code: 'INVALID_STATE_TRANSITION', details: { reason: 'ALREADY_ENDED' } })).toEqual(['ALREADY_ENDED', null])
    expect(say({ code: 'MODULE_DISABLED' })).toEqual(['MODULE_DISABLED', null])
    expect(say({ code: 'FORBIDDEN' })).toEqual(['FORBIDDEN', null])
    expect(endReasonReady('  ab ')).toBe(false)
    expect(endReasonReady('ไม่ใช้')).toBe(true)
  })
})

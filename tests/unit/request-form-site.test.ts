import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
import { loadSeedForms } from '@/server/seed/forms'
import { draftPayload, droppedChoice, formReducer, initialValues } from '@/ui/request-form/model'
import { failureKey, failureStep, toFormFailure } from '@/ui/request-form/outcome'
import type { RequestDraft, RequestFormData } from '@/ui/request-form/types'

// FR-INT-003 AC1 on the screen (S4-02, BR-FORM-02): a new purchase form opens with the delivery site the server chose,
// a draft with the site and supplier it saved (one closed since is chosen again), and every save carries them — a
// cleared one as null. A refusal because a site closed or a supplier was deactivated says so and leads to its step.

const SITES = [
  { id: 'site-a', code: 'SITE-A', name: 'ไซต์ A', address: 'ไซต์ก่อสร้าง A' },
  { id: 'site-b', code: 'SITE-B', name: 'ไซต์ B', address: null },
]
const SUPPLIERS = [{ id: 'sup-1', code: 'S1', name: 'บริษัท ก จำกัด' }]

function dataOf(code: string, overrides: Partial<RequestFormData> = {}): RequestFormData {
  const f = loadSeedForms().get(code)!
  return {
    type: { code, name: code, description: null, documentType: code === 'NEW_SUPPLIER' ? 'SUPPLIER_REQUEST' : 'PURCHASE_REQUEST' },
    form: { fields: f.fields, visibility: f.visibility, rules: f.rules, lines: f.lines },
    requesterDepartmentName: 'ฝ่ายก่อสร้าง',
    budgetLines: [],
    defaultBudgetLineId: null,
    vatRateBp: 700,
    attachmentKinds: ['OTHER'],
    deliverySites: SITES,
    defaultDeliverySiteId: 'site-b',
    suppliers: SUPPLIERS,
    draft: null,
    ...overrides,
  }
}

const saved = (extra: Partial<RequestDraft>): RequestDraft => ({
  requestId: 'r',
  version: 1,
  status: 'DRAFT',
  title: 'ร่าง',
  budgetLineId: null,
  priceIncludesVat: false,
  formData: {},
  lines: [],
  quotations: [],
  nonLowestQuoteReason: '',
  attachments: [],
  returnReason: null,
  ...extra,
})

describe('[FR-INT-003/AC1] the form opens with the delivery site and keeps the requester’s changes', () => {
  it('a new purchase form takes the site the server chose; the requester changes it or leaves it open', () => {
    const v = initialValues(dataOf('BUY_GOODS'))
    expect(v).toMatchObject({ deliverySiteId: 'site-b', suggestedSupplierId: '' })
    // The first save creates the draft with the site; no supplier is sent until one is chosen
    expect(draftPayload(v, 'ซื้อของ', true).draft).toMatchObject({ deliverySiteId: 'site-b' })
    expect(draftPayload(v, 'ซื้อของ', true).draft).not.toHaveProperty('suggestedSupplierId')
    const changed = formReducer(formReducer(v, { type: 'deliverySite', value: 'site-a' }), { type: 'suggestedSupplier', value: 'sup-1' })
    expect(draftPayload(changed, 'ซื้อของ', false).draft).toMatchObject({ deliverySiteId: 'site-a', suggestedSupplierId: 'sup-1' })
    // Cleared on a saved draft: sent as null so the server clears it too
    const cleared = formReducer(formReducer(changed, { type: 'deliverySite', value: '' }), { type: 'suggestedSupplier', value: '' })
    expect(draftPayload(cleared, 'ซื้อของ', false).draft).toMatchObject({ deliverySiteId: null, suggestedSupplierId: null })
    // A default the form does not offer is not used; a new-supplier request has no site
    expect(initialValues(dataOf('BUY_GOODS', { defaultDeliverySiteId: 'gone' })).deliverySiteId).toBe('')
    expect(initialValues(dataOf('NEW_SUPPLIER')).deliverySiteId).toBe('')
  })

  it('a draft opens with what it saved, even "not chosen"; a site or supplier closed since is chosen again', () => {
    expect(initialValues(dataOf('BUY_GOODS', { draft: saved({ deliverySiteId: 'site-a', suggestedSupplierId: 'sup-1' }) }))).toMatchObject({ deliverySiteId: 'site-a', suggestedSupplierId: 'sup-1' })
    expect(initialValues(dataOf('BUY_GOODS', { draft: saved({ deliverySiteId: null }) })).deliverySiteId).toBe('')
    const gone = dataOf('BUY_GOODS', { draft: saved({ deliverySiteId: 'site-x', suggestedSupplierId: 'sup-9' }) })
    expect(initialValues(gone)).toMatchObject({ deliverySiteId: '', suggestedSupplierId: '' })
    expect(droppedChoice('site-x', SITES)).toBe(true)
    expect(droppedChoice('site-a', SITES)).toBe(false)
    expect(droppedChoice(null, SITES)).toBe(false)
  })

  it('a refusal for a closed site or a deactivated supplier names it and leads to the step that fixes it', () => {
    const site = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'deliverySiteId', reason: 'UNKNOWN' } })
    const supplier = toFormFailure({ code: 'VALIDATION_FAILED', details: { field: 'suggestedSupplierId', reason: 'UNKNOWN' } })
    expect([failureKey(site), failureStep(site)]).toEqual(['SITE_UNKNOWN', 'items'])
    expect([failureKey(supplier), failureStep(supplier)]).toEqual(['SUPPLIER_UNKNOWN', 'documents'])
    for (const locale of [th, en]) {
      expect(locale.requestForm.errors.SITE_UNKNOWN).toBeTruthy()
      expect(locale.requestForm.errors.SUPPLIER_UNKNOWN).toBeTruthy()
    }
  })
})

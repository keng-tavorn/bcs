import { describe, expect, it } from 'vitest'
import { aiSentMark, aiUnsent, draftPayload, emptyQuotation, formReducer, type FormValues } from '@/ui/request-form/model'

// S13-07 (FR-AI-303 AC1 AC3, BR-AI-17): the request form keeps what the Document Agent put into a quotation until the
// requester confirmed it, and its saves tell the server — one AI reading per save, only with its quotation.

const base: FormValues = {
  title: 'ปูน',
  budgetLineId: '',
  deliverySiteId: '',
  suggestedSupplierId: '',
  priceIncludesVat: false,
  fields: {},
  lines: [],
  quotations: [{ ...emptyQuotation('q1'), fileId: 'f1', fileName: 'quote.pdf' }],
  nonLowestQuoteReason: '',
}
const review = {
  agentActionId: 'a1',
  proposed: { 'quotations.f1.supplierName': 'บริษัท ก', 'quotations.f1.supplierId': 's1', 'quotations.f1.amount': '1500.00', 'quotations.f1.includesVat': 'false' },
  requiredPaths: ['quotations.f1.amount', 'quotations.f1.supplierId'],
  confirmed: [],
}

describe('[FR-AI-303/AC3] the quotation the AI filled waits for the requester, and the saves carry what they confirmed', () => {
  const filled = formReducer(base, { type: 'aiFilled', key: 'q1', review, patch: { supplierName: 'บริษัท ก', supplierId: 's1', amount: '1500.00', includesVat: false } })

  it('takes the values in with their AI reading; the first save tells the server, with nothing confirmed yet', () => {
    expect(filled.quotations[0]).toMatchObject({ supplierName: 'บริษัท ก', supplierId: 's1', amount: '1500.00', ai: review })
    const save = draftPayload(filled, 'ขอซื้อ', false, new Map())
    expect(save.draft.quotations).toEqual([{ supplierName: 'บริษัท ก', supplierId: 's1', amount: '1500.00', includesVat: false, fileId: 'f1', selected: false }])
    expect(save.draft.aiAssist).toEqual({ agentActionId: 'a1', confirmedPaths: [] })
    expect(save.ai).toEqual({ agentActionId: 'a1', mark: '[]' })
  })

  it('sends a reading again only when the requester confirmed more since', () => {
    const sent = new Map([['a1', aiSentMark(filled.quotations[0]!.ai!)]])
    expect(aiUnsent(filled, sent)).toBe(false)
    expect(draftPayload(filled, 'ขอซื้อ', false, sent).draft).not.toHaveProperty('aiAssist')
    const confirmed = formReducer(filled, { type: 'aiConfirm', key: 'q1', paths: ['quotations.f1.amount', 'quotations.f1.supplierId'], checked: true })
    expect(aiUnsent(confirmed, sent)).toBe(true)
    expect(draftPayload(confirmed, 'ขอซื้อ', false, sent).draft.aiAssist).toEqual({ agentActionId: 'a1', confirmedPaths: ['quotations.f1.amount', 'quotations.f1.supplierId'] })
    const undone = formReducer(confirmed, { type: 'aiConfirm', key: 'q1', paths: ['quotations.f1.amount'], checked: false })
    expect(undone.quotations[0]!.ai!.confirmed).toEqual(['quotations.f1.supplierId'])
    // Another quotation or one without an AI reading is left as it is
    expect(formReducer(confirmed, { type: 'aiConfirm', key: 'other', paths: ['x'], checked: true })).toEqual(confirmed)
  })

  it('another name typed is another supplier: the register supplier goes', () => {
    const typed = formReducer(filled, { type: 'quotation', key: 'q1', patch: { supplierName: 'ร้าน ข' } })
    expect(typed.quotations[0]).toMatchObject({ supplierName: 'ร้าน ข', supplierId: null })
    expect(formReducer(filled, { type: 'quotation', key: 'q1', patch: { amount: '1600' } }).quotations[0]!.supplierId).toBe('s1')
  })

  it('says nothing of AI readings when the form shows none (LIFF) or while the quotation cannot be saved', () => {
    expect(draftPayload(filled, 'ขอซื้อ', false).draft).not.toHaveProperty('aiAssist')
    const unsaved = formReducer(filled, { type: 'quotation', key: 'q1', patch: { amount: 'abc' } })
    expect(draftPayload(unsaved, 'ขอซื้อ', false, new Map()).ai).toBeNull()
    expect(aiUnsent(unsaved, new Map())).toBe(false)
  })
})

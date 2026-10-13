import { describe, expect, it } from 'vitest'
import { presentAiResult } from '@/app/_lib/ai-present'
import type { AgentActionDto } from '@/server/services/ai'

const base: AgentActionDto = {
  id: 'a1',
  agent: 'DOCUMENT',
  purpose: 'DELIVERY_NOTE_READ',
  level: 'L1',
  status: 'DRAFT',
  subjectType: 'PURCHASE_ORDER',
  subjectId: 'po1',
  requestedById: 'm1',
  channel: 'WEB',
  promptVersion: 'DELIVERY_NOTE_READ@1',
  model: 'claude-sonnet-5-5',
  errorCode: null,
  costCredits: 12,
  latencyMs: 900,
  createdAt: '2026-10-05T03:00:00.000Z',
  content: {
    inputText: null,
    output: {
      reading: { docNo: 'DN-1', docDate: '2026-10-04', seller: { name: 'ร้าน', taxId: '0999999000012', branch: '00000' }, priceIncludesVat: null, net: null, vat: null, gross: null, lines: [{ description: 'ท่อ', qty: '10', unit: 'ชิ้น', unitPrice: null, amount: null }, 'not a line'] },
      mapping: { flags: [{ code: 'PO_LINE_UNKNOWN', dnLine: 2 }, { code: 'OVER_OPEN', lineNo: 1 }, { code: 'DUPLICATE_PO_LINE' }, 'SUPPLIER_NOT_REGISTERED', { nothing: true }] },
    },
    verification: { fail: ['SELLER_MATCH'], warn: ['DOC_DATE_OLD', 7] },
    fieldConfidence: {},
    review: { proposed: { 'lines.x.received': '10', 'lines.y.received': 3 }, requiredPaths: ['lines.x.received'], confirmedPaths: [] },
    diff: null,
  },
}

describe('[FR-AI-303/AC1] the screen gets what was read, what is proposed and what the checks found', () => {
  it('turns an AgentAction into the view of its screen', () => {
    const view = presentAiResult(base)
    expect(view).toMatchObject({ id: 'a1', status: 'DRAFT', errorCode: null, proposed: { 'lines.x.received': '10' }, requiredPaths: ['lines.x.received'] })
    expect(view.proposed).not.toHaveProperty('lines.y.received')
    expect(view.reading).toMatchObject({ docNo: 'DN-1', sellerTaxId: '0999999000012', priceIncludesVat: null, lines: [{ description: 'ท่อ', qty: '10' }, { description: null }] })
    expect(view.notes).toEqual([
      { code: 'SELLER_MATCH', tone: 'danger' },
      { code: 'DOC_DATE_OLD', tone: 'warning' },
      { code: 'PO_LINE_UNKNOWN', tone: 'info', line: 3 },
      { code: 'OVER_OPEN', tone: 'warning', line: 1 },
      { code: 'DUPLICATE_PO_LINE', tone: 'info' },
      { code: 'SUPPLIER_NOT_REGISTERED', tone: 'info' },
    ])
  })
  it('shows nothing of the content to whoever does not get it, and a failed read by its code', () => {
    expect(presentAiResult({ ...base, status: 'FAILED', errorCode: 'FIXTURE_MISSING', content: null })).toEqual({ id: 'a1', status: 'FAILED', errorCode: 'FIXTURE_MISSING', proposed: {}, requiredPaths: [], reading: null, notes: [] })
    const empty = presentAiResult({ ...base, content: { ...base.content!, output: { reading: { seller: null, priceIncludesVat: true } }, verification: null, review: null } })
    expect(empty).toMatchObject({ proposed: {}, requiredPaths: [], notes: [], reading: { sellerName: null, priceIncludesVat: true, lines: [] } })
    expect(presentAiResult({ ...base, content: { ...base.content!, output: null } }).reading).toBeNull()
  })
})

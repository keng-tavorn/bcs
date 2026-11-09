import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
import { poErrorKey, toPoFailure } from '@/ui/purchase-order/outcome'

// S11-07 (FR-RSK-203 AC6 · §9.9 rule 7): the risk gate's refusal on the PO page is said by its reason, in Thai and English,
// never as its code; the reason a warning needs has its own words.

const REASONS = ['NOT_ASSESSED', 'IN_PROGRESS', 'SCOPE_EXPANDED', 'VALIDITY_LAPSED', 'REGISTRY_CEASED', 'REGISTRY_FLAGGED', 'OVERRIDE_EXPIRED', 'OVERRIDE_CAP_EXCEEDED'] as const
const CODE_OF: Record<(typeof REASONS)[number], string> = {
  NOT_ASSESSED: 'RISK_ASSESSMENT_REQUIRED',
  IN_PROGRESS: 'RISK_ASSESSMENT_REQUIRED',
  SCOPE_EXPANDED: 'RISK_REASSESSMENT_REQUIRED',
  VALIDITY_LAPSED: 'RISK_REASSESSMENT_REQUIRED',
  REGISTRY_CEASED: 'RISK_BLOCKED',
  REGISTRY_FLAGGED: 'RISK_BLOCKED',
  OVERRIDE_EXPIRED: 'RISK_BLOCKED',
  OVERRIDE_CAP_EXCEEDED: 'RISK_BLOCKED',
}

describe('[FR-RSK-203/AC6] the PO page words the risk gate', () => {
  it('maps each refusal to the words of its reason, in both languages', () => {
    for (const reason of REASONS) {
      const key = poErrorKey(toPoFailure({ code: CODE_OF[reason], details: { reason, tier: 'HIGH', supplierId: 'x' } }))
      expect(key).toBe(`RISK_${reason}`)
      expect(th.purchaseOrder.errors[key as keyof typeof th.purchaseOrder.errors]).toEqual(expect.any(String))
      expect(en.purchaseOrder.errors[key as keyof typeof en.purchaseOrder.errors]).toEqual(expect.any(String))
      expect(th.purchaseOrder.risk.band.reason[reason]).toEqual(expect.any(String))
      expect(en.purchaseOrder.risk.band.reason[reason]).toEqual(expect.any(String))
    }
  })

  it('a reason the gate does not name is a plain failure; the missing reason of a warning has its words', () => {
    expect(poErrorKey(toPoFailure({ code: 'RISK_BLOCKED', details: { reason: 'SOMETHING_NEW' } }))).toBe('FAILED')
    expect(poErrorKey(toPoFailure({ code: 'VALIDATION_FAILED', details: { field: 'riskReason', reason: 'RISK_REASON_REQUIRED' } }))).toBe('RISK_REASON')
    expect(poErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'riskReason' })).toBe('RISK_REASON')
  })

  it('names every tier, source, trigger and warning of a stored gate in both languages', () => {
    for (const m of [th, en]) {
      for (const k of ['LOW', 'MEDIUM', 'HIGH'] as const) expect(m.purchaseOrder.risk.tier[k]).toEqual(expect.any(String))
      for (const k of ['NOT_REQUIRED', 'ASSESSMENT', 'OVERRIDE'] as const) expect(m.purchaseOrder.risk.source[k]).toEqual(expect.any(String))
      for (const k of ['SUBMIT', 'SEND', 'PO_CHANGE'] as const) expect(m.purchaseOrder.risk.trigger[k]).toEqual(expect.any(String))
      for (const k of ['REGISTRY_FLAGGED', 'REASSESSMENT_OVERDUE', 'OVERRIDE_USED'] as const) expect(m.purchaseOrder.risk.warning[k]).toEqual(expect.any(String))
    }
  })
})

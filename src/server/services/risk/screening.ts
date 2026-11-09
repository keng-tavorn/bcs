import type { Screening } from '@/core/risk'

// The screening of the work behind a PO or a request (BR-RSK-01): shared by the assessments (S11-05) and the gate before a
// PO (S11-07), kept apart so the gate needs nothing else of the assessments' service.

export const RISK_TIMEZONE = 'Asia/Bangkok'
export const SCREENING_KEYS = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const

/** Y wins: a screening field asked of several requests is Y when any of them says Y (FR-RSK-201 AC1) */
export function mergeScreening(forms: readonly unknown[]): Partial<Screening> {
  const out: Partial<Record<(typeof SCREENING_KEYS)[number], 'Y' | 'N'>> = {}
  for (const form of forms) {
    const f = (form && typeof form === 'object' ? form : {}) as Record<string, unknown>
    for (const k of SCREENING_KEYS) {
      if (f[k] === 'Y') out[k] = 'Y'
      else if (f[k] === 'N' && out[k] !== 'Y') out[k] = 'N'
    }
  }
  return out
}

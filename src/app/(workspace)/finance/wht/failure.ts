import type { TaxFailure } from '@/ui/wht/outcome'
import { day, type Locale } from '../../_tracking/present'

// A service error as the tax screens take it (S8-13): the code and the parts of its details they need — a
// RETENTION_NOT_DUE's date in the reader's language — never the raw message (spec §14.2).

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export function taxFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }, locale: Locale): TaxFailure {
  const d = error.details ?? {}
  if (error.code === 'RETENTION_NOT_DUE') return typeof d.date === 'string' && ISO_DAY.test(d.date) ? { ok: false, code: error.code, date: day(locale, d.date) } : { ok: false, code: error.code }
  return { ok: false, code: error.code }
}

export const invalid = (field: string): TaxFailure => ({ ok: false, code: 'VALIDATION_FAILED', field })
export const NO_SESSION: TaxFailure = { ok: false, code: 'UNAUTHENTICATED' }

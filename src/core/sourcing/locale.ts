// The language of an RFx (BR-FORM-11 · FR-INT-201 AC2 · ADR-208 · OQ-211): an RFx that invites a foreign supplier, or a
// contact who reads English, is in Thai and English (TH_EN), and an RFx in TH_EN has its English text — the title, the
// description, and each line's description and unit — before it opens. The customer types the English; nothing here
// translates. Pure: the service gives the RFx, its lines and its invitees.

export type RfxLocale = 'TH' | 'TH_EN'

/** Someone invited to an RFx: a supplier (or application) that is foreign, and the language of its contact */
export interface RfxInvitee {
  readonly isForeign: boolean
  readonly contactLocale: string
}

export interface BilingualRfx {
  readonly titleEn: string | null
  readonly descriptionEn: string | null
  readonly lines: ReadonlyArray<{ readonly lineNo: number; readonly descriptionEn: string | null; readonly uomEn: string | null }>
}

/** An invitee that reads the RFx in English: a foreign supplier, or a contact whose language is English */
export const readsEnglish = (invitee: RfxInvitee): boolean => invitee.isForeign || invitee.contactLocale === 'en'

/** The language the RFx must have for its invitees: TH_EN once one of them reads English */
export const requiredLocale = (invitees: readonly RfxInvitee[]): RfxLocale => (invitees.some(readsEnglish) ? 'TH_EN' : 'TH')

const blank = (text: string | null): boolean => !text || text.trim().length === 0

/** The English text a TH_EN RFx still lacks, as field paths (`titleEn`, `lines.2.uomEn`); empty when complete */
export function missingEnglish(rfx: BilingualRfx): string[] {
  const missing: string[] = []
  if (blank(rfx.titleEn)) missing.push('titleEn')
  if (blank(rfx.descriptionEn)) missing.push('descriptionEn')
  for (const l of [...rfx.lines].sort((a, b) => a.lineNo - b.lineNo)) {
    if (blank(l.descriptionEn)) missing.push(`lines.${l.lineNo}.descriptionEn`)
    if (blank(l.uomEn)) missing.push(`lines.${l.lineNo}.uomEn`)
  }
  return missing
}

export type LocaleCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'LOCALE_REQUIRED'; readonly required: RfxLocale; readonly missing: readonly string[] }

/**
 * Whether an RFx in `locale` may go to its invitees: an English reader needs TH_EN, and TH_EN needs its English text.
 * `complete` asks for the English text too (opening, or inviting once open); a draft may take an invitee while its
 * English is still being typed, so long as the RFx is TH_EN.
 */
export function checkRfxLocale(locale: RfxLocale, invitees: readonly RfxInvitee[], rfx: BilingualRfx, complete: boolean): LocaleCheck {
  const required = requiredLocale(invitees)
  if (required === 'TH_EN' && locale !== 'TH_EN') return { ok: false, reason: 'LOCALE_REQUIRED', required, missing: [] }
  if (complete && locale === 'TH_EN') {
    const missing = missingEnglish(rfx)
    if (missing.length) return { ok: false, reason: 'LOCALE_REQUIRED', required: 'TH_EN', missing }
  }
  return { ok: true }
}

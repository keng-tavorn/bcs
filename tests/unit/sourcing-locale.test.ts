import { describe, expect, it } from 'vitest'
import { checkRfxLocale, missingEnglish, readsEnglish, requiredLocale } from '@/core/sourcing'

// S10-17 (BR-FORM-11 · FR-INT-201 AC2): the language an RFx needs for its invitees, and the English it still lacks.

const thai = { isForeign: false, contactLocale: 'th' }
const foreign = { isForeign: true, contactLocale: 'th' }
const english = { isForeign: false, contactLocale: 'en' }
const full = { titleEn: 'Firewall', descriptionEn: 'Two sites', lines: [{ lineNo: 2, descriptionEn: 'Box', uomEn: 'set' }, { lineNo: 1, descriptionEn: 'Install', uomEn: 'job' }] }

describe('[FR-INT-201/AC2] the language of an RFx', () => {
  it('a foreign supplier or an English contact reads English; one of them makes the RFx TH_EN', () => {
    expect([thai, foreign, english].map(readsEnglish)).toEqual([false, true, true])
    expect(requiredLocale([])).toBe('TH')
    expect(requiredLocale([thai, thai])).toBe('TH')
    expect(requiredLocale([thai, english])).toBe('TH_EN')
  })

  it('missingEnglish lists blank English as field paths, lines in their order', () => {
    expect(missingEnglish(full)).toEqual([])
    expect(missingEnglish({ titleEn: ' ', descriptionEn: null, lines: [{ lineNo: 2, descriptionEn: 'Box', uomEn: null }, { lineNo: 1, descriptionEn: '', uomEn: 'job' }] })).toEqual([
      'titleEn',
      'descriptionEn',
      'lines.1.descriptionEn',
      'lines.2.uomEn',
    ])
  })

  it('checkRfxLocale: TH with an English reader is refused; TH_EN needs its English only when complete; TH needs no English', () => {
    expect(checkRfxLocale('TH', [thai], { titleEn: null, descriptionEn: null, lines: [] }, true)).toEqual({ ok: true })
    expect(checkRfxLocale('TH', [foreign], full, false)).toEqual({ ok: false, reason: 'LOCALE_REQUIRED', required: 'TH_EN', missing: [] })
    const half = { ...full, descriptionEn: null }
    expect(checkRfxLocale('TH_EN', [foreign], half, false)).toEqual({ ok: true })
    expect(checkRfxLocale('TH_EN', [foreign], full, true)).toEqual({ ok: true })
    expect(checkRfxLocale('TH_EN', [foreign], half, true)).toEqual({ ok: false, reason: 'LOCALE_REQUIRED', required: 'TH_EN', missing: ['descriptionEn'] })
    // TH_EN chosen without an English reader still opens with its English (BR-FORM-11)
    expect(checkRfxLocale('TH_EN', [thai], half, true)).toMatchObject({ ok: false, missing: ['descriptionEn'] })
  })
})

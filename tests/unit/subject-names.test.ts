import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LINK_SUBJECTS } from '../../src/app/(auth)/a/[token]/subjects'
import { SUBJECT_KIND, subjectKind } from '../../src/channels/line/flex/labels'
import { APPROVAL_SUBJECTS } from '../../src/core/sod'
import { SUBJECT_NAME } from '../../src/server/notifications/templates/sla'

// P1-07 (docs/sub-specs/P1.md "ป้ายและรายการ") and the P1-10 review: every subject of an approval route is named by its
// kind wherever a member reads about its task — the LINE card, the SLA notices and the e-mail link — never "เอกสาร"
// or "คำขอซื้อ" for a budget transfer, a PO change or a payment run.

const messages = (lang: 'th' | 'en') => JSON.parse(readFileSync(path.resolve(import.meta.dirname, `../../messages/src/${lang}/actionLink.json`), 'utf8')) as { subject: Record<string, string> }

describe('[FR-LINE-002/AC1] the kind of every approval subject in words (P1-07)', () => {
  it('the LINE card names each subject of APPROVAL_SUBJECTS in Thai and English', () => {
    for (const subject of APPROVAL_SUBJECTS) {
      expect(SUBJECT_KIND[subject], subject).toBeDefined()
      expect(subjectKind(subject, 'th'), subject).not.toBe('เอกสาร')
      expect(subjectKind(subject, 'en'), subject).not.toBe('Document')
    }
  })

  it('the SLA notices name each subject (typecheck holds the record to APPROVAL_SUBJECTS too)', () => {
    expect(Object.keys(SUBJECT_NAME).sort()).toEqual([...APPROVAL_SUBJECTS].sort())
  })

  it('the e-mail link page heads each subject with its own words, which both languages have', () => {
    expect([...LINK_SUBJECTS].sort()).toEqual([...APPROVAL_SUBJECTS].sort())
    for (const lang of ['th', 'en'] as const) {
      const words = messages(lang).subject
      for (const subject of LINK_SUBJECTS) expect(words[subject], `${lang} ${subject}`).toBeTruthy()
    }
  })
})

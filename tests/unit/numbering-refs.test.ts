import { describe, expect, it } from 'vitest'
import { formatDocumentNumber, numberPatternRegex } from '@/core/numbering'

// BR-AP-02: the invoice inbox proposes a PO from a number of the organization's numbering.PO pattern written in the
// subject or the file name of the mail.

const found = (pattern: string, text: string) => [...text.matchAll(numberPatternRegex(pattern))].map((m) => m[0])

describe('[BR-AP-02] numberPatternRegex finds the numbers of a pattern inside a text', () => {
  it('finds the default PO pattern in a subject and a file name, not inside a longer word or number', () => {
    expect(found('PO-{BE}-{SEQ5}', 'ใบแจ้งหนี้ตาม PO-2569-00012 และ PO-2569-00013')).toEqual(['PO-2569-00012', 'PO-2569-00013'])
    expect(found('PO-{BE}-{SEQ5}', 'PO-2569-00012.pdf')).toEqual(['PO-2569-00012'])
    expect(found('PO-{BE}-{SEQ5}', 'XPO-2569-00012 PO-2569-000123 PO-2569-0001')).toEqual(['PO-2569-000123'])
    expect(found('PO-{BE}-{SEQ5}', 'PO-2569-00012345')).toEqual(['PO-2569-00012345'])
  })

  it('every token, and the characters of a pattern taken literally', () => {
    const at = new Date('2026-10-12T03:00:00Z')
    for (const pattern of ['PO{YY}{MM}-{SEQ4}', '{CE}/{DEPT}/{SEQ3}', 'P.O.(1)+{SEQ2}']) {
      const number = formatDocumentNumber(pattern, { at, seq: 7, department: 'ENG' })
      expect(found(pattern, `see ${number} please`)).toEqual([number])
    }
    expect(found('P.O.(1)+{SEQ2}', 'PxO.(1)+07')).toEqual([])
  })

  it('refuses a pattern that is not one', () => {
    expect(() => numberPatternRegex('PO-{SEQ}')).toThrow(RangeError)
  })
})

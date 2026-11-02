import { describe, expect, it } from 'vitest'
import { contentMatchesType } from '@/lib/file-types'
import { scannedInvoicePdf } from '@/server/seed/etax-sample'

// The stand-in for a scanned invoice opens in the invoice's page (NEW-115), so it has to be a PDF a viewer accepts: a
// table of where each object starts that points at them, whatever the words on it take in bytes.

const decoder = new TextDecoder()

describe('[FR-AP-102/AC7] the sample of a scanned invoice', () => {
  const bytes = scannedInvoicePdf(['ผู้ขายหนึ่ง (จำกัด)', 'INV-001', '642.00'])
  const text = decoder.decode(bytes)
  const sliceFrom = (offset: number, length: number) => decoder.decode(bytes.slice(offset, offset + length))

  it('is recognised as a PDF and keeps every word, Thai too', () => {
    expect(contentMatchesType(bytes, 'application/pdf')).toBe(true)
    expect(text).toContain('% BCS synthetic invoice: ผู้ขายหนึ่ง  จำกัด  / INV-001 / 642.00')
  })

  it('draws only what its font can, and each word it draws is closed properly', () => {
    expect(text).toContain('(INV-001) Tj')
    expect(text).toContain('(642.00) Tj')
    expect(text).not.toMatch(/\([^)]*[฀-๿][^)]*\) Tj/)
  })

  it('every entry of its table points at its object, in bytes', () => {
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1])
    expect(sliceFrom(startxref, 4)).toBe('xref')
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
    expect(offsets).toHaveLength(5)
    offsets.forEach((offset, i) => expect(sliceFrom(offset, `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`))
  })

  it('states the true length of what it draws', () => {
    const length = Number(/\/Length (\d+)/.exec(text)![1])
    const start = text.indexOf('stream\n') + 'stream\n'.length
    expect(text.slice(start, text.indexOf('\nendstream'))).toHaveLength(length)
  })
})

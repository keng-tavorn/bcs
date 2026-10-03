import { describe, expect, it } from 'vitest'
import { decomposeSaraAm, thaiHyphenationCallback, thaiWords } from '@/server/pdf/thai-breaks'

// S4-05 (FR-PLT-009 AC3, ADR-044): where printed Thai may wrap. react-pdf only breaks at spaces, so Thai runs are cut
// into words with "" between them (a break without a hyphen); sara am never reaches the shaper as U+0E33. The pictures
// themselves are tests/integration/pdf-snapshot.test.ts.

const breaks = (word: string) => thaiHyphenationCallback(word).filter((p) => p !== '')

describe('[FR-PLT-009/AC3] Thai line breaks in printed documents', () => {
  it('cuts a long run without spaces between words, never inside one', () => {
    const pieces = thaiWords('ปูนซีเมนต์ปอร์ตแลนด์ประเภทหนึ่งสำหรับงานโครงสร้างคอนกรีตเสริมเหล็ก')
    expect(pieces.join('')).toBe('ปูนซีเมนต์ปอร์ตแลนด์ประเภทหนึ่งสำหรับงานโครงสร้างคอนกรีตเสริมเหล็ก')
    expect(pieces).toEqual(expect.arrayContaining(['สำหรับ', 'งาน', 'โครงสร้าง']))
    for (const piece of pieces) expect(piece, piece).not.toMatch(/^[ะ-ฺๅ็-๎]/)
  })

  it('never gives a syllable that ends a line with a hyphen: words come with "" between them', () => {
    const out = thaiHyphenationCallback('ห้าสิบกิโลกรัมส่งถึงหน้างาน')
    expect(out.length).toBeGreaterThan(2)
    out.forEach((piece, i) => expect(piece === '', `${i}: ${piece}`).toBe(i % 2 === 1))
    expect(out.join('')).toBe(decomposeSaraAm('ห้าสิบกิโลกรัมส่งถึงหน้างาน'))
  })

  it('never leaves a syllable that ends with mai han-akat, or a lone consonant, on its own (เมทัลชีท)', () => {
    const pieces = thaiWords('หลังคาเมทัลชีท')
    expect(pieces).toContain('เมทัล')
    expect(pieces).not.toContain('เมทั')
    expect(pieces).not.toContain('ล')
  })

  it('keeps closing marks, ๆ and ฯ with the word before, and opening marks with the word after', () => {
    const pieces = thaiWords('(ที่นั่งญี่ปุ่น)')
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces[0]).toMatch(/^\(.+/)
    expect(pieces.at(-1)).toMatch(/.+\)$/)
    expect(pieces).not.toContain('(')
    expect(pieces).not.toContain(')')
    expect(thaiWords('เด็กๆ')).toEqual(['เด็กๆ'])
    expect(thaiWords('กรุงเทพฯ')).toEqual(['กรุงเทพฯ'])
  })

  it('never lets sara am reach the shaper, and leaves other text alone', () => {
    for (const word of ['น้ำ', 'จำนวน', 'สำนักงาน', 'ค่ำ']) {
      const out = thaiHyphenationCallback(word).join('')
      expect(out).not.toContain('ำ')
      expect(out.normalize('NFC')).toBe(decomposeSaraAm(word))
    }
    expect(thaiHyphenationCallback('PO-2569-000123')).toEqual(['PO-2569-000123'])
    expect(thaiHyphenationCallback('')).toEqual([''])
    expect(thaiHyphenationCallback('  ')).toEqual(['  '])
    expect(breaks('ที่')).toEqual(['ที่'])
  })
})

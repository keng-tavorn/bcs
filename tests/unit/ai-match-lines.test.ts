import { describe, expect, it } from 'vitest'
import { matchPoLine } from '@/core/ai-checks/match-lines'

const po = [
  { lineNo: 1, description: 'ท่อ PPR 1 นิ้ว' },
  { lineNo: 2, description: 'ข้อต่อ PPR 1 นิ้ว' },
  { lineNo: 3, description: 'ปูนซีเมนต์' },
  { lineNo: 4, description: '' },
]

describe('[BR-AI-25] a delivery note line names a PO line by its words, in code', () => {
  it('takes the same words, spaces and case aside', () => {
    expect(matchPoLine('ท่อ  ppr 1 นิ้ว', po)).toBe(1)
    expect(matchPoLine('ข้อต่อ PPR 1 นิ้ว', po)).toBe(2)
  })
  it('takes the only PO line the words contain or that contains them', () => {
    expect(matchPoLine('ปูนซีเมนต์ปอร์ตแลนด์ประเภท 1 ถุง 50 กก.', po)).toBe(3)
    expect(matchPoLine('ข้อต่อ', po)).toBe(2)
  })
  it('names no line when none or more than one fits, or nothing was read', () => {
    expect(matchPoLine('PPR 1 นิ้ว', po)).toBeNull()
    expect(matchPoLine('หินคลุก', po)).toBeNull()
    expect(matchPoLine(null, po)).toBeNull()
    expect(matchPoLine('  ', po)).toBeNull()
    expect(matchPoLine('ท่อ PPR 1 นิ้ว', [...po, { lineNo: 5, description: 'ท่อ PPR 1 นิ้ว' }])).toBeNull()
  })
})

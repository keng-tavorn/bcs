import { describe, expect, it } from 'vitest'
import { csv, csvLine, utf8WithBom, windows874 } from '@/lib/encoding'

// BR-EXP-01 (OQ-10): the Express file in UTF-8 with a BOM or in Windows-874, as CSV lines with CRLF.

describe('[FR-P2P-009/AC1] Express files in the encodings Thai accounting programs read', () => {
  it('writes Thai in Windows-874 (TIS-620 plus the Windows additions) and refuses what it cannot hold', () => {
    expect([...windows874('ก ฮ ะ ๐ ๛ ฿')]).toEqual([0xa1, 0x20, 0xce, 0x20, 0xd0, 0x20, 0xf0, 0x20, 0xfb, 0x20, 0xdf])
    expect([...windows874('A1,€…')]).toEqual([0x41, 0x31, 0x2c, 0x80, 0x85])
    expect(() => windows874('漢')).toThrow(RangeError)
    expect(() => windows874('฻')).toThrow(/U\+0E3B/)
  })

  it('starts UTF-8 with a byte order mark', () => {
    expect([...utf8WithBom('ก')]).toEqual([0xef, 0xbb, 0xbf, 0xe0, 0xb8, 0x81])
  })

  it('quotes fields with commas, quotes or line breaks and ends lines with CRLF', () => {
    expect(csvLine(['a', 'b,c', 'say "hi"', 'x\ny'])).toBe('a,"b,c","say ""hi""","x\ny"')
    expect(csv([['h1', 'h2'], ['1', '2']])).toBe('h1,h2\r\n1,2\r\n')
  })
})

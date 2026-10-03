// Text files for Thai accounting software (spec BR-EXP-01, OQ-10): UTF-8 with a byte order mark, or Windows-874
// (TIS-620 with the Windows additions) which older Thai programs read. CSV fields are quoted when they hold a comma, a
// quote or a line break, and lines end with CRLF.

const BOM = [0xef, 0xbb, 0xbf]

/** Windows-874 bytes of the characters outside ASCII and the Thai block */
const WINDOWS_874_EXTRA: Readonly<Record<number, number>> = {
  0x20ac: 0x80, // €
  0x2026: 0x85, // …
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x00a0: 0xa0,
}
/** U+0E01–U+0E3A and U+0E3F–U+0E5B sit at 0xA1–0xDA and 0xDF–0xFB */
const THAI_OFFSET = 0x0d60
const ASCII_END = 0x80

export function utf8WithBom(text: string): Uint8Array {
  const body = new TextEncoder().encode(text)
  const out = new Uint8Array(BOM.length + body.length)
  out.set(BOM, 0)
  out.set(body, BOM.length)
  return out
}

/** Throws RangeError for a character Windows-874 cannot hold, rather than writing a wrong byte */
export function windows874(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < ASCII_END) out[i] = code
    else if ((code >= 0x0e01 && code <= 0x0e3a) || (code >= 0x0e3f && code <= 0x0e5b)) out[i] = code - THAI_OFFSET
    else if (WINDOWS_874_EXTRA[code] !== undefined) out[i] = WINDOWS_874_EXTRA[code]!
    else throw new RangeError(`U+${code.toString(16).toUpperCase().padStart(4, '0')} cannot be written in Windows-874`)
  }
  return out
}

const NEEDS_QUOTES = /[",\r\n]/

export function csvLine(fields: readonly string[]): string {
  return fields.map((f) => (NEEDS_QUOTES.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',')
}

export function csv(rows: readonly (readonly string[])[]): string {
  return rows.map(csvLine).join('\r\n') + '\r\n'
}

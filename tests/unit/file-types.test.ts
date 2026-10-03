import { describe, expect, it } from 'vitest'
import { checkDeclaredUpload, cleanFileName, contentMatchesType, MAX_UPLOAD_BYTES, mimeTypeFromName, sniffMimeType } from '@/lib/file-types'

const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(16).fill(0)].slice(0, 16))
const text = (s: string) => new Uint8Array([...Buffer.from(s, 'latin1'), ...new Array(16).fill(0)].slice(0, 16))
const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 24, ...Buffer.from(`ftyp${brand}`, 'latin1'), 0, 0, 0, 0])

describe('[FR-PLT-004/AC1] allowed types are recognised by their first bytes', () => {
  it.each([
    ['application/pdf', text('%PDF-1.7')],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ['image/heic', ftyp('heic')],
    ['image/heic', ftyp('mif1')],
  ] as const)('%s', (mime, head) => {
    expect(sniffMimeType(head)).toBe(mime)
    expect(contentMatchesType(head, mime)).toBe(true)
  })

  it('xlsx and docx are ZIP containers and must be declared as one of them', () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04)
    expect(contentMatchesType(zip, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true)
    expect(contentMatchesType(zip, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
    expect(contentMatchesType(zip, 'application/pdf')).toBe(false)
  })

  it('a renamed file is caught: PNG bytes declared as PDF, HTML declared as JPEG', () => {
    expect(contentMatchesType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'application/pdf')).toBe(false)
    expect(contentMatchesType(text('<html><script>'), 'image/jpeg')).toBe(false)
    expect(sniffMimeType(text('MZ executable'))).toBeNull()
  })

  it('refuses other types, empty files and files over 20 MB before upload', () => {
    expect(checkDeclaredUpload('text/html', 10)).toBe('TYPE_NOT_ALLOWED')
    expect(checkDeclaredUpload('image/svg+xml', 10)).toBe('TYPE_NOT_ALLOWED')
    expect(checkDeclaredUpload('application/pdf', 0)).toBe('EMPTY')
    expect(checkDeclaredUpload('application/pdf', MAX_UPLOAD_BYTES + 1)).toBe('TOO_LARGE')
    expect(checkDeclaredUpload('application/pdf', MAX_UPLOAD_BYTES)).toBeNull()
  })

  it('maps extensions for phones that report no type', () => {
    expect(mimeTypeFromName('IMG_0001.HEIC')).toBe('image/heic')
    expect(mimeTypeFromName('quote.final.PDF')).toBe('application/pdf')
    expect(mimeTypeFromName('virus.exe')).toBeNull()
  })

  it('file names never become paths or carry control characters', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('.. .. etc passwd')
    expect(cleanFileName('a\u0000b\nc')).toBe('a b c')
    expect(cleanFileName('   ')).toBe('file')
    expect(cleanFileName('ใบเสนอราคา.pdf')).toBe('ใบเสนอราคา.pdf')
  })
})

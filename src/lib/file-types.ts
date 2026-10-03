// Files people may upload (FR-PLT-004 AC1, NFR-SEC-08): pdf jpg png heic xlsx docx, at most 20 MB. The declared type
// must match the file's first bytes (magic bytes), so a renamed file is refused. Shared by the browser (early,
// friendly refusal) and the server (the real check).

import { MAX_UPLOAD_BYTES } from './constants'

export { MAX_UPLOAD_BYTES }

export const ALLOWED_FILE_TYPES = {
  'application/pdf': { extensions: ['pdf'], inline: true },
  'image/jpeg': { extensions: ['jpg', 'jpeg'], inline: true },
  'image/png': { extensions: ['png'], inline: true },
  'image/heic': { extensions: ['heic', 'heif'], inline: false },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extensions: ['xlsx'], inline: false },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extensions: ['docx'], inline: false },
} as const

export type AllowedMimeType = keyof typeof ALLOWED_FILE_TYPES
export const ALLOWED_MIME_TYPES = Object.keys(ALLOWED_FILE_TYPES) as AllowedMimeType[]
/** For <input accept>: types and extensions (some phones report HEIC with an empty type). */
export const ACCEPT_ATTRIBUTE = [...ALLOWED_MIME_TYPES, ...Object.values(ALLOWED_FILE_TYPES).flatMap((t) => t.extensions.map((e) => `.${e}`))].join(',')
/** Bytes the server reads to recognise a file */
export const SNIFF_BYTES = 16

export function isAllowedMimeType(value: string): value is AllowedMimeType {
  return Object.hasOwn(ALLOWED_FILE_TYPES, value)
}

/** The allowed type implied by a file name's extension, or null. */
export function mimeTypeFromName(fileName: string): AllowedMimeType | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  for (const [mime, info] of Object.entries(ALLOWED_FILE_TYPES)) {
    if ((info.extensions as readonly string[]).includes(ext)) return mime as AllowedMimeType
  }
  return null
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) => prefix.every((b, i) => bytes[offset + i] === b)
const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))

/** Recognises an allowed type from the first SNIFF_BYTES of a file; null when it is none of them. */
export function sniffMimeType(head: Uint8Array): AllowedMimeType | 'zip' | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  // ISO base media: size(4) 'ftyp' brand(4)
  if (ascii(head, 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(head, 8, 12))) return 'image/heic'
  // xlsx and docx are ZIP containers; the declared Office type decides which
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip'
  return null
}

/** True when the first bytes fit the declared type. */
export function contentMatchesType(head: Uint8Array, declared: AllowedMimeType): boolean {
  const sniffed = sniffMimeType(head)
  if (sniffed === 'zip') return declared.startsWith('application/vnd.openxmlformats-officedocument.')
  return sniffed === declared
}

export type UploadRefusal = 'TYPE_NOT_ALLOWED' | 'TOO_LARGE' | 'EMPTY'

/** Checks a declared upload before any byte is sent. */
export function checkDeclaredUpload(mimeType: string, sizeBytes: number): UploadRefusal | null {
  if (!isAllowedMimeType(mimeType)) return 'TYPE_NOT_ALLOWED'
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return 'EMPTY'
  if (sizeBytes > MAX_UPLOAD_BYTES) return 'TOO_LARGE'
  return null
}

export const FILE_NAME_MAX = 200

/** Keeps the name readable but never a path: no separators or control characters, at most 200 characters. */
export function cleanFileName(name: string): string {
  const visible = [...name.normalize('NFC')]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f || ch === '/' || ch === '\\' ? ' ' : ch
    })
    .join('')
  const cleaned = visible.replace(/\s+/g, ' ').trim()
  return (cleaned || 'file').slice(0, FILE_NAME_MAX)
}

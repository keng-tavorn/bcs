import { inflateSync } from 'node:zlib'
import { MAX_EMBEDDED_FILE_BYTES } from '@/lib/constants'

// The files embedded in a PDF (spec BR-IVC-05: an e-Tax Invoice by Email is a PDF/A-3 that carries its XML). Every
// stream whose dictionary has /Type /EmbeddedFile is read — a stream is always an object of its own, so its dictionary
// runs from "obj" to "stream" — and uncompressed when its one filter is /FlateDecode, never past
// MAX_EMBEDDED_FILE_BYTES. The caller decides which one is the invoice by its content, never by its file name.
// Encrypted PDFs give nothing; streams with other filters are skipped.

const latin1 = new TextDecoder('latin1')

export function embeddedFiles(pdf: Uint8Array): Uint8Array[] {
  const text = latin1.decode(pdf)
  if (!text.startsWith('%PDF-') || /\/Encrypt\b/.test(text)) return []
  const out: Uint8Array[] = []
  const marker = /\/Type\s*\/EmbeddedFile\b/g
  for (let m = marker.exec(text); m; m = marker.exec(text)) {
    const objAt = text.lastIndexOf('obj', m.index)
    const streamAt = text.indexOf('stream', m.index)
    if (objAt === -1 || streamAt === -1) continue
    const dictionary = text.slice(objAt, streamAt)
    let start = streamAt + 'stream'.length
    if (text[start] === '\r') start++
    if (text[start] === '\n') start++
    // the data: /Length when it is written out and lands on "endstream", otherwise up to the end-of-line before it
    const declared = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dictionary)
    let stop = declared ? start + Number(declared[1]) : -1
    if (stop === -1 || !/^\s*endstream/.test(text.slice(stop, stop + 16))) {
      const end = text.indexOf('endstream', start)
      if (end === -1) continue
      stop = end
      if (text[stop - 1] === '\n') stop--
      if (text[stop - 1] === '\r') stop--
    }
    const raw = pdf.subarray(start, stop)
    const filterValue = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dictionary)?.[1] ?? ''
    const filters = filterValue.match(/\/\w+/g) ?? []
    if (filters.length === 0) {
      if (raw.length <= MAX_EMBEDDED_FILE_BYTES) out.push(raw)
    } else if (filters.length === 1 && filters[0] === '/FlateDecode') {
      try {
        out.push(new Uint8Array(inflateSync(raw, { maxOutputLength: MAX_EMBEDDED_FILE_BYTES })))
      } catch {
        // a damaged or oversized stream is skipped; the caller reports that no invoice was found
      }
    }
  }
  return out
}

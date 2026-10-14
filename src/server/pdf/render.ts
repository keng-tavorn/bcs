import path from 'node:path'
import { Font, renderToBuffer } from '@react-pdf/renderer'
import { FONT_FAMILY, PrintablePdf } from './document'
import type { PrintableDocument } from './printable'
import { thaiHyphenationCallback } from './thai-breaks'
import { WhtCertificatePdf, type WhtCertificateDocument } from './wht-certificate'

// Printed documents as PDF (spec FR-PLT-009, OQ-18 → ADR-044): react-pdf with Sarabun (§9.9) from assets/fonts — read
// from the working directory, which is the function root on Vercel (next.config outputFileTracingIncludes ships the
// files). Fonts and the Thai line-break callback are registered once per process; react-pdf's registry is global and
// BCS is its only user. Thai is right only with the mark-offset patch of @react-pdf/render (patches/) and the sara
// am handling in thai-breaks.ts; tests/integration/pdf-snapshot.test.ts checks the pictures.

let registered = false

function registerFonts(): void {
  if (registered) return
  const dir = path.join(process.cwd(), 'assets', 'fonts', 'sarabun')
  Font.register({
    family: FONT_FAMILY,
    fonts: [
      { src: path.join(dir, 'Sarabun-Regular.ttf'), fontWeight: 400 },
      { src: path.join(dir, 'Sarabun-Bold.ttf'), fontWeight: 700 },
    ],
  })
  Font.registerHyphenationCallback(thaiHyphenationCallback)
  registered = true
}

export async function renderPdf(document: PrintableDocument): Promise<Uint8Array> {
  registerFonts()
  const buffer = await renderToBuffer(PrintablePdf({ doc: document }))
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/** The 50 ทวิ of one payment item (BR-WHT-07) */
export async function renderWhtCertificatePdf(document: WhtCertificateDocument): Promise<Uint8Array> {
  registerFonts()
  const buffer = await renderToBuffer(WhtCertificatePdf({ doc: document }))
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

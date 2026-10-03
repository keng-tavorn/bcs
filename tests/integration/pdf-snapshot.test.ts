import { describe, expect, it } from 'vitest'
import { renderPdf } from '@/server/pdf/render'
import { compareSnapshot, pageCount, rasterizePage } from '../support/pdf-raster'
import { poDocument, prDocument } from '../support/printable-fixtures'

// S4-05 (FR-PLT-009 AC3): Thai on the printed PR and PO — words wrap between words, vowels and tone marks sit in their
// places without overlapping — checked as pictures. Every page is rasterized by poppler in Docker (tests/support/
// pdf-raster.ts) and must equal tests/snapshots/pdf/<name>-<page>.png, which a person looked at when it was written.

describe('[FR-PLT-009/AC3] Thai on printed documents, by picture snapshot', () => {
  it.each([
    ['po-3', () => poDocument(3), 1],
    ['po-40', () => poDocument(40), 3],
    ['pr', () => prDocument(), 1],
  ] as const)('%s', async (name, make, minPages) => {
    const pdf = await renderPdf(make())
    const pages = pageCount(pdf)
    expect(pages).toBeGreaterThanOrEqual(minPages)
    for (let page = 1; page <= pages; page++) {
      const r = compareSnapshot(`${name}-${page}`, rasterizePage(pdf, page))
      expect(r.result === 'MATCH' || r.result === 'WRITTEN', `${name} page ${page} differs: see ${'actual' in r ? r.actual : ''}`).toBe(true)
    }
  }, 180_000)
})

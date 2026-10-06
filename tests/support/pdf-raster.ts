import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Thai rendering snapshots of printed documents (spec FR-PLT-009 AC3): a page of a PDF rasterized by poppler in the
// pdf-raster image of docker-compose (Debian 12, the same pixels on every machine), compared byte for byte with the
// PNG kept in tests/snapshots/pdf/. UPDATE_PDF_SNAPSHOTS=1 writes the snapshot instead — look at it before committing.

const IMAGE = 'bcs-pdf-raster:bookworm'
const DPI = '110'
const SNAPSHOTS = path.join(process.cwd(), 'tests', 'snapshots', 'pdf')

function ensureImage(): void {
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status === 0) return
  const built = spawnSync('docker', ['compose', '--profile', 'tools', 'build', 'pdf-raster'], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`could not build ${IMAGE} (is Docker Desktop running?):\n${built.stderr}`)
}

/** Page `page` (1-based) of the PDF as PNG bytes */
export function rasterizePage(pdf: Uint8Array, page: number): Buffer {
  ensureImage()
  const r = spawnSync('docker', ['run', '--rm', '-i', IMAGE, 'pdftoppm', '-r', DPI, '-png', '-f', String(page), '-l', String(page), '-singlefile', '-'], { input: Buffer.from(pdf), maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`pdftoppm failed: ${r.stderr.toString()}`)
  return r.stdout
}

/** The number of pages poppler finds in the PDF */
export function pageCount(pdf: Uint8Array): number {
  ensureImage()
  const r = spawnSync('docker', ['run', '--rm', '-i', IMAGE, 'pdfinfo', '-'], { input: Buffer.from(pdf), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`pdfinfo failed: ${r.stderr}`)
  return Number(/^Pages:\s+(\d+)/m.exec(r.stdout)?.[1] ?? 0)
}

/** 'MATCH', or 'WRITTEN' when updating; otherwise where the new picture was put to look at */
export function compareSnapshot(name: string, png: Buffer): { readonly result: 'MATCH' | 'WRITTEN' } | { readonly result: 'DIFFERENT' | 'MISSING'; readonly actual: string } {
  mkdirSync(SNAPSHOTS, { recursive: true })
  const file = path.join(SNAPSHOTS, `${name}.png`)
  if (process.env.UPDATE_PDF_SNAPSHOTS === '1') {
    writeFileSync(file, png)
    return { result: 'WRITTEN' }
  }
  const actual = path.join(SNAPSHOTS, `${name}.actual.png`)
  if (!existsSync(file)) {
    writeFileSync(actual, png)
    return { result: 'MISSING', actual }
  }
  if (readFileSync(file).equals(png)) return { result: 'MATCH' }
  writeFileSync(actual, png)
  return { result: 'DIFFERENT', actual }
}

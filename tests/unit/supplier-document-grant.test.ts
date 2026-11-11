// S11-24 (BR-SDOC ข้อ 05 · BR-RSK-08): S7's supplierDocument.requestDownload lets a member in without
// supplier.document.view only through a grant another module passes as an argument — S11's check of the reviewer's slot,
// run in the download's own transaction. No input of the command names a grant (its schema is strict and has no such
// field), and only S11's evidence service passes one. This test reads every source file of src and fails when another
// file calls the granted download or builds a grant, so a new caller is a decision taken here, not a quiet bypass.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

// The file that defines the grant and the only one that passes it (file → reason)
const DEFINES = 'src/server/services/suppliers/documents.ts'
const GRANTERS: Readonly<Record<string, string>> = {
  'src/server/services/risk/evidence.ts': 'S11-24: the reviewer of a slot opens the certificate an answer of its own domains rests on (risk.evidence.view ASSIGNED)',
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return full.endsWith(path.join('server', 'db', 'generated')) ? [] : sourceFiles(full)
    return /\.(ts|tsx|mts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : []
  })
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

describe('[BR-SDOC-05] a supplier document opens by another module’s grant only where the grant is checked', () => {
  const files = sourceFiles(SRC).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }))

  it('only S11’s evidence service passes a grant to S7’s download', () => {
    const using = files.filter((f) => f.file !== DEFINES && /\b(requestSupplierDocumentDownloadGranted|SupplierDocumentGrant)\b/.test(f.text)).map((f) => f.file)
    expect(using.sort()).toEqual(Object.keys(GRANTERS).sort())
  })

  it('no input a caller sends names grantedBy: S7 sets it from the grant on the granted call only', () => {
    const documents = files.find((f) => f.file === DEFINES)!.text
    const input = /const DownloadInput = z\.strictObject\(\{([^\n]*)\}\)/.exec(documents)
    expect(input, 'the download input is a strict object').not.toBeNull()
    expect(input![1]).not.toMatch(/grantedBy/)
    // nowhere outside the grant's definition and its event schema does code send a grantedBy of RISK_REVIEW
    const naming = files.filter((f) => f.file !== DEFINES && f.file !== 'src/server/events/schemas/file.ts' && !(f.file in GRANTERS) && /grantedBy:\s*'RISK_REVIEW'/.test(f.text)).map((f) => f.file)
    expect(naming).toEqual([])
  })
})

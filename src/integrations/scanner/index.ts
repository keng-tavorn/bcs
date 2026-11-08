import { getEnv } from '@/lib/env'

// The virus scan of uploaded files (S7-06 · BR-PORTAL ข้อ 07 · OQ-191 · the pattern of ADR-025): `stub` on a machine and in
// tests — a file holding the EICAR test string, or whose sha256 is in the denylist, is INFECTED, every other is CLEAN;
// `live` is the scanning service the customer chooses (ClamAV or another), built in S7-22 [go-live] and refused here
// until then, so a file is never called clean by a scanner that did not look at it.

export type ScanResult = 'CLEAN' | 'INFECTED'

export interface FileScanner {
  readonly mode: 'stub' | 'live'
  scan(bytes: Uint8Array, sha256: string): Promise<ScanResult>
}

/** The industry's harmless test string every scanner reports (eicar.org) */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
/** sha256 of files the stub calls infected besides EICAR (tests may add theirs) */
const DENYLIST = new Set<string>()

export const stubScanner: FileScanner = {
  mode: 'stub',
  async scan(bytes, sha256) {
    if (DENYLIST.has(sha256)) return 'INFECTED'
    return Buffer.from(bytes).toString('latin1').includes(EICAR) ? 'INFECTED' : 'CLEAN'
  },
}

export class ScannerNotConfiguredError extends Error {
  constructor() {
    super('FILE_SCAN_MODE=live has no scanning service yet (S7-22 · OQ-191)')
    this.name = 'ScannerNotConfiguredError'
  }
}

let override: FileScanner | null = null

export function getScanner(): FileScanner {
  if (override) return override
  if (getEnv().FILE_SCAN_MODE === 'live') throw new ScannerNotConfiguredError()
  return stubScanner
}

/** Test seam */
export function setScanner(scanner: FileScanner | null): void {
  override = scanner
}

/** Test seam: a sha256 the stub calls infected */
export function denyInStub(sha256: string): void {
  DENYLIST.add(sha256)
}

/** The EICAR test string, for tests and the hands-on check */
export const EICAR_TEST_STRING = EICAR

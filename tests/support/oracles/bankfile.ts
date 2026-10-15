/**
 * Second, independent implementation ("oracle") of the S9 bank-file engine for the
 * differential test of ADR-072. Written only from the rule text: docs/sub-specs/S9.md
 * ("กฎ": BR-BANK-04, BR-BANK-05, BR-BANK-06, BR-SUP-07, BR-PAY-05 · "ร่าง golden case":
 * bank-precheck, bankfile-neutral, bank-account) and spec.md §7.14 §7.15 with ADR-129 to
 * ADR-131. It imports nothing from src/: only node:crypto for sha256.
 *
 * Money is bigint satang (1 baht = 100 satang); days are YYYY-MM-DD strings.
 * Every reading the rule text does not settle is marked with a "SPEC SILENT:" comment.
 */
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// BR-SUP-07: account number, bank code and account name of a bank account
// ---------------------------------------------------------------------------

export type OracleAccountCheck =
  | { ok: true; accountNo: string; masked: string }
  | {
      ok: false
      code: 'VALIDATION_FAILED'
      reason: 'ACCOUNT_NO_LENGTH' | 'ACCOUNT_NO_FORMAT' | 'BANK_CODE_UNKNOWN' | 'ACCOUNT_NAME_FORMAT'
    }

type AccountReason = Extract<OracleAccountCheck, { ok: false }>['reason']

const MASK_CHAR = '•' // "•"
const ACCOUNT_MIN_DIGITS = 10
const ACCOUNT_MAX_DIGITS = 12

function accountFailure(reason: AccountReason): OracleAccountCheck {
  return { ok: false, code: 'VALIDATION_FAILED', reason }
}

/** BR-SUP-07: normalise and check one account; `banks` is the list of known 3-digit bank codes; accountName optional */
export function oracleNormalizeAccount(
  input: { bankCode: string; accountNo: string; accountName?: string },
  banks: readonly string[],
): OracleAccountCheck {
  // SPEC SILENT: when several fields fail, the reason is the first in the order the rule names them:
  // account number (format, then length) → bank code → account name.

  // SPEC SILENT: "มีขีดและเว้นวรรค" is read as the ASCII hyphen-minus (U+002D) and the ASCII space (U+0020)
  // only, anywhere in the value and any number of times. Every other character (tab, no-break space,
  // other dashes, Thai digits ๐–๙, letters) is ACCOUNT_NO_FORMAT.
  const digits = input.accountNo.replace(/[- ]/g, '')

  // SPEC SILENT: format is checked before length. "ตัวเลขล้วน 10–12 หลัก" counts digits, which only
  // means something once the value is digits only, so "ABC" is ACCOUNT_NO_FORMAT, not ACCOUNT_NO_LENGTH.
  if (!/^[0-9]*$/.test(digits)) return accountFailure('ACCOUNT_NO_FORMAT')
  if (digits.length < ACCOUNT_MIN_DIGITS || digits.length > ACCOUNT_MAX_DIGITS) {
    return accountFailure('ACCOUNT_NO_LENGTH')
  }

  // SPEC SILENT: the bank code is matched exactly against the list, without trimming or zero-padding
  // ("4" is not "004").
  if (!banks.includes(input.bankCode)) return accountFailure('BANK_CODE_UNKNOWN')

  // SPEC SILENT: "อักขระควบคุม" is read as Unicode general category Cc (U+0000–U+001F and U+007F–U+009F).
  // Format characters (Cf, e.g. zero-width space U+200B) and U+2028/U+2029 are not control characters
  // and pass. An absent or empty name passes: the rule refuses only control characters.
  if (input.accountName !== undefined && /\p{Cc}/u.test(input.accountName)) {
    return accountFailure('ACCOUNT_NAME_FORMAT')
  }

  return { ok: true, accountNo: digits, masked: oracleMaskAccount(digits) }
}

/** BR-SUP-07: the masked form of a stored (digits-only) account number */
export function oracleMaskAccount(accountNo: string): string {
  // SPEC SILENT: only a stored number (ASCII digits only, 10–12 of them · BR-SUP-07) can reach this
  // function; anything else cannot occur and throws RangeError instead of guessing a mask.
  if (!/^[0-9]+$/.test(accountNo) || accountNo.length < ACCOUNT_MIN_DIGITS || accountNo.length > ACCOUNT_MAX_DIGITS) {
    throw new RangeError('oracleMaskAccount: a stored account number is 10–12 ASCII digits')
  }
  // "•" for every digit except the last 4.
  return MASK_CHAR.repeat(accountNo.length - 4) + accountNo.slice(-4)
}

// ---------------------------------------------------------------------------
// BR-BANK-06: the pre-check before any file version
// ---------------------------------------------------------------------------

export interface OracleAccountFields {
  bankCode: string
  accountNo: string
  accountName: string
}
export interface OraclePrecheckItem {
  seq: number
  supplier: string // supplier code
  transfer: bigint // satang
  snapshot: OracleAccountFields // the payee account copied at submit
  register: (OracleAccountFields & { status: string }) | null // the supplier's account in the register now (null = none)
  documents: Array<{ id: string; link: string }> // link 'HELD_BY_THIS_RUN' means held by this run; any other value is not
}
export interface OraclePrecheckRun {
  totalTransfer: bigint
  itemCount: number
  payerStatus: string
  payerTemplate: string
  runTemplate: string
}
export type OraclePrecheckFailure =
  | { check: 'PAYER_ACCOUNT_INVALID' }
  | { check: 'TOTAL_MISMATCH'; expected: bigint; actual: bigint }
  | { check: 'COUNT_MISMATCH'; expected: number; actual: number }
  | { seq: number; check: 'ACCOUNT_NOT_ACTIVE' }
  | { seq: number; check: 'ACCOUNT_MISMATCH'; field: 'bankCode' | 'accountNo' | 'accountName' }
  | { seq: number; check: 'DUPLICATE_SUPPLIER' }
  | { seq: number; check: 'DUPLICATE_DOCUMENT_IN_RUN'; document: string }
  | { seq: number; check: 'DOCUMENT_NOT_HELD'; document: string }

const HELD_BY_THIS_RUN = 'HELD_BY_THIS_RUN'
const ACCOUNT_FIELDS = ['bankCode', 'accountNo', 'accountName'] as const

/**
 * Items in ascending seq. seq is issued once per item at submit (BR-PAY-05), so it is a positive
 * integer and unique within a run.
 */
function bySeq<T extends { seq: number }>(items: readonly T[], who: string): T[] {
  // SPEC SILENT: a seq that is not a positive integer, or a seq repeated within one run, cannot occur
  // (BR-PAY-05 issues one seq per item) and throws RangeError rather than picking a tie-break.
  const seen = new Set<number>()
  for (const item of items) {
    if (!Number.isSafeInteger(item.seq) || item.seq < 1) throw new RangeError(`${who}: seq must be a positive integer`)
    if (seen.has(item.seq)) throw new RangeError(`${who}: seq ${item.seq} is repeated`)
    seen.add(item.seq)
  }
  return [...items].sort((a, b) => a.seq - b.seq)
}

/** BR-BANK-06: the pre-check before any file version; ok = no failure */
export function oraclePrecheck(input: { run: OraclePrecheckRun; items: OraclePrecheckItem[] }): {
  ok: boolean
  failures: OraclePrecheckFailure[]
} {
  const { run, items } = input
  const failures: OraclePrecheckFailure[] = []

  // SPEC SILENT: every check runs and every failure is reported (no stop at the first), at run level and
  // per item; GC-BANK-11 shows a run-level and an item-level failure reported together.

  // --- run level, in the order of the rule ---
  // PAYER_ACCOUNT_INVALID: the payer account is not ACTIVE, or its template differs from the run's snapshot.
  // SPEC SILENT: one PAYER_ACCOUNT_INVALID even when both the status and the template are wrong (the
  // failure carries no detail to tell them apart). Status and template are compared as exact strings.
  if (run.payerStatus !== 'ACTIVE' || run.payerTemplate !== run.runTemplate) {
    failures.push({ check: 'PAYER_ACCOUNT_INVALID' })
  }

  // TOTAL_MISMATCH: Σ transfer of the items ≠ the run's total · expected = the run, actual = the sum (GC-BANK-05).
  let sum = 0n
  for (const item of items) sum += item.transfer
  if (sum !== run.totalTransfer) {
    failures.push({ check: 'TOTAL_MISMATCH', expected: run.totalTransfer, actual: sum })
  }

  // COUNT_MISMATCH: expected = the run's count, actual = the number of items (GC-BANK-06).
  if (items.length !== run.itemCount) {
    failures.push({ check: 'COUNT_MISMATCH', expected: run.itemCount, actual: items.length })
  }

  // SPEC SILENT: an empty run (no items) has no item-level failure; it passes when the run says
  // 0 items and 0.00. BR-BANK-06 has no "at least one item" check.

  // --- per item, in ascending seq ("ตาม seq") whatever order the items are given in ---
  const suppliersSeen = new Set<string>()
  const documentsSeen = new Set<string>()
  for (const item of bySeq(items, 'oraclePrecheck')) {
    const seq = item.seq

    // ACCOUNT_NOT_ACTIVE → ACCOUNT_MISMATCH
    const register = item.register
    if (register === null || register.status !== 'ACTIVE') {
      // SPEC SILENT: no ACTIVE account in the register → only ACCOUNT_NOT_ACTIVE. ACCOUNT_MISMATCH compares
      // the snapshot with "the ACTIVE account in the register", which does not exist here.
      failures.push({ seq, check: 'ACCOUNT_NOT_ACTIVE' })
    } else {
      // SPEC SILENT: one ACCOUNT_MISMATCH per differing field, in the order the rule lists them
      // (bankCode, accountNo, accountName), not only the first; exact string comparison with no
      // trimming or normalisation, since the snapshot is a copy of the register.
      for (const field of ACCOUNT_FIELDS) {
        if (item.snapshot[field] !== register[field]) failures.push({ seq, check: 'ACCOUNT_MISMATCH', field })
      }
    }

    // DUPLICATE_SUPPLIER: the second and later items of a supplier (by seq); the first is not flagged (GC-BANK-07).
    if (suppliersSeen.has(item.supplier)) failures.push({ seq, check: 'DUPLICATE_SUPPLIER' })
    else suppliersSeen.add(item.supplier)

    // DUPLICATE_DOCUMENT_IN_RUN: a document already seen earlier in the run (an earlier seq, or earlier in
    // this item's list); its first occurrence is not flagged (GC-BANK-08).
    // SPEC SILENT: documents are visited in the order of the item's list; a document repeated within one
    // item is a duplicate too; at most one failure per (seq, document).
    const duplicateReported = new Set<string>()
    for (const document of item.documents) {
      if (!documentsSeen.has(document.id)) {
        documentsSeen.add(document.id)
      } else if (!duplicateReported.has(document.id)) {
        duplicateReported.add(document.id)
        failures.push({ seq, check: 'DUPLICATE_DOCUMENT_IN_RUN', document: document.id })
      }
    }

    // DOCUMENT_NOT_HELD: the link is not HELD by this run (e.g. paid or released).
    // SPEC SILENT: checked for every document entry independently of DUPLICATE_DOCUMENT_IN_RUN (a duplicate
    // that is also not held gets both); list order; at most one failure per (seq, document). Within an item,
    // all DUPLICATE_DOCUMENT_IN_RUN failures come before all DOCUMENT_NOT_HELD failures (check order first).
    const notHeldReported = new Set<string>()
    for (const document of item.documents) {
      if (document.link !== HELD_BY_THIS_RUN && !notHeldReported.has(document.id)) {
        notHeldReported.add(document.id)
        failures.push({ seq, check: 'DOCUMENT_NOT_HELD', document: document.id })
      }
    }
    // SPEC SILENT: an item without documents gets no failure for that; BR-BANK-06 has no such check.
  }

  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------
// BR-BANK-04/05: the BCS-NEUTRAL-1 file
// ---------------------------------------------------------------------------

export interface OracleNeutralInput {
  run: { number: string; fileVersion: number; valueDate: string; payer: { bankCode: string; accountNo: string } }
  items: Array<{ seq: number; bankCode: string; accountNo: string; accountName: string; amount: bigint; supplierCode: string }>
}

const TEMPLATE_CODE = 'BCS-NEUTRAL-1'
const NOT_A_BANK_FORMAT = 'NOT-A-BANK-FORMAT'
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const
const CRLF = '\r\n'

/** Baht with a dot and 2 satang digits, no thousands separator: 10932870n → "109328.70". */
function bahtText(satang: bigint): string {
  if (satang < 0n) throw new RangeError('bahtText: negative money cannot be written')
  const baht = satang / 100n
  const rest = satang % 100n
  return `${baht.toString()}.${rest.toString().padStart(2, '0')}`
}

/** A CSV field: quoted when it holds `,` `"` CR or LF, with `"` doubled; otherwise as is. */
function csvField(value: string): string {
  // SPEC SILENT: quoting applies to every field of every row ("ช่องที่มี ..."), not only the account name.
  // Only `,` `"` CR LF trigger it; other characters, including other control characters (which BR-SUP-07
  // refuses upstream), are written unchanged.
  return /[,"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(',')
}

/** YYYY-MM-DD that is a real Gregorian (ค.ศ.) day. */
function isCalendarDay(day: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const date = Number(m[3])
  if (year < 1 || month < 1 || month > 12 || date < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
  return date <= daysInMonth
}

/** BR-BANK-04/05: the BCS-NEUTRAL-1 file: its name, its lines (without line endings), the bytes as written, and their sha256 (lower-case hex) */
export function oracleNeutralFile(input: OracleNeutralInput): {
  fileName: string
  lines: string[]
  itemCount: number
  total: bigint
  bytes: Uint8Array
  sha256: string
} {
  const { run } = input

  // SPEC SILENT: inputs that cannot reach a file throw RangeError: a version that is not a positive
  // integer (versions start at 1 and grow by 1 · BR-BANK-07), a pay date that is not a real YYYY-MM-DD
  // day, an amount ≤ 0 (transfer > 0 · BR-PAY-04), and a seq that is not a positive integer or repeats.
  if (!Number.isSafeInteger(run.fileVersion) || run.fileVersion < 1) {
    throw new RangeError('oracleNeutralFile: fileVersion must be a positive integer')
  }
  if (!isCalendarDay(run.valueDate)) throw new RangeError('oracleNeutralFile: valueDate must be YYYY-MM-DD')
  for (const item of input.items) {
    if (item.amount <= 0n) throw new RangeError('oracleNeutralFile: an item amount must be > 0')
  }

  // SPEC SILENT: D rows are written in ascending seq whatever order the items are given in (seq is the
  // order issued at submit · BR-PAY-05).
  const items = bySeq(input.items, 'oracleNeutralFile')

  let total = 0n
  for (const item of items) total += item.amount
  const itemCount = items.length
  const version = String(run.fileVersion)
  const totalText = bahtText(total)

  // SPEC SILENT: account fields, codes and the run number are written exactly as given; the generator does
  // not re-check them (BR-SUP-07 checks accounts when stored and BR-BANK-06 compares them before any file).
  const lines: string[] = []
  lines.push(
    csvLine([
      'H',
      TEMPLATE_CODE,
      NOT_A_BANK_FORMAT,
      run.number,
      version,
      run.valueDate,
      run.payer.bankCode,
      run.payer.accountNo,
      String(itemCount),
      totalText,
    ]),
  )
  for (const item of items) {
    // SPEC SILENT: "เติมศูนย์ 3 หลัก" pads to at least 3 digits; seq 1000 and above is written in full.
    const reference = `${run.number}-${String(item.seq).padStart(3, '0')}`
    lines.push(
      csvLine([
        'D',
        String(item.seq),
        item.bankCode,
        item.accountNo,
        item.accountName,
        bahtText(item.amount),
        item.supplierCode,
        reference,
      ]),
    )
  }
  lines.push(csvLine(['T', String(itemCount), totalText]))
  // SPEC SILENT: a run with no items gives the H and T rows only (0 items, 0.00); BR-BANK-05 does not
  // require a D row, and the pre-check (BR-BANK-06) is where an inconsistent run is stopped.

  // UTF-8 with BOM; every line ends with CRLF, the last one included.
  const body = new TextEncoder().encode(lines.join(CRLF) + CRLF)
  const bytes = new Uint8Array(UTF8_BOM.length + body.length)
  bytes.set(UTF8_BOM, 0)
  bytes.set(body, UTF8_BOM.length)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const fileName = `${TEMPLATE_CODE}_${NOT_A_BANK_FORMAT}_${run.number}_v${version}.csv`

  return { fileName, lines, itemCount, total, bytes, sha256 }
}

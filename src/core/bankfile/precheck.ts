import type { Satang } from '../money/math'

// BR-BANK-06 (extends BR-BANK-02): the check before every version of a bank file. Every failure is listed, the run's
// first (PAYER_ACCOUNT_INVALID, TOTAL_MISMATCH, COUNT_MISMATCH), then each item's in seq order, and within an item in
// the order of the rule; any failure means BANK_FILE_CHECK_FAILED and no file.

export interface PrecheckAccount {
  readonly bankCode: string
  readonly accountNo: string
  readonly accountName: string
}

export interface PrecheckItem {
  readonly seq: number
  readonly supplierCode: string
  readonly transferSatang: Satang
  /** The payee's account as the item copied it at submit */
  readonly snapshot: PrecheckAccount
  /** The account the snapshot came from, as the register has it now (null when it is gone) */
  readonly register: (PrecheckAccount & { readonly status: string }) | null
  /** Its documents, and whether each is still HELD by this run (a link PAID, RELEASED or of another run is not) */
  readonly documents: ReadonlyArray<{ readonly id: string; readonly heldByThisRun: boolean }>
}

export interface PrecheckRun {
  readonly totalTransferSatang: Satang
  readonly itemCount: number
  /** The payer account's status now, its template now, and the template the run took when it was made */
  readonly payerStatus: string
  readonly payerTemplateCode: string
  readonly runTemplateCode: string
}

export const ACCOUNT_FIELDS = ['bankCode', 'accountNo', 'accountName'] as const
export type AccountField = (typeof ACCOUNT_FIELDS)[number]

export type PrecheckFailure =
  | { readonly check: 'PAYER_ACCOUNT_INVALID' }
  | { readonly check: 'TOTAL_MISMATCH'; readonly expectedSatang: Satang; readonly actualSatang: Satang }
  | { readonly check: 'COUNT_MISMATCH'; readonly expected: number; readonly actual: number }
  | { readonly seq: number; readonly check: 'ACCOUNT_NOT_ACTIVE' }
  | { readonly seq: number; readonly check: 'ACCOUNT_MISMATCH'; readonly field: AccountField }
  | { readonly seq: number; readonly check: 'DUPLICATE_SUPPLIER' }
  | { readonly seq: number; readonly check: 'DUPLICATE_DOCUMENT_IN_RUN'; readonly document: string }
  | { readonly seq: number; readonly check: 'DOCUMENT_NOT_HELD'; readonly document: string }

export function precheckRun(run: PrecheckRun, items: readonly PrecheckItem[]): { readonly ok: boolean; readonly failures: readonly PrecheckFailure[] } {
  const failures: PrecheckFailure[] = []
  if (run.payerStatus !== 'ACTIVE' || run.payerTemplateCode !== run.runTemplateCode) failures.push({ check: 'PAYER_ACCOUNT_INVALID' })
  const total = items.reduce((a, i) => a + i.transferSatang, 0n)
  if (total !== run.totalTransferSatang) failures.push({ check: 'TOTAL_MISMATCH', expectedSatang: run.totalTransferSatang, actualSatang: total })
  if (items.length !== run.itemCount) failures.push({ check: 'COUNT_MISMATCH', expected: run.itemCount, actual: items.length })

  const suppliers = new Set<string>()
  const documents = new Set<string>()
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    const seq = item.seq
    // the snapshot is compared with the account in force only: an account no longer ACTIVE has nothing to compare
    if (item.register?.status !== 'ACTIVE') failures.push({ seq, check: 'ACCOUNT_NOT_ACTIVE' })
    else for (const field of ACCOUNT_FIELDS) if (item.snapshot[field] !== item.register[field]) failures.push({ seq, check: 'ACCOUNT_MISMATCH', field })
    if (suppliers.has(item.supplierCode)) failures.push({ seq, check: 'DUPLICATE_SUPPLIER' })
    suppliers.add(item.supplierCode)
    // a document listed twice in one item is named once per check: the same failure twice says nothing more
    const named = new Set<string>()
    const name = (check: 'DUPLICATE_DOCUMENT_IN_RUN' | 'DOCUMENT_NOT_HELD', document: string) => {
      if (named.has(`${check} ${document}`)) return
      named.add(`${check} ${document}`)
      failures.push({ seq, check, document })
    }
    for (const d of item.documents) {
      if (documents.has(d.id)) name('DUPLICATE_DOCUMENT_IN_RUN', d.id)
      documents.add(d.id)
    }
    for (const d of item.documents) if (!d.heldByThisRun) name('DOCUMENT_NOT_HELD', d.id)
  }
  return { ok: failures.length === 0, failures }
}

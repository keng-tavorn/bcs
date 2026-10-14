import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'

// The form model of a budget transfer (S6-15 · FR-BUD-103 AC1 · BR-BUD-10 BR-BUD-11): which lines each kind offers to
// the member, what the form checks before it sends, and the input it sends. Pure, so the screens and the unit tests
// share it. The services check every rule again (the lines' kind, status, fiscal year, the member's right, what is
// left). Money stays decimal text and bigint satang, never floating point.

export type TransferKind = 'TRANSFER' | 'INCREASE' | 'DECREASE'
export const TRANSFER_KINDS: readonly TransferKind[] = ['TRANSFER', 'INCREASE', 'DECREASE']

export type TransferStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED'

/** A line of the fiscal year in use, as getTransferForm gives it */
export interface TransferLineOption {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly departmentCode: string
  readonly available: { readonly amount: string }
  /** The member may give from it (TRANSFER, DECREASE) */
  readonly canGive: boolean
  /** The member may raise it alone (INCREASE) */
  readonly canIncrease: boolean
}

export interface TransferFormValues {
  readonly kind: TransferKind
  readonly fromBudgetLineId: string
  readonly toBudgetLineId: string
  /** Baht as typed: "300000", "300,000.50" */
  readonly amount: string
  readonly reason: string
}

/** What createBudgetTransfer takes: TRANSFER both lines, INCREASE only the destination, DECREASE only the source */
export interface TransferInput {
  readonly kind: TransferKind
  readonly fromBudgetLineId?: string
  readonly toBudgetLineId?: string
  readonly amount: string
  readonly reason: string
}

export const REASON_MIN = 3

/** The kind takes money from a line (a transfer or a decrease) */
export const needsSource = (kind: TransferKind): boolean => kind !== 'INCREASE'
/** The kind gives money to a line (a transfer or an increase) */
export const needsDestination = (kind: TransferKind): boolean => kind !== 'DECREASE'

/** The lines the member may give from: the source of a transfer or of a decrease; none for an increase */
export function sourceLines(kind: TransferKind, lines: readonly TransferLineOption[]): TransferLineOption[] {
  return needsSource(kind) ? lines.filter((l) => l.canGive) : []
}

/**
 * The lines it may go to: any other line of the year for a transfer (BR-BUD-10: a department head gives from their
 * department to any line), the lines the member may raise for an increase, none for a decrease
 */
export function destinationLines(kind: TransferKind, lines: readonly TransferLineOption[], fromBudgetLineId: string): TransferLineOption[] {
  if (kind === 'TRANSFER') return lines.filter((l) => l.id !== fromBudgetLineId)
  if (kind === 'INCREASE') return lines.filter((l) => l.canIncrease)
  return []
}

/** The kinds the member can send at all with these lines (a transfer needs a line to give from and another to give to) */
export function kindsOffered(lines: readonly TransferLineOption[]): TransferKind[] {
  const give = lines.filter((l) => l.canGive)
  return TRANSFER_KINDS.filter((k) => (k === 'INCREASE' ? lines.some((l) => l.canIncrease) : k === 'DECREASE' ? give.length > 0 : give.some((g) => lines.some((l) => l.id !== g.id))))
}

/** "300,000.50" → "300000.50"; null when it is not baht with at most two decimals */
export function bahtText(typed: string): string | null {
  const plain = typed.trim().replace(/,/g, '')
  return /^\d{1,13}(\.\d{1,2})?$/.test(plain) ? plain : null
}

export type TransferFieldErrorKey = 'KIND' | 'FROM' | 'TO' | 'AMOUNT' | 'AMOUNT_NOT_POSITIVE' | 'INSUFFICIENT' | 'REASON'
export type TransferFormErrors = Partial<Record<'kind' | 'from' | 'to' | 'amount' | 'reason', { key: TransferFieldErrorKey; shortfall?: string }>>

/**
 * What the form says before it sends (§9.9 rule 3, told in advance): the lines the kind needs, an amount above zero in
 * baht, no more than the source has left — "ขาดอีก <shortfall> บาท", the same words the server's BUDGET_INSUFFICIENT
 * gets — and a reason of at least three letters
 */
export function transferFormErrors(values: TransferFormValues, lines: readonly TransferLineOption[]): TransferFormErrors {
  const errors: TransferFormErrors = {}
  const set = (field: keyof TransferFormErrors, key: TransferFieldErrorKey, shortfall?: string) => Object.assign(errors, { [field]: shortfall ? { key, shortfall } : { key } })
  if (!TRANSFER_KINDS.includes(values.kind)) set('kind', 'KIND')
  const source = needsSource(values.kind) ? sourceLines(values.kind, lines).find((l) => l.id === values.fromBudgetLineId) : undefined
  if (needsSource(values.kind) && !source) set('from', 'FROM')
  if (needsDestination(values.kind) && !destinationLines(values.kind, lines, values.fromBudgetLineId).some((l) => l.id === values.toBudgetLineId)) set('to', 'TO')
  const baht = bahtText(values.amount)
  if (baht === null) set('amount', 'AMOUNT')
  else if (amountToSatang(baht) <= 0n) set('amount', 'AMOUNT_NOT_POSITIVE')
  else if (source) {
    const short = amountToSatang(baht) - amountToSatang(source.available.amount)
    if (short > 0n) set('amount', 'INSUFFICIENT', formatSatang(short))
  }
  if (values.reason.trim().length < REASON_MIN) set('reason', 'REASON')
  return errors
}

/** The input of createBudgetTransfer from valid values: only the lines the kind takes */
export function transferInput(values: TransferFormValues): TransferInput {
  return {
    kind: values.kind,
    ...(needsSource(values.kind) ? { fromBudgetLineId: values.fromBudgetLineId } : {}),
    ...(needsDestination(values.kind) ? { toBudgetLineId: values.toBudgetLineId } : {}),
    amount: bahtText(values.amount) ?? values.amount.trim(),
    reason: values.reason.trim(),
  }
}

/** Two inputs are the same transfer: a draft made from one may be sent for the other */
export const sameTransfer = (a: TransferInput, b: TransferInput): boolean =>
  a.kind === b.kind && a.fromBudgetLineId === b.fromBudgetLineId && a.toBudgetLineId === b.toBudgetLineId && amountToSatang(a.amount) === amountToSatang(b.amount) && a.reason === b.reason

/** What its sender may do with it now (§6.4): send it (again) while a draft or returned, cancel it until it is decided */
export function senderActions(status: TransferStatus, mine: boolean): { readonly send: boolean; readonly cancel: boolean } {
  return { send: mine && (status === 'DRAFT' || status === 'RETURNED'), cancel: mine && (status === 'DRAFT' || status === 'RETURNED' || status === 'PENDING_APPROVAL') }
}

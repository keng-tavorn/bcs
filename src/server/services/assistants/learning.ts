import type { TenantTx } from '@/server/db/tenant'

// What an ORG_ADMIN decided about the things the assistants learned (NEW-125 · ADR-083 · BR-AP-10). Phase 1 learns one
// kind, the account code FINANCE confirmed for a supplier (its tax id, every branch together) and a category; the
// learning is the confirmed invoice lines themselves, read by code, and an AssistantLearning row only switches a pair
// off or forgets the lines confirmed up to its forgottenAt. The coding suggestion (services/ap/coding.ts) and the
// notebook at /admin/ai both read the history through learningInUse, so what the admin sees is what the screen offers.

export interface LearningControl {
  readonly id: string
  readonly disabled: boolean
  readonly forgottenAt: Date | null
  readonly version: number
}

/** The key of a category in AssistantLearning: lines without a category are stored as '' (BR-AP-10 compares them as equal) */
export const categoryKey = (categoryCode: string | null): string => categoryCode ?? ''

/** The admin's decisions on the account codes learned for one supplier tax id, by category key */
export async function accountCodeControls(tx: TenantTx, supplierTaxId: string): Promise<ReadonlyMap<string, LearningControl>> {
  const rows = await tx.assistantLearning.findMany({
    where: { kind: 'ACCOUNT_CODE', supplierTaxId },
    select: { id: true, categoryCode: true, disabled: true, forgottenAt: true, version: true },
  })
  return new Map(rows.map((r) => [r.categoryCode, { id: r.id, disabled: r.disabled, forgottenAt: r.forgottenAt, version: r.version }]))
}

/**
 * Whether a confirmed line still teaches the assistant: not when its pair is switched off, and not when it was
 * confirmed at or before the moment the admin made the assistant forget (later confirmations teach it again).
 * `includeDisabled` reads a switched-off pair as it stands, for the notebook to show what it would offer when on again.
 */
export function learningInUse(control: LearningControl | undefined, confirmedAt: Date, options: { includeDisabled?: boolean } = {}): boolean {
  if (!control) return true
  if (control.disabled && !options.includeDisabled) return false
  return control.forgottenAt === null || confirmedAt.getTime() > control.forgottenAt.getTime()
}

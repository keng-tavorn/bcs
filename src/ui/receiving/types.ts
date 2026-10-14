// What the receiving screens get from the server (FR-P2P-006, FR-P2P-007): quantities and amounts already formatted
// (thousands separators; money with 2 decimals), names in both languages so the screen picks the reader's, and no
// bigint (server actions hand plain JSON to the browser). The web page /receiving/[poId] and the LIFF page /liff/gr/[poId]
// of S5-06 build these from the same service and give them to the same components.

export interface NameView {
  readonly th: string
  readonly en: string | null
}

export const nameIn = (locale: string, name: NameView | null | undefined): string => (name ? (locale === 'en' && name.en ? name.en : name.th) : '')

/** One PO line on the receiving form */
export interface ReceiveLineView {
  readonly id: string
  readonly description: string
  readonly uom: string
  readonly ordered: string
  /** Accepted so far */
  readonly received: string
  /** Not in yet */
  readonly outstanding: string
  /** Given up (closed short), null when nothing was */
  readonly cancelled: string | null
  /** Of what is not in, damaged goods waiting for approval to be kept (null when none) */
  readonly keepPending: string | null
}

/** Who approves a variance the receiver keeps (DOA rule GR_VARIANCE), or why nobody can now */
export type ApproverView =
  | {
      readonly kind: 'ROUTE'
      readonly ruleCode: string
      readonly name: NameView | null
      /** A delegate holds it for this member (BR-DLG-04) */
      readonly actingFor: NameView | null
      readonly position: NameView | null
      readonly department: NameView | null
    }
  | { readonly kind: 'BLOCKED'; readonly code: string }

export interface VarianceChoiceView {
  readonly quantity: string
  /** Formatted baht, or null when the reader does not see amounts */
  readonly amount: string | null
  readonly keep: ApproverView
}

export interface PreviewLineView {
  readonly poLineId: string
  readonly description: string
  readonly uom: string
  readonly received: string
  /** null when nothing was refused */
  readonly rejected: string | null
  readonly accepted: string
  readonly outstandingAfter: string
  /** Kept beyond the order within the tolerance, accepted at once (BR-GR-02) */
  readonly withinTolerance: string | null
  /** Held more for it, formatted baht (null when nothing is held or amounts are not shown) */
  readonly hold: string | null
  readonly excess: VarianceChoiceView | null
  readonly damaged: VarianceChoiceView | null
}

export interface ReceiptPreviewView {
  readonly poStatusAfter: 'PARTIALLY_RECEIVED' | 'RECEIVED'
  readonly linesOutstandingAfter: number
  readonly tolerancePct: number
  readonly lines: readonly PreviewLineView[]
}

export type ExcessChoice = 'RETURN_EXCESS' | 'ACCEPT_EXCESS'
export type DamagedChoice = 'RETURN_REPLACE' | 'ACCEPT_DAMAGED'

/** One line of a receipt as the form sends it; quantities are decimal text */
export interface ReceiptLineInput {
  readonly poLineId: string
  readonly received: string
  readonly rejected: string
  /** The refused goods are damaged (a photo is needed, BR-GR-05) */
  readonly damaged: boolean
  readonly remark: string
  readonly excessDisposition?: ExcessChoice
  readonly damagedDisposition?: DamagedChoice
}

export interface ReceiptInput {
  readonly poId: string
  readonly deliveryNoteNo: string
  readonly notes: string
  readonly photoFileIds: readonly string[]
  readonly lines: readonly ReceiptLineInput[]
  /** What the receiver confirmed of the quantities the AI read from the delivery note (FR-AI-303 AC4) */
  readonly aiAssist?: { readonly agentActionId: string; readonly confirmedPaths: readonly string[] }
}

export type VarianceTypeView = 'OVER' | 'SHORT' | 'DAMAGED'
export type VarianceDispositionView = 'ACCEPT_EXCESS' | 'RETURN_EXCESS' | 'ACCEPT_DAMAGED' | 'RETURN_REPLACE' | 'CLOSE_SHORT'
export type VarianceStatusView = 'RECORDED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED'

export interface VarianceView {
  readonly id: string
  readonly description: string
  readonly uom: string
  readonly type: VarianceTypeView
  readonly disposition: VarianceDispositionView
  readonly status: VarianceStatusView
  readonly quantity: string
  readonly amount: string | null
  readonly reason: string | null
}

export interface ReceiptView {
  readonly id: string
  readonly number: string | null
  readonly status: 'DRAFT' | 'POSTED' | 'REVERSED'
  /** Formatted date and time in the reader's language */
  readonly when: string
  readonly receiver: NameView | null
  readonly deliveryNoteNo: string | null
  readonly notes: string | null
  readonly reverseReason: string | null
  /** `refused`: refused as damaged or for another reason (null when nothing was); an excess is told by its variance */
  readonly lines: ReadonlyArray<{ readonly poLineId: string; readonly description: string; readonly uom: string; readonly received: string; readonly accepted: string; readonly refused: string | null; readonly remark: string | null }>
  readonly photos: ReadonlyArray<{ readonly fileId: string; readonly fileName: string }>
  readonly variances: readonly VarianceView[]
}

/** PROCUREMENT asks to close the PO although goods are still to come (CLOSE_SHORT, FR-P2P-010 AC2) */
export interface CloseShortPlanView {
  readonly lines: ReadonlyArray<{ readonly poLineId: string; readonly description: string; readonly uom: string; readonly quantity: string; readonly amount: string }>
  readonly total: string
  readonly approvers: readonly ApproverView[]
}

// What the screens get of a Document Agent result (FR-AI-303 AC1, docs/sub-specs/S13.md "หน้าจอ"): plain data from the
// server action (src/app/_lib/ai-actions.ts), never the AgentAction row itself.

export interface AiReadLine {
  readonly description: string | null
  readonly qty: string | null
  readonly unit: string | null
  readonly unitPrice: string | null
  readonly amount: string | null
}

export interface AiReadingView {
  readonly docNo: string | null
  readonly docDate: string | null
  readonly sellerName: string | null
  readonly sellerTaxId: string | null
  readonly sellerBranch: string | null
  readonly priceIncludesVat: boolean | null
  readonly net: string | null
  readonly vat: string | null
  readonly gross: string | null
  readonly lines: readonly AiReadLine[]
}

/** Something the checks or the mapping found, said under the values: a code of the checks or of the mapping, with a line */
export interface AiNote {
  readonly code: string
  readonly tone: 'warning' | 'danger' | 'info'
  /** A line of the document (from 1) or of the PO */
  readonly line?: number
}

export interface AiResultView {
  readonly id: string
  readonly status: 'PENDING' | 'DRAFT' | 'FAILED' | 'ACCEPTED' | 'EDITED' | 'REJECTED' | 'EXPIRED'
  readonly errorCode: string | null
  /** The form values the AI proposes, by form path, as text */
  readonly proposed: Readonly<Record<string, string>>
  /** Paths confirmed one by one (BR-AI-16); the others may be confirmed together */
  readonly requiredPaths: readonly string[]
  readonly reading: AiReadingView | null
  readonly notes: readonly AiNote[]
  /** Intake: a type that fits better than the form opened (FR-AI-302 AC2) */
  readonly suggestedType: { readonly code: string; readonly name: string } | null
  /** Intake: the supplier named but not in the register, as text */
  readonly supplierText: string | null
}

export type AiStartOutcome = { readonly ok: true; readonly agentActionId: string } | { readonly ok: false; readonly code: string; readonly reason?: string }
export type AiResultOutcome = { readonly ok: true; readonly result: AiResultView } | { readonly ok: false; readonly code: string }

export interface AiReadActions {
  readonly start: (input: { fileId: string; purpose: 'QUOTATION' | 'DELIVERY_NOTE'; subject?: { type: 'REQUEST' | 'PURCHASE_ORDER'; id: string } }, idempotencyKey: string) => Promise<AiStartOutcome>
  readonly result: (agentActionId: string) => Promise<AiResultOutcome>
  readonly fileUrl: (fileId: string) => Promise<string | null>
}

/** What the form keeps of one AI result it took values from, until the person confirmed them all */
export interface AiReview {
  readonly agentActionId: string
  readonly proposed: Readonly<Record<string, string>>
  readonly requiredPaths: readonly string[]
  /** The paths the person confirmed; a value they changed counts as confirmed on the server (BR-AI-17) */
  readonly confirmed: readonly string[]
}

/** The same, as a saved draft brings it back (src/server/services/ai/assist-contract.ts openAssists) */
export interface AiReviewDraft {
  readonly agentActionId: string
  readonly proposed: Readonly<Record<string, string>>
  readonly requiredPaths: readonly string[]
  readonly confirmedPaths: readonly string[]
}

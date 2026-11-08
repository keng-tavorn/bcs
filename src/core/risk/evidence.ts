import { normalizeScope } from '../supplier-docs'
import type { AnswerSource } from './score'
import type { RiskQuestionDef } from './types'

// BR-RSK-05: a question answered by a supplier document of a linked type, and BR-RSK-13: the status of an assessment on a
// day. Dates are calendar days in Asia/Bangkok written YYYY-MM-DD, so they order as text. Pure.

// The scope of a document or of the work is compared after S7's normalizeScope (BR-SDOC ข้อ 03: NFC, trimmed, lower case,
// runs of white space one space), the one definition S7 S10 and S11 share (SEAM-S7xS11-X-13)
export { normalizeScope }

/** A SupplierDocument of a type whose linkedRiskQuestionCodes holds the question (S7) */
export interface EvidenceDocument {
  readonly id?: string
  /** SupplierDocument.status: only VERIFIED counts */
  readonly status: string
  /** null = the document does not expire */
  readonly expiresOn: string | null
  readonly scope?: string | null
}

/** The answer saved so far, when it was taken from evidence (evidenceDocumentId set) */
export interface CurrentAnswer {
  readonly source: AnswerSource
  readonly optionCode: string | null
  readonly evidenceDocumentId: string | null
}

export type EvidenceReason = 'NOT_LINKED' | 'NO_DOCUMENT' | 'NOT_VERIFIED' | 'EXPIRED' | 'SCOPE_MISMATCH'

export type EvidenceResult =
  /** EVIDENCE for an answer filled from the document; the source of a confirmed answer stays as it was */
  | { readonly source: 'EVIDENCE' | 'EXPLICIT' | 'ON_BEHALF'; readonly optionCode: string }
  /** clearAnswer: the saved answer came from this document and is emptied, with the event source EVIDENCE_REVOKED */
  | { readonly source: 'NONE'; readonly reason: EvidenceReason; readonly clearAnswer?: true; readonly event?: 'EVIDENCE_REVOKED' }

export interface EvidenceInput {
  readonly workScopes: readonly string[]
  readonly document: EvidenceDocument | null
  readonly current?: CurrentAnswer | null
  readonly today: string
}

function check(question: RiskQuestionDef, input: EvidenceInput): EvidenceReason | null {
  const doc = input.document
  if (!doc) return 'NO_DOCUMENT'
  if (doc.status !== 'VERIFIED') return 'NOT_VERIFIED'
  if (doc.expiresOn !== null && doc.expiresOn < input.today) return 'EXPIRED'
  if (question.evidenceScopeRequired === true) {
    const scope = normalizeScope(doc.scope ?? '')
    const wanted = normalizeScope(question.evidenceScope ?? '')
    if (scope === '' || scope !== wanted || !input.workScopes.some((w) => normalizeScope(w) === scope)) return 'SCOPE_MISMATCH'
  }
  return null
}

/**
 * BR-RSK-05: whether the document answers the question. It does when the question has an evidence option, the document
 * is VERIFIED and not expired on `today` (expiring today still counts), and, for a question that requires a scope, the
 * document's scope equals the question's evidenceScope and one of the work scopes after normalizeScope. An answer that
 * already holds this document is checked the same way and emptied when the document no longer counts.
 */
export function evidenceSource(question: RiskQuestionDef, input: EvidenceInput): EvidenceResult {
  const held = input.current?.evidenceDocumentId != null ? input.current : null
  const none = (reason: EvidenceReason): EvidenceResult => (held ? { source: 'NONE', reason, clearAnswer: true, event: 'EVIDENCE_REVOKED' } : { source: 'NONE', reason })
  const option = question.options.find((o) => o.evidence === true)
  if (!option) return none('NOT_LINKED')
  const reason = check(question, input)
  if (reason) return none(reason)
  return { source: held && held.source !== 'NONE' ? held.source : 'EVIDENCE', optionCode: option.code }
}

export type RiskDateStatus = 'CURRENT' | 'EXPIRING' | 'OVERDUE'

/** BR-RSK-13: OVERDUE after validUntil, EXPIRING from remindOn to validUntil (both counted), CURRENT before remindOn */
export function riskStatusAt(input: { readonly validUntil: string; readonly remindOn: string; readonly today: string }): RiskDateStatus {
  if (input.today > input.validUntil) return 'OVERDUE'
  return input.today >= input.remindOn ? 'EXPIRING' : 'CURRENT'
}

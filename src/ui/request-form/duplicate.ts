import type { DuplicateMatch, FormFailure } from './outcome'

// The send refused as like a request the requester sent before (S6-13 · FR-INT-103 · BR-DUP-05), for both forms — the
// workspace's and LIFF's, whose shell holds the reason in its first JavaScript (§9.4): pure, and nothing but types
// imported, so it costs the LIFF page next to nothing. Tested in tests/unit/request-flags.test.ts.

/**
 * S6-13 (FR-INT-103 · BR-DUP-05): the requests a refused send looks like, when the refusal is that the request is like
 * one the requester sent within the window and no reason was given (DUPLICATE_UNACKNOWLEDGED); null for any other
 * outcome. The review step then shows them with the reason to give, and the next send carries it.
 */
export function duplicateRefusal(f: FormFailure | null): readonly DuplicateMatch[] | null {
  if (!f || f.code !== 'VALIDATION_FAILED' || f.reason !== 'DUPLICATE_UNACKNOWLEDGED') return null
  return f.matched ?? []
}

/** A matched request as its link says it: its number once sent, else its title */
export const duplicateLabel = (m: DuplicateMatch): string => m.number ?? m.title

/** The reason the next send carries (trimmed), or why it cannot go: the panel is shown and the reason is empty */
export function duplicateReasonOf(shown: boolean, reason: string): { readonly ok: true; readonly duplicateReason?: string } | { readonly ok: false } {
  if (!shown) return { ok: true }
  const trimmed = reason.trim()
  return trimmed ? { ok: true, duplicateReason: trimmed } : { ok: false }
}

/** What the review step's panel shows and asks: the requests matched and the reason being written (both forms) */
export interface DuplicateAsk {
  readonly matched: readonly DuplicateMatch[]
  readonly reason: string
  readonly onReason: (reason: string) => void
  /** The send was pressed with the box empty */
  readonly missing: boolean
  /** Counts the presses that stopped for the empty box, so each one moves the focus to it again */
  readonly stops: number
}

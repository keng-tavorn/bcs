// The flags of a sent request in the words of its approver's pages (S6-13 · FR-INT-103 AC2 AC3 · BR-DUP-05): what the
// web task page, the web request page and the LIFF task page show, built from listRequestFlags' DTO by
// src/app/(workspace)/_tracking/request-flags.ts. Strings arrive translated, money formatted from satang text.

export type FlagKind = 'DUPLICATE' | 'SPLIT'

/** A request a flag matched, as a link to its page (the web or the LIFF one) */
export interface FlagLink {
  readonly href: string
  readonly label: string
}

export interface RequestFlagView {
  readonly key: string
  readonly kind: FlagKind
  /** The badge's word */
  readonly badge: string
  /** What the flag means, in a sentence (SPLIT: with the amount of them together) */
  readonly detail: string
  /** DUPLICATE: the requester's reason; SPLIT: the DOA rule of the largest alone and of them together */
  readonly note: { readonly label: string; readonly value: string } | null
  readonly matched: readonly FlagLink[]
}

export interface RequestFlagsView {
  readonly title: string
  readonly intro: string
  /** The list of matched requests, named for screen readers and written before it */
  readonly matchedLabel: string
  readonly flags: readonly RequestFlagView[]
}

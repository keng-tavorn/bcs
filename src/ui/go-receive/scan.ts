'use client'

import { looksLikeToken } from '@/lib/verification-token'
import type { PoCopy } from './store'

// Finding the PO of a QR scanned on site, or of a PO number typed in (S17-14, FR-PLT-301 AC6, BR-APP-11, OQ-163). A QR
// counts only when it is the link the printed PR or PO carries — <this origin>/verify/<token> (S6, BR-QR-01) —
// anything else is neither opened nor sent anywhere. Of the token, only its sha256 leaves this function: computed with
// WebCrypto as 64 lower-case hex digits, the form DocumentVerification.tokenHash keeps, it is matched against the
// copies on the phone (every printing of the PO, superseded ones too, so an older printout still finds it) and, with a
// signal, asked of the server (GET /api/go/resolve?h=), which answers the same "not found" for a PO out of the
// receiver's scope as for one that does not exist. The browser's PWA has no camera scanner: the receiver types the
// PO number, which is looked up in the copies on the phone.

/** The token of a BCS document's QR from this origin, or null for anything else */
export function scannedToken(raw: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null
  const match = /^\/verify\/([^/]+)$/.exec(url.pathname)
  return match && looksLikeToken(match[1]!) ? match[1]! : null
}

/** sha256 of the token's UTF-8 bytes, 64 lower-case hex digits (WebCrypto) */
export async function tokenHashOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type Found =
  | { readonly kind: 'COPY'; readonly copy: PoCopy; readonly from: 'PHONE' | 'SERVER' }
  /** Not a QR of BCS from this environment: nothing was opened or sent */
  | { readonly kind: 'NOT_BCS' }
  /** No PO the receiver may receive has it (the server's answer, or the copies without a signal) */
  | { readonly kind: 'NOT_FOUND' }
  /** Not among the copies on the phone, and no signal to ask */
  | { readonly kind: 'NOT_ON_PHONE' }
  /** The server did not answer what it found (a failure, too many requests): scan again */
  | { readonly kind: 'NO_ANSWER' }
  /** A number typed in that the copies on the phone do not hold, while they may not hold every PO (BR-APP-04) */
  | { readonly kind: 'NOT_AMONG_COPIES' }
  | { readonly kind: 'SIGNED_OUT' }
  | { readonly kind: 'MODULE_OFF' }

export interface FindContext {
  readonly origin: string
  readonly copies: readonly PoCopy[]
  readonly online: boolean
  /** fetch, as the page has it (a test passes its own) */
  readonly fetch: typeof fetch
}

/** The PO of a scanned QR: from the copies on the phone first, else from the server when there is a signal */
export async function findScanned(raw: string, ctx: FindContext): Promise<Found> {
  const token = scannedToken(raw, ctx.origin)
  if (!token) return { kind: 'NOT_BCS' }
  const hash = await tokenHashOf(token)
  const copy = ctx.copies.find((c) => c.tokenHashes.includes(hash))
  if (copy) return { kind: 'COPY', copy, from: 'PHONE' }
  if (!ctx.online) return { kind: 'NOT_ON_PHONE' }
  try {
    const res = await ctx.fetch(`/api/go/resolve?h=${hash}`, { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401) return { kind: 'SIGNED_OUT' }
    const body = (await res.json().catch(() => null)) as { copy?: PoCopy; error?: { code?: string } } | null
    if (res.status === 403 && body?.error?.code === 'MODULE_DISABLED') return { kind: 'MODULE_OFF' }
    if (res.ok && body?.copy) return { kind: 'COPY', copy: body.copy, from: 'SERVER' }
    // Only the server's own "not found" says so; anything else is no answer yet
    return res.status === 404 ? { kind: 'NOT_FOUND' } : { kind: 'NO_ANSWER' }
  } catch {
    return { kind: 'NOT_ON_PHONE' }
  }
}

/** "po-2569-00012 " → the copy of PO-2569-00012 on the phone, or null */
export function findTyped(typed: string, copies: readonly PoCopy[]): PoCopy | null {
  const wanted = typed.trim().toUpperCase()
  if (!wanted) return null
  return copies.find((c) => c.number?.toUpperCase() === wanted) ?? null
}

/**
 * What a typed number found. The copies hold every PO the receiver may receive only when they were prepared just now
 * with a signal and nothing was left out (maxPreparedPos): only then is a number they lack "not found"
 */
export function foundTyped(typed: string, copies: readonly PoCopy[], complete: boolean): Found {
  const copy = findTyped(typed, copies)
  if (copy) return { kind: 'COPY', copy, from: 'PHONE' }
  return complete ? { kind: 'NOT_FOUND' } : { kind: 'NOT_AMONG_COPIES' }
}

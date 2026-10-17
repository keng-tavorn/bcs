'use client'

import { afterRestart, afterSignIn, applyAnswer, applyLookups, beginSend, nextStep, photoSteps, type KeyLookup, type ServerResult, type Settled } from '@/core/offline-queue'
import { dropPhotosOf, readKnown, readPhoto, readQueue, updateQueue, writeKnown, type StoredItem, type StoredPhoto } from './store'

// Sends the queue of /go/receive when there is a signal (S17-13, FR-PLT-301 AC8, BR-APP-06, BR-APP-07, BR-APP-14):
// one step at a time, as src/core/offline-queue decides — the photos of the next item uploaded (a ticket, the PUT,
// the completion; a completion whose answer was lost asked again with the same ticket), then the receipt posted to
// /api/go/receiving/gr with the item's own key and the input it froze the first time, the answer applied, and an
// IDEMPOTENCY_CONFLICT checked with the server before anything else. The routes are at fixed URLs (BR-APP-03): the
// page's shell may come from an older build. One drain runs at a time; each step is written to the phone before the
// next, so closing the app at any moment leaves the item to go on with the same key. Every write changes the queue as
// it is then (./store.ts updateQueue), so a receipt saved while one is sending is never written over.
// The version a receipt expects is the copy's it was recorded on, or the newer one a receipt of the same PO that this
// phone sent answered (BR-APP-06): a copy prepared again after the receipt was recorded never moves it, so a PO that
// changed while there was no signal is refused (CONFLICT_VERSION), never received against figures nobody saw.

export interface DrainContext {
  /** The member signed in now, or null */
  readonly session: string | null
  readonly retentionDays: number
  readonly online: () => boolean
  readonly now: () => Date
}

export interface Drained {
  /** The server answered that nobody is signed in: the page asks for a sign-in */
  readonly signedOut: boolean
}

const json = { 'content-type': 'application/json' }
const iso = (d: Date) => d.toISOString()

type Answer = ServerResult & { readonly poVersion?: number }

async function call(url: string, init: RequestInit): Promise<{ answer: Answer; body: unknown; reason: string | null }> {
  try {
    const res = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' })
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; details?: { reason?: unknown } } } | null
    const reason = typeof body?.error?.details?.reason === 'string' ? body.error.details.reason : null
    return { answer: { http: res.status, ...(body?.error?.code ? { code: body.error.code } : {}) }, body, reason }
  } catch {
    return { answer: { network: true }, body: null, reason: null }
  }
}

/** The PO versions an item is sent with: its copy's, or the newer one the phone's own receipts of that PO answered */
export function knownFor(item: StoredItem, sent: Readonly<Record<string, number>>): Record<string, number> {
  return { ...sent, [item.poId]: Math.max(item.capturedOnVersion, sent[item.poId] ?? item.capturedOnVersion) }
}

/** BR-APP-14: a ticket the clock let lapse, or a PUT that never landed, asks for a new ticket, never the user */
const NEW_TICKET = new Set(['TICKET_INVALID', 'NOT_UPLOADED'])
const LATER: Answer = { network: true }
const freshTicket = (photo: StoredPhoto): StoredPhoto => {
  const { ticket: _ticket, ticketIssuedAt: _issued, ...rest } = photo
  return { ...rest, putDone: false }
}

/** The upload steps of one photo: the photo as it is now, and the answer that stopped it (null when it is done) */
async function uploadPhoto(photo: StoredPhoto, step: 'COMPLETE_SAME_TICKET' | 'REQUEST_NEW_TICKET', now: () => Date): Promise<{ photo: StoredPhoto; stop: Answer | null }> {
  let current = photo
  if (step === 'REQUEST_NEW_TICKET') {
    const blob = await readPhoto(photo.localId)
    // The phone cleared the picture (storage under pressure): the receiver takes it again
    if (!blob) return { photo, stop: { http: 400, code: 'PHOTO_MISSING' } }
    const asked = await call('/api/go/files/request', { method: 'POST', headers: json, body: JSON.stringify({ fileName: photo.fileName, mimeType: blob.type, sizeBytes: blob.size }) })
    const ticket = asked.body as { uploadUrl?: string; ticket?: string } | null
    if (asked.answer.http !== 200 || !ticket?.uploadUrl || !ticket.ticket) return { photo, stop: asked.reason ? { http: asked.answer.http ?? 400, code: asked.reason } : asked.answer }
    current = { ...photo, ticket: ticket.ticket, ticketIssuedAt: iso(now()), putDone: false }
    const put = await fetch(ticket.uploadUrl, { method: 'PUT', body: blob, headers: { 'content-type': blob.type } }).catch(() => null)
    await put?.arrayBuffer().catch(() => null)
    // No answer, a storage that failed, or an address whose signature lapsed: a new ticket next time
    if (!put?.ok) return { photo: freshTicket(current), stop: LATER }
    current = { ...current, putDone: true }
  }
  const done = await call('/api/go/files/complete', { method: 'POST', headers: json, body: JSON.stringify({ ticket: current.ticket }) })
  const file = done.body as { fileId?: string } | null
  if (done.answer.http === 200 && file?.fileId) {
    const { ticket: _ticket, ...uploaded } = current
    return { photo: { ...uploaded, fileId: file.fileId }, stop: null }
  }
  if (done.reason && NEW_TICKET.has(done.reason)) return { photo: freshTicket(current), stop: LATER }
  // A file the server refuses (TYPE_NOT_ALLOWED TOO_LARGE EMPTY CONTENT_MISMATCH) needs the receiver: NEEDS_ATTENTION
  return { photo: current, stop: done.reason ? { http: done.answer.http ?? 400, code: done.reason } : done.answer }
}

/** Applies an answer to the queue as it is now; the photos of what was recorded go from the phone (BR-APP-09) */
async function settle(apply: (items: readonly StoredItem[]) => Settled, known: Readonly<Record<string, number>>): Promise<Settled> {
  const out: { settled?: Settled; recorded: StoredItem[] } = { recorded: [] }
  await updateQueue((all) => {
    const settled = apply(all)
    out.settled = settled
    out.recorded = all.filter((i) => settled.sent.includes(i.key))
    return settled.items as StoredItem[]
  })
  await dropPhotosOf(out.recorded)
  return out.settled ?? { items: [], knownVersion: known, photosLeft: 0, sent: [] }
}

/** The item about to be posted, frozen as it is now in the queue; null when it is no longer there */
async function beginSending(key: string, known: Readonly<Record<string, number>>): Promise<StoredItem | null> {
  const out: { item?: StoredItem } = {}
  await updateQueue((all) =>
    all.map((i) => {
      if (i.key !== key) return i
      out.item = beginSend(i, knownFor(i, known)) as StoredItem
      return out.item
    }),
  )
  return out.item ?? null
}

let running: Promise<Drained> | null = null

/** One drain of the queue; a call while one runs waits for it */
export function drainQueue(ctx: DrainContext): Promise<Drained> {
  running ??= drain(ctx).finally(() => {
    running = null
  })
  return running
}

async function drain(ctx: DrainContext): Promise<Drained> {
  let signedOut = false
  for (let guard = 0; guard < DRAIN_STEPS_MAX; guard++) {
    const items = await readQueue()
    // the versions this member's own receipts were answered with (BR-APP-06), never another member's on the same phone
    const known = ctx.session ? await readKnown(ctx.session) : {}
    // An item waiting for its check goes first: never with a new key (BR-APP-07)
    const checking = items.filter((i) => i.status === 'CHECK_SERVER' && i.by === ctx.session)
    if (checking.length && ctx.online()) {
      const lookups: Record<string, KeyLookup> = {}
      for (const item of checking) {
        const found = await call(`/api/go/receiving/gr?key=${encodeURIComponent(item.key)}`, { method: 'GET' })
        const body = found.body as { recorded?: boolean; result?: { ok?: boolean; data?: { poVersion?: number }; error?: { code?: string } } } | null
        if (found.answer.http === 401) return { signedOut: true }
        if (found.answer.http !== 200 || !body) return { signedOut }
        lookups[item.key] = !body.recorded
          ? { recorded: false }
          : body.result?.ok
            ? { recorded: true, ok: true, poVersion: body.result.data?.poVersion ?? knownFor(item, known)[item.poId]! }
            : { recorded: true, ok: false, code: body.result?.error?.code ?? 'UNKNOWN' }
      }
      const settled = await settle((all) => applyLookups(all, lookups, iso(ctx.now()), known), known)
      if (ctx.session) await writeKnown(ctx.session, settled.knownVersion)
      continue
    }
    const step = nextStep({ now: iso(ctx.now()), online: ctx.online(), session: ctx.session, items, knownVersion: known, retentionDays: ctx.retentionDays })
    if (!step.next) return { signedOut }
    const item = items.find((i) => i.key === step.next)!
    if (step.step === 'UPLOAD') {
      const steps = photoSteps(item.photos, iso(ctx.now()))
      let stop: Answer | null = null
      for (const [n, s] of steps.entries()) {
        if (s === 'DONE') continue
        const up = await uploadPhoto(item.photos[n]!, s, ctx.now)
        // Every photo's progress is kept at once: an app closed here goes on from it. The photo is found by its own id:
        // the receiver may have corrected the receipt meanwhile (never sent, so it may be)
        await updateQueue((all) => all.map((i) => (i.key === item.key ? { ...i, status: 'UPLOADING', photos: i.photos.map((p) => (p.localId === up.photo.localId ? up.photo : p)) } : i)))
        if (up.stop) {
          stop = up.stop
          break
        }
      }
      if (stop) {
        const answer = stop
        await settle((all) => applyAnswer(all, item.key, answer, iso(ctx.now()), known), known)
        if (stop.http === 401) signedOut = true
        if (stop.network || stop.http === 401) return { signedOut }
      }
      continue
    }
    // POST: the input is frozen the first time and sent unchanged ever after (BR-APP-05)
    const sending = await beginSending(item.key, known)
    // Thrown away, or deleted at sign-out, before it went
    if (!sending) continue
    const frozen = sending.frozen!
    const posted = await call('/api/go/receiving/gr', {
      method: 'POST',
      headers: { ...json, 'idempotency-key': sending.key },
      body: JSON.stringify({
        poId: sending.poId,
        lines: sending.payload.lines,
        ...(sending.payload.deliveryNoteNo ? { deliveryNoteNo: sending.payload.deliveryNoteNo } : {}),
        ...(sending.payload.notes ? { notes: sending.payload.notes } : {}),
        photoFileIds: frozen.photoFileIds,
        offline: { capturedAt: sending.capturedAt, capturedByMemberId: sending.by, expectedPoVersion: frozen.expectedPoVersion },
      }),
    })
    const result = posted.body as { poVersion?: unknown } | null
    const ok = (posted.answer.http ?? 0) >= 200 && (posted.answer.http ?? 0) < 300
    const answer: Answer = ok ? { http: posted.answer.http!, ...(typeof result?.poVersion === 'number' ? { poVersion: result.poVersion } : {}) } : posted.answer
    const settled = await settle((all) => applyAnswer(all, sending.key, answer, iso(ctx.now()), known), known)
    if (ctx.session) await writeKnown(ctx.session, settled.knownVersion)
    if (posted.answer.http === 401) return { signedOut: true }
    if (posted.answer.network || (posted.answer.http ?? 0) >= 500) return { signedOut }
  }
  return { signedOut }
}

/** No queue holds more items than this: a drain stops after it so a fault never spins */
const DRAIN_STEPS_MAX = 200

/** The app was closed while an item was uploading or posting: it goes again at once with the same key (BR-APP-10) */
export async function resumeAfterRestart(now: Date): Promise<void> {
  await updateQueue((all) => afterRestart(all, iso(now)) as StoredItem[])
}

/** The owner is signed in again: their items waiting for it go on */
export async function resumeAfterSignIn(member: string, now: Date): Promise<void> {
  await updateQueue((all) => afterSignIn(all, member, iso(now)) as StoredItem[])
}

/** BR-APP-09: before signing out online, the items whose result is not known go now with their keys */
export async function sendUnknownNow(ctx: DrainContext): Promise<void> {
  if (!ctx.session || !ctx.online()) return
  const at = iso(ctx.now())
  const member = ctx.session
  await updateQueue((all) => afterSignIn(all, member, at).map((i) => (i.status === 'RETRY' && i.by === member ? { ...i, nextTryAt: at } : i)) as StoredItem[])
  await drainQueue(ctx)
}

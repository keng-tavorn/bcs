import { MS_PER_DAY, MS_PER_MINUTE } from '../money/constants'

// The receiving queue of the BCS Go app, kept on the phone (S17-11, FR-PLT-301 AC7 to AC9, BR-APP-05 to BR-APP-10,
// BR-APP-14, ADR-164, golden offline-queue). Pure: the page /go/receive keeps the items in IndexedDB, makes each item's
// key (uuid v7) and capture time when the receiver saves, reads the clock and the network, and calls these to decide
// what to do next with what the server answered. Nothing here reads a clock, makes a random value or touches storage.
//
// An item goes QUEUED → (UPLOADING while its photos get file ids) → SENDING (its input frozen the first time: the key,
// the PO version it expects and the photos' file ids; attempts + 1) → SENT, gone from the phone. A send that gets no
// answer or a server error is RETRY with a growing wait; a signed-out session is WAIT_LOGIN; IDEMPOTENCY_CONFLICT is
// CHECK_SERVER (ask what the key recorded, never send with a new key); every other refusal is NEEDS_ATTENTION. One item
// at a time, the oldest capture first, never before an earlier item of the same PO is settled; other POs go on. An item
// once sent keeps its key and input for life, so one item makes at most one GR (BR-APP-10); only an item never sent, or
// refused, may be edited (a new item with a new key) or thrown away, and only those expire.

export type QueueStatus = 'QUEUED' | 'UPLOADING' | 'SENDING' | 'RETRY' | 'WAIT_LOGIN' | 'CHECK_SERVER' | 'NEEDS_ATTENTION' | 'EXPIRED'

export interface QueuePhoto {
  /** The file the server stored (FileObject id): the photo is uploaded */
  readonly fileId?: string
  /** The PUT to storage went through, the completion's answer is not known */
  readonly putDone?: boolean
  /** When the upload ticket was given (ISO): a ticket lives 15 minutes */
  readonly ticketIssuedAt?: string
}

export interface FrozenInput {
  readonly expectedPoVersion: number
  readonly photoFileIds: readonly string[]
}

export interface QueueItem {
  /** The idempotencyKey of gr.post for this item's whole life (uuid v7 made by the page, BR-APP-05) */
  readonly key: string
  readonly poId: string
  /** The member who saved it (capturedByMemberId) */
  readonly by: string
  /** When it was saved on the phone (ISO) */
  readonly capturedAt: string
  readonly status: QueueStatus
  /** How many times gr.post was sent (photo uploads do not count) */
  readonly attempts: number
  /** Tries that failed for now, in a row: the wait before the next */
  readonly failures?: number
  /** RETRY: not before this (ISO) */
  readonly nextTryAt?: string | null
  /** The input sent the first time and every time after */
  readonly frozen?: FrozenInput | null
  readonly photos?: readonly QueuePhoto[]
  /** NEEDS_ATTENTION: the server's error code (§14.2) */
  readonly code?: string | null
  /** NEEDS_ATTENTION after CHECK_SERVER found nothing recorded for the key */
  readonly reason?: 'NOT_RECORDED' | null
  /** NEEDS_ATTENTION with CONFLICT_VERSION: when it failed, and when the copy of the PO was last prepared (ISO) */
  readonly failedAt?: string | null
  readonly copyPreparedAt?: string | null
}

const MS_PER_SECOND = MS_PER_MINUTE / 60
/** BR-APP-06: the first wait after a failure, doubled after each, never more than RETRY_MAX_WAIT_S */
export const RETRY_FIRST_WAIT_S = 15
export const RETRY_MAX_WAIT_S = 300
/** BR-APP-14: a ticket lives 15 minutes; a completion is tried with the same ticket only while it is younger than this */
export const TICKET_REUSE_S = 14 * 60

const ms = (iso: string) => Date.parse(iso)
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z')

// ---------------------------------------------------------------- answers ----------------------------------------------

export type SendOutcome = 'SENT' | 'RETRY' | 'WAIT_LOGIN' | 'CHECK_SERVER' | 'NEEDS_ATTENTION'

/** What gr.post answered, as the page saw it: no answer at all (network, no http), or the HTTP status with its §14.2 code */
export interface ServerResult {
  readonly network?: true
  readonly http?: number
  readonly code?: string
}

/** BR-APP-07 */
export function outcomeOf(result: ServerResult): SendOutcome {
  if (result.http === undefined) return 'RETRY'
  if (result.http >= 200 && result.http < 300) return 'SENT'
  if (result.http >= 500 || result.code === 'RATE_LIMITED') return 'RETRY'
  if (result.code === 'UNAUTHENTICATED' || result.http === 401) return 'WAIT_LOGIN'
  if (result.code === 'IDEMPOTENCY_CONFLICT') return 'CHECK_SERVER'
  return 'NEEDS_ATTENTION'
}

/** BR-APP-06: the wait before the next try after this many failures in a row */
export function retryWaitSeconds(failures: number): number {
  return Math.min(RETRY_FIRST_WAIT_S * 2 ** (Math.max(1, failures) - 1), RETRY_MAX_WAIT_S)
}

// ---------------------------------------------------------------- what is next ----------------------------------------

/** Still waiting for its result or for the user: an earlier item of the same PO like this holds the later ones */
const UNSETTLED: ReadonlySet<QueueStatus> = new Set(['QUEUED', 'UPLOADING', 'SENDING', 'RETRY', 'WAIT_LOGIN', 'NEEDS_ATTENTION', 'CHECK_SERVER'])
/** Never sent, or refused: may be edited, thrown away, and expire (BR-APP-05, BR-APP-09) */
const neverSent = (i: QueueItem) => i.attempts === 0 && i.status !== 'SENDING' && i.status !== 'CHECK_SERVER' && i.status !== 'NEEDS_ATTENTION'
const settledByUser = (i: QueueItem) => i.status === 'NEEDS_ATTENTION'

export interface QueueView {
  readonly now: string
  readonly online: boolean
  /** The member signed in now, or null */
  readonly session: string | null
  readonly items: readonly QueueItem[]
  /** The PO versions the phone knows: from the copies, then from what successful sends answered */
  readonly knownVersion: Readonly<Record<string, number>>
  /** bcsGo.offlineRetentionDays of the organization (1 to 30) */
  readonly retentionDays: number
}

export type Wait = 'PREVIOUS_NEEDS_ATTENTION' | 'PREVIOUS_PENDING'

export interface NextStep {
  /** The item to work on now, or null */
  readonly next: string | null
  /** UPLOAD its photos, or POST it */
  readonly step: 'UPLOAD' | 'POST' | null
  /** The PO version the POST carries: the frozen one, else the latest the phone knows */
  readonly expectedPoVersion: number | null
  /** Items held behind an earlier item of the same PO */
  readonly waiting: Readonly<Record<string, Wait>>
  /** Items of another member than the one signed in: kept, not sent, shown as a count (BR-APP-09) */
  readonly held: Readonly<Record<string, 'OTHER_MEMBER'>>
  /** Nobody is signed in: the queue waits for a sign-in */
  readonly waitLogin: boolean
  /** Items past offlineRetentionDays that were never sent or were refused: shown, not sent, may be thrown away */
  readonly expired: readonly string[]
}

/** Never sent or refused, and saved longer ago than the organization keeps them (exactly retentionDays still keeps) */
export function isExpired(item: QueueItem, now: string, retentionDays: number): boolean {
  if (!(neverSent(item) || settledByUser(item))) return false
  return ms(now) - ms(item.capturedAt) > retentionDays * MS_PER_DAY
}

// Keys are unique in a queue (uuid v7), so two items never compare equal
const byCapture = (a: QueueItem, b: QueueItem) => ms(a.capturedAt) - ms(b.capturedAt) || (a.key < b.key ? -1 : 1)
const photosReady = (i: QueueItem) => (i.photos ?? []).every((p) => p.fileId !== undefined)

/** BR-APP-06, BR-APP-09: what the queue does now */
export function nextStep(view: QueueView): NextStep {
  const expired = view.items.filter((i) => i.status === 'EXPIRED' || isExpired(i, view.now, view.retentionDays)).map((i) => i.key)
  const gone = new Set(expired)
  const live = view.items.filter((i) => !gone.has(i.key))
  const held: Record<string, 'OTHER_MEMBER'> = {}
  const waiting: Record<string, Wait> = {}
  const none = { next: null, step: null, expectedPoVersion: null } as const
  if (view.session === null) return { ...none, waiting, held, waitLogin: true, expired }
  for (const i of live) if (i.by !== view.session) held[i.key] = 'OTHER_MEMBER'
  const mine = live.filter((i) => i.by === view.session).sort(byCapture)
  const candidates: QueueItem[] = []
  for (const item of mine) {
    const earlier = mine.find((o) => o.poId === item.poId && o !== item && byCapture(o, item) < 0 && UNSETTLED.has(o.status))
    if (earlier) {
      waiting[item.key] = earlier.status === 'NEEDS_ATTENTION' ? 'PREVIOUS_NEEDS_ATTENTION' : 'PREVIOUS_PENDING'
      continue
    }
    const due = item.status === 'QUEUED' || item.status === 'UPLOADING' || (item.status === 'RETRY' && (!item.nextTryAt || ms(item.nextTryAt) <= ms(view.now)))
    if (due) candidates.push(item)
  }
  const chosen = view.online ? candidates[0] : undefined
  if (!chosen) return { ...none, waiting, held, waitLogin: false, expired }
  const expectedPoVersion = chosen.frozen?.expectedPoVersion ?? view.knownVersion[chosen.poId] ?? null
  return { next: chosen.key, step: chosen.frozen || photosReady(chosen) ? 'POST' : 'UPLOAD', expectedPoVersion, waiting, held, waitLogin: false, expired }
}

// ---------------------------------------------------------------- moving an item --------------------------------------

/**
 * The item about to be posted: input frozen the first time (the version it expects and the photos' file ids), the
 * same input every time after (BR-APP-05); attempts + 1
 */
export function beginSend(item: QueueItem, knownVersion: Readonly<Record<string, number>>): QueueItem {
  const frozen = item.frozen ?? { expectedPoVersion: knownVersion[item.poId]!, photoFileIds: (item.photos ?? []).map((p) => p.fileId!) }
  return { ...item, status: 'SENDING', attempts: item.attempts + 1, frozen, nextTryAt: null }
}

export interface Settled {
  /** The queue without the item when it was recorded (SENT), else with the item in its new state */
  readonly items: readonly QueueItem[]
  readonly knownVersion: Readonly<Record<string, number>>
  /** Photos to delete from the phone now: those of an item that was recorded */
  readonly photosLeft: number
  readonly sent: readonly string[]
}

/** BR-APP-07, BR-APP-09: what gr.post answered for this item */
export function applyAnswer(items: readonly QueueItem[], key: string, answer: ServerResult & { readonly poVersion?: number }, now: string, knownVersion: Readonly<Record<string, number>>): Settled {
  const item = items.find((i) => i.key === key)
  if (!item) return { items, knownVersion, photosLeft: photoCount(items), sent: [] }
  const outcome = outcomeOf(answer)
  if (outcome === 'SENT') {
    const rest = items.filter((i) => i.key !== key)
    return { items: rest, knownVersion: answer.poVersion !== undefined ? { ...knownVersion, [item.poId]: answer.poVersion } : knownVersion, photosLeft: photoCount(rest), sent: [key] }
  }
  const failures = (item.failures ?? 0) + 1
  const next: QueueItem =
    outcome === 'RETRY'
      ? { ...item, status: 'RETRY', failures, nextTryAt: iso(ms(now) + retryWaitSeconds(failures) * MS_PER_SECOND) }
      : outcome === 'NEEDS_ATTENTION'
        ? { ...item, status: 'NEEDS_ATTENTION', code: answer.code ?? null, failedAt: now }
        : { ...item, status: outcome }
  return { items: items.map((i) => (i.key === key ? next : i)), knownVersion, photosLeft: photoCount(items), sent: [] }
}

const photoCount = (items: readonly QueueItem[]) => items.reduce((n, i) => n + (i.photos?.length ?? 0), 0)

/** What GET /api/go/receiving/gr?key= said for an item in CHECK_SERVER: the result the key recorded, or none */
export type KeyLookup = { readonly recorded: true; readonly ok: true; readonly poVersion: number } | { readonly recorded: true; readonly ok: false; readonly code: string } | { readonly recorded: false }

/** BR-APP-07: a recorded success is SENT, a recorded refusal or no record at all needs the user; never a new key */
export function applyLookups(items: readonly QueueItem[], lookups: Readonly<Record<string, KeyLookup>>, now: string, knownVersion: Readonly<Record<string, number>>): Settled {
  let versions = knownVersion
  const sent: string[] = []
  const out: QueueItem[] = []
  for (const item of items) {
    const found = item.status === 'CHECK_SERVER' ? lookups[item.key] : undefined
    if (!found) {
      out.push(item)
    } else if (found.recorded && found.ok) {
      sent.push(item.key)
      versions = { ...versions, [item.poId]: found.poVersion }
    } else {
      out.push(found.recorded ? { ...item, status: 'NEEDS_ATTENTION', code: found.code, failedAt: now } : { ...item, status: 'NEEDS_ATTENTION', code: null, reason: 'NOT_RECORDED', failedAt: now })
    }
  }
  return { items: out, knownVersion: versions, photosLeft: photoCount(out), sent }
}

/** The app closed while an item was uploading or posting: it goes again at once, with the same key (BR-APP-10) */
export function afterRestart(items: readonly QueueItem[], at: string): QueueItem[] {
  return items.map((i) => (i.status === 'SENDING' || i.status === 'UPLOADING' ? { ...i, status: 'RETRY', nextTryAt: at } : i))
}

/** The owner signed in again: their items waiting for it go on */
export function afterSignIn(items: readonly QueueItem[], member: string, at: string): QueueItem[] {
  return items.map((i) => (i.status === 'WAIT_LOGIN' && i.by === member ? { ...i, status: 'RETRY', nextTryAt: at } : i))
}

// ---------------------------------------------------------------- photos ----------------------------------------------

export type PhotoStep = 'DONE' | 'COMPLETE_SAME_TICKET' | 'REQUEST_NEW_TICKET'

/** BR-APP-14: per photo, what the upload needs next */
export function photoSteps(photos: readonly QueuePhoto[], now: string): PhotoStep[] {
  return photos.map((p) => {
    if (p.fileId !== undefined) return 'DONE'
    if (p.putDone && p.ticketIssuedAt && ms(now) - ms(p.ticketIssuedAt) < TICKET_REUSE_S * MS_PER_SECOND) return 'COMPLETE_SAME_TICKET'
    return 'REQUEST_NEW_TICKET'
  })
}

// ---------------------------------------------------------------- the user --------------------------------------------

export type EditRight = 'EDIT_IN_PLACE' | 'RESUBMIT_NEW_KEY' | 'REFRESH_COPY_FIRST' | 'LOCKED'

/**
 * BR-APP-05: an item never sent is edited where it is; a refused one is sent again as a new item with a new key, and a
 * version conflict needs a copy of the PO prepared after the refusal first; anything sent whose result is not known
 * is locked
 */
export function editRight(item: QueueItem): EditRight {
  if (neverSent(item)) return 'EDIT_IN_PLACE'
  if (item.status !== 'NEEDS_ATTENTION') return 'LOCKED'
  if (item.code === 'CONFLICT_VERSION' && !(item.copyPreparedAt && item.failedAt && ms(item.copyPreparedAt) >= ms(item.failedAt))) return 'REFRESH_COPY_FIRST'
  return 'RESUBMIT_NEW_KEY'
}

export function discardRight(item: QueueItem): 'ALLOWED' | 'LOCKED' {
  return neverSent(item) || settledByUser(item) || item.status === 'EXPIRED' ? 'ALLOWED' : 'LOCKED'
}

export type SignOutWarning = 'NOT_SENT' | 'MAY_BE_RECORDED' | 'REJECTED'

/**
 * BR-APP-09: signing out in the app. Online, the items whose result is not known go first with their keys; then the
 * user is warned by kind and the queue of that user is deleted once they confirm
 */
export function signOutPlan(online: boolean, items: readonly QueueItem[]): { sendFirst: string[]; warn: Record<string, SignOutWarning>; deleteOnConfirm: string[] } {
  const warn: Record<string, SignOutWarning> = {}
  const sendFirst: string[] = []
  for (const i of items) {
    if (neverSent(i) || i.status === 'EXPIRED') warn[i.key] = 'NOT_SENT'
    else if (i.status === 'NEEDS_ATTENTION') warn[i.key] = 'REJECTED'
    else {
      warn[i.key] = 'MAY_BE_RECORDED'
      if (online) sendFirst.push(i.key)
    }
  }
  return { sendFirst, warn, deleteOnConfirm: items.map((i) => i.key) }
}

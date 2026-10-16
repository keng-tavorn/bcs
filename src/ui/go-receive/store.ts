'use client'

import { createStore, del, get, set, type UseStore } from 'idb-keyval'
import type { QueueItem, QueuePhoto } from '@/core/offline-queue'

// What /go/receive keeps on the phone (S17-13, BR-APP-03, BR-APP-09): IndexedDB of this origin through idb-keyval, in a
// database of its own — the copies of the POs the receiver prepared, the queue of receipts with what the form said,
// the photos as they were shrunk, and the PO versions the phone knows. Nothing else of the business is kept on the
// device, and every receipt and photo goes once the server recorded it. A storage the browser refuses (a private
// window) gives nothing on reading and false on writing: the page says a receipt could not be kept.

export interface PoLineCopy {
  readonly poLineId: string
  readonly description: string
  readonly uom: string
  readonly ordered: string
  readonly received: string
  readonly cancelled: string
}

export interface PoCopy {
  readonly poId: string
  readonly number: string | null
  readonly version: number
  readonly status: 'SENT' | 'PARTIALLY_RECEIVED'
  readonly sentAt: string | null
  readonly supplier: string
  readonly site: string | null
  readonly overTolerancePct: number
  readonly lines: readonly PoLineCopy[]
  readonly tokenHashes: readonly string[]
  readonly preparedAt: string
}

export interface Prepared {
  /** Whose copies they are: the member signed in when they were prepared */
  readonly memberId: string
  readonly copies: readonly PoCopy[]
  readonly truncated: boolean
  readonly retentionDays: number
  readonly preparedAt: string
}

export interface ReceiptLine {
  readonly poLineId: string
  readonly received: string
  readonly rejected: string
  readonly damagedDisposition?: 'RETURN_REPLACE' | 'ACCEPT_DAMAGED'
  readonly excessDisposition?: 'RETURN_EXCESS' | 'ACCEPT_EXCESS'
  readonly remark?: string
}

/** What the receiver entered: sent unchanged every time (BR-APP-05) */
export interface ReceiptPayload {
  readonly lines: readonly ReceiptLine[]
  readonly deliveryNoteNo: string
  readonly notes: string
}

export type StoredPhoto = QueuePhoto & {
  /** The shrunk picture kept on the phone until the receipt is recorded */
  readonly localId: string
  readonly fileName: string
  /** The upload ticket while the PUT or the completion is under way */
  readonly ticket?: string
}

export type StoredItem = Omit<QueueItem, 'photos'> & {
  readonly payload: ReceiptPayload
  readonly photos: readonly StoredPhoto[]
  /** The PO's number and supplier, to name the item while its copy may be gone */
  readonly poNumber: string | null
  readonly supplier: string
  /**
   * The version of the copy the receipt was recorded on (BR-APP-06): what it expects unless a receipt of the same PO
   * that this phone sent after it was recorded answered a newer one — a copy prepared again later never moves it
   */
  readonly capturedOnVersion: number
}

const PREPARED = 'prepared'
const QUEUE = 'queue'
/** The PO versions the phone's own receipts were answered with (BR-APP-06); a copy prepared never writes here */
const KNOWN = 'sent-versions'
const photoKey = (localId: string) => `photo:${localId}`

let store: UseStore | null = null
const db = () => (store ??= createStore('bcs-go-receive', 'kv'))

async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
}

export const readPrepared = () => safe(async () => (await get<Prepared>(PREPARED, db())) ?? null, null)
export const writePrepared = (prepared: Prepared) => safe(async () => (await set(PREPARED, prepared, db()), true), false)
export const readQueue = () => safe(async () => (await get<StoredItem[]>(QUEUE, db())) ?? [], [] as StoredItem[])
const writeQueue = (items: readonly StoredItem[]) => safe(async () => (await set(QUEUE, items, db()), true), false)

let queueTurn: Promise<unknown> = Promise.resolve()

/**
 * Every change to the queue reads it and writes it back in its turn: the page saving a receipt and the queue sending
 * one never write over each other's change. False when the phone would not keep it.
 */
export function updateQueue(change: (items: readonly StoredItem[]) => readonly StoredItem[]): Promise<boolean> {
  const turn = queueTurn.then(async () => writeQueue(change(await readQueue())))
  queueTurn = turn.catch(() => undefined)
  return turn
}
export const readKnown = () => safe(async () => (await get<Record<string, number>>(KNOWN, db())) ?? {}, {} as Record<string, number>)
export const writeKnown = (known: Readonly<Record<string, number>>) => safe(async () => (await set(KNOWN, known, db()), true), false)
export const readPhoto = (localId: string) => safe(async () => (await get<Blob>(photoKey(localId), db())) ?? null, null)
export const writePhoto = (localId: string, blob: Blob) => safe(async () => (await set(photoKey(localId), blob, db()), true), false)
export const deletePhoto = (localId: string) => safe(async () => (await del(photoKey(localId), db()), true), false)

/** BR-APP-09: what is gone from the queue goes from the phone with its photos */
export async function dropPhotosOf(items: readonly StoredItem[]): Promise<void> {
  for (const item of items) for (const p of item.photos) await deletePhoto(p.localId)
}

/** Signing out with the receiver's confirmation: their queue, copies and photos go (BR-APP-09) */
export async function forgetMember(memberId: string): Promise<void> {
  await forgetItems((i) => i.by === memberId)
  const prepared = await readPrepared()
  if (prepared?.memberId === memberId) await safe(async () => (await del(PREPARED, db()), true), false)
}

/** BR-APP-09: the receipts another member left on the phone, deleted by the member signed in once they confirm */
export async function forgetOthers(memberId: string): Promise<void> {
  await forgetItems((i) => i.by !== memberId)
}

async function forgetItems(gone: (item: StoredItem) => boolean): Promise<void> {
  let dropped: StoredItem[] = []
  let left = 0
  await updateQueue((items) => {
    dropped = items.filter(gone)
    left = items.length - dropped.length
    return items.filter((i) => !gone(i))
  })
  await dropPhotosOf(dropped)
  // The versions the phone's receipts were answered with matter only while a receipt of that PO is waiting
  if (left === 0) await safe(async () => (await del(KNOWN, db()), true), false)
}

/** BR-APP-03: ask the browser to keep this storage; false when it may clear it under pressure */
export async function askToKeep(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

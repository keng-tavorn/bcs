'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { BYTES_PER_KIB, MS_PER_SECOND } from '@/lib/constants'
import type { DraftSave } from './model'
import { closedWhy, type ClosedWhy, type FormFailure } from './outcome'

// Drafts save themselves (FR-INT-006 AC1): 10 seconds after the requester stops typing, and when they leave the page —
// another page of the app, another tab or app, closing or reloading. Every save names the version it is based on; a
// save from another device in between gives CONFLICT_VERSION (AC2), and from then on nothing is saved until the
// requester reloads the latest version. One save runs at a time. When a save got no answer, the next try sends the same
// body with the same idempotency key, so a save that did reach the server is replayed instead of being taken for a
// conflict.
// Leaving: moving to another page of the app keeps this page's script running, so a plain request finishes. Closing or
// reloading the tab ends it, and only a keepalive request outlives that — browsers refuse keepalive bodies above 64 KiB.
// So a draft too large for keepalive is saved while the tab goes into the background (still running), and the browser
// asks before closing a page whose latest changes it could not take along (beforeunload).

export const AUTOSAVE_IDLE_MS = 10 * MS_PER_SECOND
/** Below the 64 KiB keepalive limit of browsers, with room for the request line and headers */
export const KEEPALIVE_MAX_BYTES = 60 * BYTES_PER_KIB

export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly at: string }
  | { readonly kind: 'error'; readonly failure: FormFailure | null }
  | { readonly kind: 'conflict' }
  /** The request was sent or cancelled elsewhere, is gone, or is no longer the requester's to edit: `why`, as the server said */
  | { readonly kind: 'closed'; readonly why: ClosedWhy }

export type SaveAnswer = { readonly ok: true; readonly requestId: string; readonly version: number; readonly lineIds: readonly string[] } | FormFailure

export interface SavedParts {
  readonly lines: ReadonlyArray<{ readonly key: string; readonly id: string }>
  readonly quotations: readonly string[]
  /** The AI reading the save carried (aiAssist), if any */
  readonly ai: { readonly agentActionId: string; readonly mark: string } | null
}

export interface AutosaveOptions {
  /** POST endpoint of the autosave route */
  readonly url: string
  readonly requestTypeCode: string
  readonly initialRequestId: string | null
  readonly initialVersion: number | null
  /** What to send now; isNew: no draft exists yet (the first save creates it) */
  readonly getPayload: (isNew: boolean) => DraftSave
  /** The first save created the draft */
  readonly onCreated: (requestId: string) => void
  /** A save went through: the lines it carried with their ids, the quotations it carried */
  readonly onSaved: (parts: SavedParts) => void
}

export interface Autosave {
  readonly state: SaveState
  /** The draft's id once it exists (for rendering) */
  readonly requestId: string | null
  /** The draft's id right now, also right after a save in the same event handler */
  readonly id: () => string | null
  /** The version of the last save; the submit names it */
  readonly version: () => number | null
  /** Call after every edit */
  readonly changed: () => void
  /** Save now (force: create the draft even if nothing was typed, e.g. to attach a file). True when the latest edits are saved. */
  readonly saveNow: (options?: { force?: boolean; keepalive?: boolean }) => Promise<boolean>
  /** No more saves (after the request was sent) */
  readonly stop: () => void
  /** Why saving stopped for good, right now (also in the event handler that awaited the save): a conflict, the request closed, or null */
  readonly halted: () => 'conflict' | 'closed' | null
}

/** HTTP statuses of the route (§14.2) for an answer that is not the route's own JSON (a proxy refusing a large body) */
const BY_STATUS: Readonly<Record<number, FormFailure>> = {
  401: { ok: false, code: 'UNAUTHENTICATED' },
  403: { ok: false, code: 'FORBIDDEN' },
  413: { ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' },
  429: { ok: false, code: 'RATE_LIMITED' },
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength

interface Pending {
  readonly seq: number
  readonly body: string
  readonly save: DraftSave
}

export function useAutosave(options: AutosaveOptions): Autosave {
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const [requestId, setRequestId] = useState<string | null>(options.initialRequestId)
  const opts = useRef(options)
  const idRef = useRef<string | null>(options.initialRequestId)
  const versionRef = useRef<number | null>(options.initialVersion)
  const edits = useRef(0)
  const saved = useRef(0)
  const stopped = useRef(false)
  /** Why saving stopped for good (a conflict, the request closed); null while it goes on, or once stopped after sending */
  const haltedBy = useRef<'conflict' | 'closed' | null>(null)
  const pending = useRef<Pending | null>(null)
  const running = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    opts.current = options
  })

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  /** The request a save sends now: the one that got no answer (a retry), or one for the current edits */
  const nextRequest = useCallback((): Pending => {
    if (pending.current) return pending.current
    const save = opts.current.getPayload(idRef.current === null)
    const body = JSON.stringify({ idempotencyKey: uuidv4(), requestId: idRef.current, requestTypeCode: opts.current.requestTypeCode, expectedVersion: versionRef.current, draft: save.draft })
    pending.current = { seq: edits.current, body, save }
    return pending.current
  }, [])

  /** One request; keepalive only when the body fits the browsers' limit (a larger one goes as a plain request) */
  const attempt = useCallback(
    async (keepalive: boolean): Promise<boolean> => {
      const { seq, body, save } = nextRequest()
      if (!keepalive) setState({ kind: 'saving' })
      let answer: SaveAnswer | null = null
      try {
        const response = await fetch(opts.current.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          credentials: 'same-origin',
          keepalive: keepalive && byteLength(body) <= KEEPALIVE_MAX_BYTES,
        })
        answer = await response
          .json()
          .then((j: unknown) => j as SaveAnswer)
          .catch(() => BY_STATUS[response.status] ?? null)
      } catch {
        answer = null
      }
      if (!answer) {
        setState({ kind: 'error', failure: null })
        return false
      }
      pending.current = null
      if (answer.ok) {
        const created = idRef.current === null
        idRef.current = answer.requestId
        versionRef.current = answer.version
        saved.current = seq
        const lineIds = answer.lineIds
        opts.current.onSaved({ lines: (save.lineKeys ?? []).flatMap((key, i) => (lineIds[i] ? [{ key, id: lineIds[i]! }] : [])), quotations: save.quotationKeys ?? [], ai: save.ai ?? null })
        if (created) {
          setRequestId(answer.requestId)
          opts.current.onCreated(answer.requestId)
        }
        const latest = edits.current === seq
        setState(latest ? { kind: 'saved', at: new Date().toISOString() } : { kind: 'dirty' })
        return latest
      }
      if (answer.code === 'CONFLICT_VERSION') {
        stopped.current = true
        haltedBy.current = 'conflict'
        clearTimer()
        setState({ kind: 'conflict' })
        return false
      }
      // S6-16: an amount or budget line changed while an over-budget approval waits is refused, but the request is still
      // the requester's draft — said as a save error, and the next edit (the amount put back) saves again
      if (answer.code === 'INVALID_STATE_TRANSITION' && answer.reason === 'OVERRUN_PENDING') {
        setState({ kind: 'error', failure: answer })
        return false
      }
      if (answer.code === 'INVALID_STATE_TRANSITION' || answer.code === 'NOT_FOUND' || answer.code === 'FORBIDDEN') {
        stopped.current = true
        haltedBy.current = 'closed'
        clearTimer()
        // What stopped it, as the server said: the request's status, or that it is gone or not this account's
        setState({ kind: 'closed', why: closedWhy(answer) })
        return false
      }
      setState({ kind: 'error', failure: answer })
      return false
    },
    [nextRequest],
  )

  const saveNow = useCallback(
    async ({ force = false, keepalive = false }: { force?: boolean; keepalive?: boolean } = {}): Promise<boolean> => {
      clearTimer()
      if (running.current) {
        // The page is closing while a save runs: send that same save again with keepalive (the same idempotency key, so
        // the server keeps one), as the running one may die with the page. Newer edits cannot follow: beforeunload warned.
        if (keepalive) {
          const retry = pending.current
          if (retry && byteLength(retry.body) <= KEEPALIVE_MAX_BYTES) {
            void fetch(opts.current.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: retry.body, credentials: 'same-origin', keepalive: true }).catch(() => undefined)
          }
          return false
        }
        await running.current
      }
      if (stopped.current) return false
      const nothingNew = edits.current === saved.current && !pending.current
      if (nothingNew && (idRef.current !== null || !force)) return idRef.current !== null
      const run = attempt(keepalive).finally(() => {
        running.current = null
      })
      running.current = run
      return run
    },
    [attempt],
  )

  const changed = useCallback(() => {
    edits.current++
    if (stopped.current) return
    setState({ kind: 'dirty' })
    clearTimer()
    timer.current = setTimeout(() => void saveNow(), AUTOSAVE_IDLE_MS)
  }, [saveNow])

  const saveRef = useRef(saveNow)
  useEffect(() => {
    saveRef.current = saveNow
  })
  useEffect(() => {
    const unsaved = () => !stopped.current && (edits.current !== saved.current || pending.current !== null)
    /** Whether the latest edits can still go out with the page as it closes */
    const fitsKeepalive = () => {
      if (running.current) return false
      const save = opts.current.getPayload(idRef.current === null)
      return byteLength(JSON.stringify({ requestId: idRef.current, draft: save.draft })) <= KEEPALIVE_MAX_BYTES
    }
    // Closing or reloading: the browser asks first when the latest changes cannot be taken along
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (unsaved() && !fitsKeepalive()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    const onPageHide = () => {
      if (unsaved()) void saveRef.current({ keepalive: true })
    }
    // Another tab or app: the page still runs, so even a large draft goes out (keepalive when it fits)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && unsaved() && !running.current) void saveRef.current({ keepalive: true })
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      // Another page of the app: this script keeps running, so a plain request finishes whatever the size
      if (unsaved()) void saveRef.current()
    }
  }, [])

  const stop = useCallback(() => {
    stopped.current = true
    clearTimer()
  }, [])

  const version = useCallback(() => versionRef.current, [])
  const id = useCallback(() => idRef.current, [])
  const halted = useCallback(() => haltedBy.current, [])

  return { state, requestId, id, version, changed, saveNow, stop, halted }
}

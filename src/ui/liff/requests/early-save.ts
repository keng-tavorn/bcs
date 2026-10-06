import { BYTES_PER_KIB, MS_PER_SECOND } from '@/lib/constants'
import type { FormValues } from '../../request-form/model'
import { newUuid } from './key'

// The draft's save when the requester leaves before the form's engine arrived (FR-INT-006 AC1 "…และเมื่อออกจากหน้า"):
// LINE's window closes, they go back to the chat, or they open another page of the LIFF app. The LIFF form's first
// screen carries step 1 only; its rules and the workspace's autosave (./engine.tsx, which saves on leaving the page too)
// come with the first touch. On a slow mobile network a requester may type a title, or answer a question, and leave
// before they arrive. Those edits — only step 1's: the title, the budget line, the type's questions — go to the LIFF
// autosave route with a keepalive request, which outlives the page, as the workspace's autosave does when a page closes
// (the form's shell, ./request-form.tsx, calls save()). The payload is the part of the workspace's draftPayload
// (src/ui/request-form/model.ts) those edits change — the same values under the same names; a new draft also takes the
// site the form opened with (BR-FORM-02) — so the next save of the engine goes on from it
// (tests/unit/liff-requests.test.tsx compares the two). Small enough for keepalive (browsers allow 64 KiB).
// As the workspace's autosave: one save at a time, each based on the answer of the one before (the draft's id and
// version). A save that got no answer — no connection, or none within EARLY_SAVE_TIMEOUT_MS — goes again as it was, with
// its idempotency key, before anything newer: if it did reach the server, the server answers it again rather than
// making a second draft (spec §4.3). A leave while a save runs is not dropped: the save goes again once that one has its
// answer (the page is still running then, or the request went with the page). The engine's autosave starts only when
// no early save is on its way or unanswered (the form's shell), from the draft and version the last one gave.

/** The step-1 parts of a draft as the workspace's draftPayload writes them (isNew: the save creates the draft) */
export function earlyDraft(values: FormValues, typeName: string, isNew: boolean, titleMax: number): Record<string, unknown> {
  const title = values.title.trim().slice(0, titleMax)
  return {
    ...(title ? { title } : isNew ? { title: typeName.slice(0, titleMax) } : {}),
    ...(values.budgetLineId ? { budgetLineId: values.budgetLineId } : isNew ? {} : { budgetLineId: null }),
    // Step 1 does not change the site or the supplier: a new draft takes the ones the form opened with
    ...(isNew && values.deliverySiteId ? { deliverySiteId: values.deliverySiteId } : {}),
    ...(isNew && values.suggestedSupplierId ? { suggestedSupplierId: values.suggestedSupplierId } : {}),
    priceIncludesVat: values.priceIncludesVat,
    formData: { ...values.fields },
  }
}

/** Below the 64 KiB keepalive limit of browsers, as the workspace's autosave keeps it */
const KEEPALIVE_MAX_BYTES = 60 * BYTES_PER_KIB
/** A save with no answer by then counts as unanswered (a stalled mobile connection): it goes again later, with its key */
export const EARLY_SAVE_TIMEOUT_MS = 15 * MS_PER_SECOND

/** The draft a save is based on: none yet (null), or its id and the version of its last save */
export interface EarlyBase {
  readonly requestId: string | null
  readonly version: number | null
}

export interface EarlyState {
  /** A save is on its way */
  readonly saving: boolean
  /** The last save got no answer: it goes again, as it was, before any other */
  readonly unanswered: boolean
  /** Edits no early save has saved yet */
  readonly unsaved: boolean
  readonly base: EarlyBase
}

export interface EarlySaverOptions {
  readonly url: string
  readonly requestTypeCode: string
  readonly typeName: string
  readonly titleMax: number
  readonly base: EarlyBase
  /** The form's values now */
  readonly values: () => FormValues
  /** A save started or has its answer; `created`: that save made the draft */
  readonly onState: (state: EarlyState, created: boolean) => void
  /** The browser's fetch, unless a test hands another */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export interface EarlySaver {
  /** An edit of step 1 */
  readonly changed: () => void
  /** Saves what is not saved yet; called while a save runs, it goes again once that one has its answer */
  readonly save: () => void
  readonly state: () => EarlyState
}

type Answer = { readonly ok: true; readonly requestId: string; readonly version: number } | { readonly ok: false }

export function createEarlySaver(options: EarlySaverOptions): EarlySaver {
  const send = options.fetch ?? ((url, init) => fetch(url, init))
  let base = options.base
  let edits = 0
  let saved = 0
  let pending: { readonly seq: number; readonly body: string } | null = null
  let running = false
  let again = false
  const state = (): EarlyState => ({ saving: running, unanswered: pending !== null && !running, unsaved: edits !== saved, base })

  /** One request: the route's answer, or null when none came (no connection, the time limit, not the route's JSON) */
  async function post(body: string): Promise<Answer | null> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), EARLY_SAVE_TIMEOUT_MS)
    try {
      const response = await send(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'same-origin',
        keepalive: new TextEncoder().encode(body).byteLength <= KEEPALIVE_MAX_BYTES,
        signal: abort.signal,
      })
      const answer = (await response.json()) as { ok?: unknown; requestId?: unknown; version?: unknown } | null
      if (answer?.ok === true && typeof answer.requestId === 'string' && typeof answer.version === 'number') return { ok: true, requestId: answer.requestId, version: answer.version }
      return answer?.ok === false ? { ok: false } : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  function save(): void {
    if (running) {
      again = true
      return
    }
    if (!pending && edits === saved) return
    pending ??= {
      seq: edits,
      body: JSON.stringify({
        idempotencyKey: newUuid(),
        requestId: base.requestId,
        requestTypeCode: options.requestTypeCode,
        expectedVersion: base.version,
        draft: earlyDraft(options.values(), options.typeName, base.requestId === null, options.titleMax),
      }),
    }
    const sent = pending
    running = true
    options.onState(state(), false)
    void post(sent.body).then((answer) => {
      running = false
      const created = answer?.ok === true && base.requestId === null
      if (answer) {
        // Answered: a refusal leaves the edits unsaved, for the engine's autosave to save again and say why
        pending = null
        if (answer.ok) {
          base = { requestId: answer.requestId, version: answer.version }
          saved = sent.seq
        }
      }
      options.onState(state(), created)
      if (again) {
        again = false
        save()
      }
    })
  }

  return {
    changed: () => {
      edits++
    },
    save,
    state,
  }
}

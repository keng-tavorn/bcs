import { describe, expect, it } from 'vitest'
import {
  afterRestart,
  applyAnswer,
  applyLookups,
  beginSend,
  discardRight,
  editRight,
  nextStep,
  outcomeOf,
  photoSteps,
  retryWaitSeconds,
  signOutPlan,
  type KeyLookup,
  type QueueItem,
  type QueuePhoto,
  type QueueStatus,
  type ServerResult,
} from '@/core/offline-queue'
import { loadYaml } from './doa-fixtures'

// tests/golden/offline-queue.yaml (spec §7.20, S17-11, BR-APP-05 to BR-APP-10, BR-APP-14): the receiving queue of the
// BCS Go app. Each case names what it gives; the runner calls the function that answers it and compares only what the
// case expects. The receiver signed in is store_p07 unless the case says otherwise, and so is the one who saved an item.

const RETENTION_DAYS = 7
const DEFAULT_MEMBER = 'store_p07'

interface RawItem {
  key: string
  po?: string
  by?: string
  capturedAt?: string
  status: QueueStatus
  attempts?: number
  nextTryAt?: string
  frozen?: { expectedPoVersion: number; photoFileIds?: string[] }
  photos?: number | QueuePhoto[]
  code?: string
  copyPreparedAt?: string
  failedAt?: string
}
interface Case {
  id: string
  title?: string
  input: {
    results?: ServerResult[]
    failuresSoFar?: number[]
    now?: string
    online?: boolean
    session?: string | null
    items?: RawItem[]
    knownVersion?: Record<string, number>
    serverAnswers?: 'ALL_OK_VERSION_PLUS_1'
    photos?: QueuePhoto[]
    restartAt?: string
    answer?: ServerResult & { poVersion?: number }
    lookup?: Record<string, KeyLookup>
  }
  expect: Record<string, unknown>
}

const suite = loadYaml<{ cases: Case[] }>('offline-queue.yaml')

const itemOf = (r: RawItem): QueueItem => ({
  key: r.key,
  poId: r.po ?? `PO-${r.key}`,
  by: r.by ?? DEFAULT_MEMBER,
  capturedAt: r.capturedAt ?? '2026-11-02T00:00:00Z',
  status: r.status,
  attempts: r.attempts ?? 0,
  ...(r.nextTryAt ? { nextTryAt: r.nextTryAt } : {}),
  ...(r.frozen ? { frozen: { expectedPoVersion: r.frozen.expectedPoVersion, photoFileIds: r.frozen.photoFileIds ?? [] } } : {}),
  ...(typeof r.photos === 'number' ? { photos: Array.from({ length: r.photos }, (_, i) => ({ fileId: `f${i + 1}` })) } : r.photos ? { photos: r.photos } : {}),
  ...(r.code ? { code: r.code } : {}),
  ...(r.copyPreparedAt ? { copyPreparedAt: r.copyPreparedAt } : {}),
  ...(r.failedAt ? { failedAt: r.failedAt } : {}),
})

/** The item as the cases write it back: what they name only */
const shown = (i: QueueItem) => ({
  key: i.key,
  status: i.status,
  ...(i.attempts ? { attempts: i.attempts } : {}),
  ...(i.nextTryAt ? { nextTryAt: i.nextTryAt } : {}),
  ...(i.frozen ? { frozen: i.frozen.photoFileIds.length ? i.frozen : { expectedPoVersion: i.frozen.expectedPoVersion } } : {}),
  ...(i.code ? { code: i.code } : {}),
  ...(i.reason ? { reason: i.reason } : {}),
})

function run(c: Case): Record<string, unknown> {
  const i = c.input
  if (i.results) return { outcomes: i.results.map(outcomeOf) }
  if (i.failuresSoFar) return { waitSeconds: i.failuresSoFar.map(retryWaitSeconds) }
  if (i.photos) return { steps: photoSteps(i.photos, i.now!) }
  const items = (i.items ?? []).map(itemOf)
  const known = i.knownVersion ?? {}
  if (i.restartAt) return { items: afterRestart(items, i.restartAt).map(shown) }
  if (i.answer) {
    const done = applyAnswer(items, items[0]!.key, i.answer, '2026-11-02T03:00:00Z', known)
    return { items: done.items.map(shown), photosLeft: done.photosLeft, knownVersion: done.knownVersion }
  }
  if (i.lookup) {
    const done = applyLookups(items, i.lookup, '2026-11-02T03:00:00Z', known)
    return { sent: done.sent, items: done.items.map((x) => ({ key: x.key, status: x.status, ...(x.code ? { code: x.code } : {}), ...(x.reason ? { reason: x.reason } : {}) })), knownVersion: done.knownVersion }
  }
  if (i.now === undefined && i.online === false) return signOutPlan(false, items)
  if (i.now === undefined) {
    return { edit: Object.fromEntries(items.map((x) => [x.key, editRight(x)])), discard: Object.fromEntries(items.map((x) => [x.key, discardRight(x)])) }
  }
  const view = { now: i.now, online: i.online ?? true, session: i.session === undefined ? DEFAULT_MEMBER : i.session, knownVersion: known, retentionDays: RETENTION_DAYS }
  if (i.serverAnswers === 'ALL_OK_VERSION_PLUS_1') {
    // Every send recorded, each answering the PO's version one up: the order the queue sends in, and what each expects
    let queue = items
    let versions = known
    const sendOrder: Array<{ key: string; expectedPoVersion: number | null }> = []
    for (let step = nextStep({ ...view, items: queue, knownVersion: versions }); step.next; step = nextStep({ ...view, items: queue, knownVersion: versions })) {
      sendOrder.push({ key: step.next, expectedPoVersion: step.expectedPoVersion })
      queue = queue.map((x) => (x.key === step.next ? beginSend(x, versions) : x))
      const done = applyAnswer(queue, step.next, { http: 201, poVersion: step.expectedPoVersion! + 1 }, view.now, versions)
      queue = [...done.items]
      versions = done.knownVersion
    }
    return { sendOrder }
  }
  const step = nextStep({ ...view, items })
  const chosen = items.find((x) => x.key === step.next)
  const begun = chosen && step.step === 'POST' ? beginSend(chosen, known) : null
  return {
    next: step.next,
    key: step.next,
    expectedPoVersion: step.expectedPoVersion,
    step: step.step,
    waiting: step.waiting,
    held: step.held,
    waitLogin: step.waitLogin,
    expired: step.expired,
    ...(begun ? { status: begun.status, attempts: begun.attempts, frozen: begun.frozen } : {}),
  }
}

describe('golden offline-queue.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const got = run(c)
      expect(Object.fromEntries(Object.keys(c.expect).map((k) => [k, got[k]]))).toEqual(c.expect)
    })
  }
})

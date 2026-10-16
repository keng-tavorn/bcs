// S17-11 (FR-PLT-301 AC8 AC9, BR-APP-05 to BR-APP-10, BR-APP-14): the branches of src/core/offline-queue the golden
// cases leave out, so every path of the queue on the phone has a test (branch coverage 100%).
import { describe, expect, it } from 'vitest'
import {
  afterRestart,
  afterSignIn,
  applyAnswer,
  applyLookups,
  beginSend,
  discardRight,
  editRight,
  isExpired,
  nextStep,
  outcomeOf,
  photoSteps,
  retryWaitSeconds,
  signOutPlan,
  type QueueItem,
} from '@/core/offline-queue'

const NOW = '2026-11-02T03:00:00Z'
const item = (over: Partial<QueueItem> = {}): QueueItem => ({ key: 'k1', poId: 'PO-A', by: 'me', capturedAt: '2026-11-02T01:00:00Z', status: 'QUEUED', attempts: 0, ...over })
const view = (items: QueueItem[], over: Partial<Parameters<typeof nextStep>[0]> = {}) => ({ now: NOW, online: true, session: 'me', items, knownVersion: { 'PO-A': 4, 'PO-B': 2 }, retentionDays: 7, ...over })

describe('[FR-PLT-301/AC8] what the queue sends next (BR-APP-06)', () => {
  it('uploads the photos first, then posts once every photo has its file', () => {
    expect(nextStep(view([item({ photos: [{ fileId: 'f1' }, {}] })]))).toMatchObject({ next: 'k1', step: 'UPLOAD', expectedPoVersion: 4 })
    expect(nextStep(view([item({ photos: [{ fileId: 'f1' }] })]))).toMatchObject({ next: 'k1', step: 'POST' })
    expect(nextStep(view([item()]))).toMatchObject({ next: 'k1', step: 'POST' })
  })

  it('a retry with no time set goes at once; a PO the phone knows no version of posts without one', () => {
    expect(nextStep(view([item({ status: 'RETRY', attempts: 1, nextTryAt: null, frozen: { expectedPoVersion: 3, photoFileIds: [] } })]))).toMatchObject({ next: 'k1', step: 'POST', expectedPoVersion: 3 })
    expect(nextStep(view([item({ poId: 'PO-Z' })]))).toMatchObject({ next: 'k1', expectedPoVersion: null })
  })

  it('an item being sent, waiting for a sign-in or for its check holds the later items of its PO, and is not picked itself', () => {
    for (const status of ['SENDING', 'WAIT_LOGIN', 'CHECK_SERVER'] as const) {
      const step = nextStep(view([item({ status, attempts: 1 }), item({ key: 'k2', capturedAt: '2026-11-02T02:00:00Z' })]))
      expect(step, status).toMatchObject({ next: null, waiting: { k2: 'PREVIOUS_PENDING' } })
    }
  })

  it('ties of capture time go by key, so every phone sends in the same order', () => {
    expect(nextStep(view([item({ key: 'k2', poId: 'PO-B' }), item({ key: 'k1' })])).next).toBe('k1')
    expect(nextStep(view([item({ key: 'k1' }), item({ key: 'k2', poId: 'PO-B' })])).next).toBe('k1')
  })

  it('an item marked EXPIRED stays expired and is not sent', () => {
    expect(nextStep(view([item({ status: 'EXPIRED' })]))).toMatchObject({ next: null, expired: ['k1'] })
  })
})

describe('[FR-PLT-301/AC8] answers of the server (BR-APP-07)', () => {
  it('reads a 401 without a code as signed out, and a 4xx it does not know as needing the user', () => {
    expect(outcomeOf({ http: 401 })).toBe('WAIT_LOGIN')
    expect(outcomeOf({ http: 409 })).toBe('NEEDS_ATTENTION')
    expect(outcomeOf({ http: 204 })).toBe('SENT')
  })

  it('waits 15 s after the first failure and never more than 5 minutes', () => {
    expect(retryWaitSeconds(0)).toBe(15)
    expect(retryWaitSeconds(30)).toBe(300)
  })

  it('a retry waits by its failures in a row; a refusal keeps its code; a sign-out waits; a conflict checks the server', () => {
    const sending = beginSend(item(), { 'PO-A': 4 })
    const retry = applyAnswer([sending], 'k1', { network: true }, NOW, { 'PO-A': 4 }).items[0]!
    expect(retry).toMatchObject({ status: 'RETRY', failures: 1, nextTryAt: '2026-11-02T03:00:15Z', attempts: 1 })
    const again = applyAnswer([beginSend(retry, { 'PO-A': 4 })], 'k1', { http: 503 }, NOW, { 'PO-A': 4 }).items[0]!
    expect(again).toMatchObject({ status: 'RETRY', failures: 2, nextTryAt: '2026-11-02T03:00:30Z', attempts: 2, frozen: { expectedPoVersion: 4 } })
    expect(applyAnswer([sending], 'k1', { http: 409, code: 'CONFLICT_VERSION' }, NOW, {}).items[0]).toMatchObject({ status: 'NEEDS_ATTENTION', code: 'CONFLICT_VERSION', failedAt: NOW })
    expect(applyAnswer([sending], 'k1', { http: 418 }, NOW, {}).items[0]).toMatchObject({ status: 'NEEDS_ATTENTION', code: null })
    expect(applyAnswer([sending], 'k1', { http: 401, code: 'UNAUTHENTICATED' }, NOW, {}).items[0]).toMatchObject({ status: 'WAIT_LOGIN' })
    expect(applyAnswer([sending], 'k1', { http: 409, code: 'IDEMPOTENCY_CONFLICT' }, NOW, {}).items[0]).toMatchObject({ status: 'CHECK_SERVER' })
    // The other items of the queue stay as they were
    const other = item({ key: 'k2', poId: 'PO-B' })
    expect(applyAnswer([sending, other], 'k1', { http: 500 }, NOW, {}).items[1]).toBe(other)
  })

  it('a success without a version keeps what the phone knew; an answer for an item no longer here changes nothing', () => {
    const known = { 'PO-A': 4 }
    expect(applyAnswer([beginSend(item({ photos: [{ fileId: 'f1' }] }), known)], 'k1', { http: 201 }, NOW, known)).toEqual({ items: [], knownVersion: known, photosLeft: 0, sent: ['k1'] })
    const queue = [item({ photos: [{ fileId: 'f1' }] })]
    expect(applyAnswer(queue, 'gone', { http: 201, poVersion: 9 }, NOW, known)).toEqual({ items: queue, knownVersion: known, photosLeft: 1, sent: [] })
  })

  it('checks only items waiting for their check, and leaves the rest', () => {
    const queue = [item({ status: 'QUEUED' }), item({ key: 'k2', status: 'CHECK_SERVER', attempts: 1 })]
    expect(applyLookups(queue, { k1: { recorded: false } }, NOW, {}).items).toEqual(queue)
  })

  it('a member signing in again resumes only their own items that waited for it', () => {
    const queue = [item({ status: 'WAIT_LOGIN', attempts: 1 }), item({ key: 'k2', by: 'other', status: 'WAIT_LOGIN', attempts: 1 }), item({ key: 'k3' })]
    expect(afterSignIn(queue, 'me', NOW).map((i) => [i.key, i.status, i.nextTryAt ?? null])).toEqual([
      ['k1', 'RETRY', NOW],
      ['k2', 'WAIT_LOGIN', null],
      ['k3', 'QUEUED', null],
    ])
    expect(afterRestart([item({ status: 'UPLOADING' }), item({ key: 'k2' })], NOW).map((i) => i.status)).toEqual(['RETRY', 'QUEUED'])
  })
})

describe('[FR-PLT-301/AC9] keeping, editing and throwing away (BR-APP-05, BR-APP-09)', () => {
  it('only items never sent or refused expire, after the organization keeps them', () => {
    expect(isExpired(item({ capturedAt: '2026-10-01T00:00:00Z' }), NOW, 7)).toBe(true)
    expect(isExpired(item({ capturedAt: '2026-10-01T00:00:00Z', status: 'SENDING', attempts: 1 }), NOW, 7)).toBe(false)
    expect(isExpired(item({ capturedAt: '2026-10-01T00:00:00Z' }), NOW, 30)).toBe(true)
    expect(isExpired(item({ capturedAt: '2026-10-20T00:00:00Z' }), NOW, 30)).toBe(false)
  })

  it('a version conflict whose copy was prepared again after the refusal is sent again with a new key', () => {
    expect(editRight(item({ status: 'NEEDS_ATTENTION', attempts: 1, code: 'CONFLICT_VERSION', failedAt: '2026-11-02T02:00:00Z', copyPreparedAt: '2026-11-02T02:30:00Z' }))).toBe('RESUBMIT_NEW_KEY')
    expect(editRight(item({ status: 'NEEDS_ATTENTION', attempts: 1, code: 'CONFLICT_VERSION' }))).toBe('REFRESH_COPY_FIRST')
    expect(discardRight(item({ status: 'EXPIRED' }))).toBe('ALLOWED')
  })

  it('signing out online sends first what may be recorded; an expired item counts as not sent', () => {
    expect(signOutPlan(true, [item({ status: 'RETRY', attempts: 1 }), item({ key: 'k2', status: 'EXPIRED' })])).toEqual({ sendFirst: ['k1'], warn: { k1: 'MAY_BE_RECORDED', k2: 'NOT_SENT' }, deleteOnConfirm: ['k1', 'k2'] })
  })

  it('a photo with its file is done; a ticket without a finished PUT is never reused', () => {
    expect(photoSteps([{ putDone: true }, { ticketIssuedAt: '2026-11-02T02:59:00Z' }], NOW)).toEqual(['REQUEST_NEW_TICKET', 'REQUEST_NEW_TICKET'])
  })
})

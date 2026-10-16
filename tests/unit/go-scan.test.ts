// S17-14 (FR-PLT-301 AC6, BR-APP-11, OQ-163): what /go/receive does with a QR scanned on site or a PO number typed in.
// Only <this origin>/verify/<token> counts, and only the token's sha256 leaves the page: matched against the copies on
// the phone (older printings too), else asked of the server by hash. The server's side is in
// tests/integration/go-receiving.test.ts (the hash against S6's DocumentVerification, the refusals alike).
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { findScanned, findTyped, foundTyped, scannedToken, tokenHashOf } from '@/ui/go-receive/scan'
import type { PoCopy } from '@/ui/go-receive/store'

const ORIGIN = 'https://bcs.example.com'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde'
const OLDER = 'z'.repeat(43)
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const copy = (over: Partial<PoCopy> = {}): PoCopy => ({
  poId: '0190a000-0000-7000-8000-000000000001',
  number: 'PO-2569-00012',
  version: 3,
  status: 'SENT',
  sentAt: '2026-10-01T03:00:00.000Z',
  supplier: 'ผู้ขาย',
  site: null,
  overTolerancePct: 5,
  lines: [],
  tokenHashes: [sha(OLDER), sha(TOKEN)],
  preparedAt: '2026-10-16T03:00:00.000Z',
  ...over,
})

describe('[FR-PLT-301/AC6] only the QR of a BCS document of this environment counts (BR-APP-11)', () => {
  it('takes the token of <origin>/verify/<token>', () => {
    expect(scannedToken(`${ORIGIN}/verify/${TOKEN}`, ORIGIN)).toBe(TOKEN)
    expect(scannedToken(`  ${ORIGIN}/verify/${TOKEN}\n`, ORIGIN)).toBe(TOKEN)
  })

  it.each([
    ['another site', `https://evil.example.com/verify/${TOKEN}`],
    ['another environment', `https://staging.bcs.example.com/verify/${TOKEN}`],
    ['plain http', `http://bcs.example.com/verify/${TOKEN}`],
    ['another page of BCS', `${ORIGIN}/procurement/${TOKEN}`],
    ['a deeper path', `${ORIGIN}/verify/${TOKEN}/x`],
    ['a query', `${ORIGIN}/verify/${TOKEN}?next=/admin`],
    ['a fragment', `${ORIGIN}/verify/${TOKEN}#x`],
    ['credentials in the link', `https://a:b@bcs.example.com/verify/${TOKEN}`],
    ['a token of the wrong length', `${ORIGIN}/verify/${TOKEN}x`],
    ['a script link', `javascript:alert(1)`],
    ['words', 'PO-2569-00012'],
  ])('refuses %s', (_label, raw) => {
    expect(scannedToken(raw, ORIGIN)).toBeNull()
  })

  it('the hash made with WebCrypto is sha256 of the token as 64 lower-case hex digits, the form of DocumentVerification.tokenHash', async () => {
    expect(await tokenHashOf(TOKEN)).toBe(sha(TOKEN))
    expect(await tokenHashOf(TOKEN)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('[FR-PLT-301/AC6] the PO a QR finds, without a signal and with one (OQ-163)', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('a link that is not BCS opens nothing and sends nothing', async () => {
    const fetch = answer(200, {})
    expect(await findScanned('https://evil.example.com/pay', { origin: ORIGIN, copies: [copy()], online: true, fetch })).toEqual({ kind: 'NOT_BCS' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('the copy on the phone, from the latest printing or an older one, without asking the server', async () => {
    const fetch = answer(500, {})
    for (const token of [TOKEN, OLDER]) {
      expect(await findScanned(`${ORIGIN}/verify/${token}`, { origin: ORIGIN, copies: [copy()], online: true, fetch })).toEqual({ kind: 'COPY', copy: copy(), from: 'PHONE' })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('not on the phone: with a signal the server is asked by the hash only; without one, nothing is sent', async () => {
    const server = copy({ poId: '0190a000-0000-7000-8000-000000000002', tokenHashes: [sha(TOKEN)] })
    const fetch = answer(200, { copy: server })
    expect(await findScanned(`${ORIGIN}/verify/${TOKEN}`, { origin: ORIGIN, copies: [], online: true, fetch })).toEqual({ kind: 'COPY', copy: server, from: 'SERVER' })
    const asked = String((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])
    expect(asked).toBe(`/api/go/resolve?h=${sha(TOKEN)}`)
    expect(asked).not.toContain(TOKEN)
    const offline = answer(200, { copy: server })
    expect(await findScanned(`${ORIGIN}/verify/${TOKEN}`, { origin: ORIGIN, copies: [], online: false, fetch: offline })).toEqual({ kind: 'NOT_ON_PHONE' })
    expect(offline).not.toHaveBeenCalled()
  })

  it('what the server says: not found, signed out, the module off, no answer', async () => {
    const at = (fetch: typeof globalThis.fetch) => findScanned(`${ORIGIN}/verify/${TOKEN}`, { origin: ORIGIN, copies: [], online: true, fetch })
    expect(await at(answer(404, { error: { code: 'NOT_FOUND' } }))).toEqual({ kind: 'NOT_FOUND' })
    // Only the server's own "not found" says so: a failure or a limit is no answer yet, scanned again
    expect(await at(answer(503, { error: { code: 'INTERNAL' } }))).toEqual({ kind: 'NO_ANSWER' })
    expect(await at(answer(429, { error: { code: 'RATE_LIMITED' } }))).toEqual({ kind: 'NO_ANSWER' })
    expect(await at(answer(401, { error: { code: 'UNAUTHENTICATED' } }))).toEqual({ kind: 'SIGNED_OUT' })
    expect(await at(answer(403, { error: { code: 'MODULE_DISABLED' } }))).toEqual({ kind: 'MODULE_OFF' })
    expect(await at(vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch)).toEqual({ kind: 'NOT_ON_PHONE' })
  })
})

describe('[FR-PLT-301/AC6] the PWA types the PO number instead (BR-APP-11)', () => {
  it('finds the copy whatever the case and the spaces; another number finds nothing', () => {
    expect(findTyped(' po-2569-00012 ', [copy()])).toEqual(copy())
    expect(findTyped('PO-2569-00013', [copy()])).toBeNull()
    expect(findTyped('', [copy()])).toBeNull()
  })

  it('a number the copies lack is "not found" only when they hold every PO the receiver may receive', () => {
    expect(foundTyped('PO-2569-00012', [copy()], false)).toEqual({ kind: 'COPY', copy: copy(), from: 'PHONE' })
    expect(foundTyped('PO-2569-00013', [copy()], true)).toEqual({ kind: 'NOT_FOUND' })
    // Prepared without every PO (maxPreparedPos), or no signal to know they are current
    expect(foundTyped('PO-2569-00013', [copy()], false)).toEqual({ kind: 'NOT_AMONG_COPIES' })
  })
})

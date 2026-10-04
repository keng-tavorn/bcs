import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareFile } from '@/ui/files/prepare-image'
import { FILE_UPLOAD_LIMIT_MS, openUploadWindow, uploadFile, type UploadSteps } from '@/ui/files/upload'

// FR-PLT-004 · one upload of the workspace (src/ui/files/upload.ts), the steps FileUpload runs: only the file as the
// browser prepared it is sent (a photo without its EXIF; one the browser cannot decode is refused before anything goes
// out), its declared type and size are checked first, and the file service's steps run in order — a short-lived PUT
// address, the bytes, then the server's own check. Every upload has an end, as the LIFF camera's has
// (tests/unit/liff-photo-upload.test.ts): it fails after FILE_UPLOAD_LIMIT_MS and the person can stop it; after either
// nothing more goes out and the PUT is cancelled — the receiving form, which waits for its photo, is never locked.

vi.mock('@/ui/files/prepare-image', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui/files/prepare-image')>()), prepareFile: vi.fn() }))

const prepared = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'site.jpg', { type: 'image/jpeg' })
const camera = new File([new Uint8Array(64)], 'site.jpg', { type: 'image/jpeg' })

function steps(overrides: Partial<UploadSteps> = {}) {
  const calls: string[] = []
  const base: UploadSteps = {
    requestUpload: async (input) => {
      calls.push(`request ${input.fileName} ${input.mimeType} ${input.sizeBytes}`)
      return { ok: true, uploadUrl: 'http://storage.test/put?X-Amz-Signature=abc', ticket: 'ticket-1' }
    },
    completeUpload: async (ticket) => {
      calls.push(`complete ${ticket}`)
      return { ok: true, fileId: 'file-1', fileName: 'site.jpg' }
    },
    onSending: (name) => calls.push(`sending ${name}`),
  }
  return { calls, steps: { ...base, ...overrides } }
}

let puts: Array<{ url: string; type: string | null; body: unknown }>
beforeEach(() => {
  puts = []
  vi.mocked(prepareFile).mockResolvedValue({ ok: true, file: prepared })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    puts.push({ url, type: new Headers(init.headers).get('content-type'), body: init.body })
    return new Response(null, { status: 200 })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('[FR-PLT-004/AC1] [FR-PLT-004/AC3] an upload goes to private storage through the file service, as the browser prepared it', () => {
  it('sends the prepared file, in order: the PUT address, the bytes, the server’s check', async () => {
    const { calls, steps: s } = steps()
    expect(await uploadFile(camera, s)).toEqual({ ok: true, fileId: 'file-1', fileName: 'site.jpg' })
    expect(prepareFile).toHaveBeenCalledWith(camera)
    expect(calls).toEqual(['sending site.jpg', `request site.jpg image/jpeg ${prepared.size}`, 'complete ticket-1'])
    expect(puts).toEqual([{ url: 'http://storage.test/put?X-Amz-Signature=abc', type: 'image/jpeg', body: prepared }])
  })

  it('refuses a photo the browser could not decode, and sends nothing at all', async () => {
    vi.mocked(prepareFile).mockResolvedValue({ ok: false, reason: 'UNREADABLE' })
    const { calls, steps: s } = steps()
    expect(await uploadFile(camera, s)).toEqual({ ok: false, reason: 'UNREADABLE' })
    expect(calls).toEqual([])
    expect(puts).toEqual([])
  })

  it('checks the declared type and size before asking for an address', async () => {
    vi.mocked(prepareFile).mockResolvedValue({ ok: true, file: new File(['hello'], 'notes.txt', { type: 'text/plain' }) })
    expect(await uploadFile(camera, steps().steps)).toEqual({ ok: false, reason: 'TYPE_NOT_ALLOWED' })
    vi.mocked(prepareFile).mockResolvedValue({ ok: true, file: new File([], 'empty.pdf', { type: 'application/pdf' }) })
    const { calls, steps: s } = steps()
    expect(await uploadFile(camera, s)).toEqual({ ok: false, reason: 'EMPTY' })
    expect(calls).toEqual([])
    // A file the browser gives no type is declared by its name, as the server reads it
    vi.mocked(prepareFile).mockResolvedValue({ ok: true, file: new File(['%PDF-1.7'], 'quote.pdf', { type: '' }) })
    const named = steps()
    expect(await uploadFile(camera, named.steps)).toMatchObject({ ok: true })
    expect(named.calls).toContain('request quote.pdf application/pdf 8')
  })

  it('says why when the server refuses the declared file or what arrived, and when storage cannot be reached', async () => {
    expect(await uploadFile(camera, steps({ requestUpload: async () => ({ ok: false, reason: 'TOO_LARGE' }) }).steps)).toEqual({ ok: false, reason: 'TOO_LARGE' })
    expect(await uploadFile(camera, steps({ completeUpload: async () => ({ ok: false, reason: 'CONTENT_MISMATCH' }) }).steps)).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' })
    vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }))
    expect(await uploadFile(camera, steps().steps)).toEqual({ ok: false, reason: 'FAILED' })
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network')
    })
    expect(await uploadFile(camera, steps().steps)).toEqual({ ok: false, reason: 'FAILED' })
    // A step that throws (a server action with no answer) is a failed upload, never an error out of the form
    expect(await uploadFile(camera, steps({ completeUpload: () => Promise.reject(new Error('no answer')) }).steps)).toEqual({ ok: false, reason: 'FAILED' })
  })
})

describe('[FR-PLT-004/AC1] an upload always ends: a time limit, and a stop for the person', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A PUT that never answers, as on a stalled site network; it hears the abort as a real fetch does */
  function stalledPut() {
    const seen: { signal?: AbortSignal | null } = {}
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      seen.signal = init.signal
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    })
    return seen
  }

  it('names its limit: within the 15 minutes the server’s upload ticket is valid', () => {
    expect(FILE_UPLOAD_LIMIT_MS).toBeGreaterThan(0)
    expect(FILE_UPLOAD_LIMIT_MS).toBeLessThan(15 * 60_000)
  })

  it('gives up a PUT that never answers after FILE_UPLOAD_LIMIT_MS: the upload failed, the PUT is cancelled, nothing is recorded', async () => {
    const seen = stalledPut()
    const { calls, steps: s } = steps()
    let outcome: unknown = null
    void uploadFile(camera, s).then((sent) => (outcome = sent))
    await vi.advanceTimersByTimeAsync(FILE_UPLOAD_LIMIT_MS - 1)
    expect(outcome).toBeNull()
    expect(seen.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toEqual({ ok: false, reason: 'FAILED' })
    expect(seen.signal?.aborted).toBe(true)
    expect(calls).not.toContain('complete ticket-1')
  })

  it('gives up a step of the server that never answers (the address, or the check) the same way', async () => {
    const hang = () => new Promise<never>(() => undefined)
    for (const stuck of [steps({ requestUpload: hang }), steps({ completeUpload: hang })]) {
      let outcome: unknown = null
      void uploadFile(camera, stuck.steps).then((sent) => (outcome = sent))
      await vi.advanceTimersByTimeAsync(FILE_UPLOAD_LIMIT_MS)
      expect(outcome).toEqual({ ok: false, reason: 'FAILED' })
    }
  })

  it('stops when the person stops it: STOPPED (not a failure), the PUT is cancelled, and nothing more goes out', async () => {
    const seen = stalledPut()
    const { calls, steps: s } = steps()
    const upload = openUploadWindow()
    const sent = uploadFile(camera, s, upload)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toContain(`request site.jpg image/jpeg ${prepared.size}`)
    upload.stop()
    expect(await sent).toEqual({ ok: false, reason: 'STOPPED' })
    expect(upload.timedOut()).toBe(false)
    expect(seen.signal?.aborted).toBe(true)
    expect(calls).not.toContain('complete ticket-1')
    upload.close()
  })

  it('sends nothing at all when stopped while the browser is still preparing the photo', async () => {
    let ready: (value: { ok: true; file: File }) => void = () => undefined
    vi.mocked(prepareFile).mockReturnValue(new Promise((resolve) => (ready = resolve)))
    const { calls, steps: s } = steps()
    const upload = openUploadWindow()
    const sent = uploadFile(camera, s, upload)
    await vi.advanceTimersByTimeAsync(10)
    upload.stop()
    expect(await sent).toEqual({ ok: false, reason: 'STOPPED' })
    ready({ ok: true, file: prepared })
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([])
    expect(puts).toEqual([])
    upload.close()
  })

  it('a window says whether it ran out of time or was stopped, and a closed one never aborts', async () => {
    const late = openUploadWindow(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect([late.signal.aborted, late.timedOut()]).toEqual([true, true])
    const stopped = openUploadWindow(5000)
    stopped.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect([stopped.signal.aborted, stopped.timedOut()]).toEqual([true, false])
    const closed = openUploadWindow(5000)
    closed.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect([closed.signal.aborted, closed.timedOut()]).toEqual([false, false])
  })
})

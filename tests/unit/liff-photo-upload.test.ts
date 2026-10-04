import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareLiffPhoto } from '@/ui/liff/image-resize'
import { uploadLiffPhoto, type LiffPhotoUploadSteps } from '@/ui/liff/receiving/photo-upload'
import { LIFF_PHOTO_SEND_LIMIT_MS, openPhotoSendWindow, PhotoSendAborted, untilAborted } from '@/ui/liff/receiving/send-window'

// S5-06 · sending a photo of /liff/gr/[poId] (FR-LINE-003 AC3, FR-PLT-004, NFR-SEC-08): only the photo as the phone made
// it ready is sent (never the camera's file), under a name no other photo of the receipt has, its declared type and size
// are checked first, nothing goes out once the LIFF session cannot be kept or the server says it ended, and the file
// service's steps run in order — a short-lived PUT address, the bytes, then the server's own check. Every send has an end
// (a site's network can stall while the receipt waits for the photo): it fails after LIFF_PHOTO_SEND_LIMIT_MS, and the
// receiver can stop it; after either nothing more goes out. The resize itself is tests/unit/liff-image-resize.test.ts;
// the real path runs in tests/e2e/liff-gr.spec.ts against the run's storage.

vi.mock('@/ui/liff/image-resize', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui/liff/image-resize')>()), prepareLiffPhoto: vi.fn() }))

const prepared = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'IMG_0042.jpg', { type: 'image/jpeg' })
const camera = new File([new Uint8Array(64)], 'IMG_0042.HEIC', { type: 'image/heic' })

function steps(overrides: Partial<LiffPhotoUploadSteps> = {}) {
  const calls: string[] = []
  const base: LiffPhotoUploadSteps = {
    taken: [],
    ready: async () => {
      calls.push('ready')
      return true
    },
    requestUpload: async (input) => {
      calls.push(`request ${input.fileName} ${input.mimeType} ${input.sizeBytes}`)
      return { ok: true, uploadUrl: 'http://storage.test/put?X-Amz-Signature=abc', ticket: 'ticket-1' }
    },
    completeUpload: async (ticket) => {
      calls.push(`complete ${ticket}`)
      return { ok: true, fileId: 'file-1', fileName: 'IMG_0042.jpg' }
    },
    onSending: (name) => calls.push(`sending ${name}`),
  }
  return { calls, steps: { ...base, ...overrides } }
}

let puts: Array<{ url: string; type: string | null; body: unknown }>
beforeEach(() => {
  puts = []
  vi.mocked(prepareLiffPhoto).mockResolvedValue({ ok: true, file: prepared })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    puts.push({ url, type: new Headers(init.headers).get('content-type'), body: init.body })
    return new Response(null, { status: 200 })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('[FR-LINE-003/AC3] a LIFF photo goes to private storage through the file service', () => {
  it('sends the photo as the phone prepared it — a JPEG — in order: the PUT address, the bytes, the server’s check', async () => {
    const { calls, steps: s } = steps()
    expect(await uploadLiffPhoto(camera, s)).toEqual({ ok: true, fileId: 'file-1', fileName: 'IMG_0042.jpg', file: prepared })
    expect(prepareLiffPhoto).toHaveBeenCalledWith(camera)
    expect(calls).toEqual(['ready', 'sending IMG_0042.jpg', `request IMG_0042.jpg image/jpeg ${prepared.size}`, 'complete ticket-1'])
    expect(puts).toEqual([{ url: 'http://storage.test/put?X-Amz-Signature=abc', type: 'image/jpeg', body: prepared }])
  })

  it('names a photo apart from the receipt’s others (an iPhone calls every capture image.jpg) and sends it under that name', async () => {
    const capture = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9])], 'image.jpg', { type: 'image/jpeg', lastModified: 1_700_000_000_000 })
    vi.mocked(prepareLiffPhoto).mockResolvedValue({ ok: true, file: capture })
    const { calls, steps: s } = steps({ taken: ['image.jpg', 'Image-2.jpg'], completeUpload: async () => ({ ok: true, fileId: 'file-3', fileName: 'image-3.jpg' }) })
    const sent = await uploadLiffPhoto(capture, s)
    expect(sent).toMatchObject({ ok: true, fileId: 'file-3', fileName: 'image-3.jpg' })
    if (!sent.ok) return
    expect([sent.file.name, sent.file.type, sent.file.size, sent.file.lastModified]).toEqual(['image-3.jpg', 'image/jpeg', capture.size, 1_700_000_000_000])
    expect(calls).toContain(`request image-3.jpg image/jpeg ${capture.size}`)
    expect((puts[0]?.body as File).name).toBe('image-3.jpg')
  })

  it('refuses a photo the phone could not prepare, and sends nothing', async () => {
    vi.mocked(prepareLiffPhoto).mockResolvedValue({ ok: false })
    const { calls, steps: s } = steps()
    expect(await uploadLiffPhoto(camera, s)).toEqual({ ok: false, reason: 'UNREADABLE' })
    expect(calls).toEqual([])
    expect(puts).toEqual([])
  })

  it('sends nothing once the LIFF session cannot be kept', async () => {
    const { calls, steps: s } = steps({ ready: async () => false })
    expect(await uploadLiffPhoto(camera, s)).toEqual({ ok: false, reason: 'NOT_SENT' })
    expect(calls).toEqual([])
    expect(puts).toEqual([])
  })

  it('says why when the server refuses the declared file or what arrived, and when storage cannot be reached', async () => {
    expect(await uploadLiffPhoto(camera, steps({ requestUpload: async () => ({ ok: false, reason: 'TOO_LARGE' }) }).steps)).toEqual({ ok: false, reason: 'TOO_LARGE' })
    expect(await uploadLiffPhoto(camera, steps({ completeUpload: async () => ({ ok: false, reason: 'CONTENT_MISMATCH' }) }).steps)).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' })
    vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }))
    expect(await uploadLiffPhoto(camera, steps().steps)).toEqual({ ok: false, reason: 'FAILED' })
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network')
    })
    expect(await uploadLiffPhoto(camera, steps().steps)).toEqual({ ok: false, reason: 'FAILED' })
  })

  it('checks the declared type and size before asking for an address: an empty photo is refused', async () => {
    vi.mocked(prepareLiffPhoto).mockResolvedValue({ ok: true, file: new File([], 'empty.jpg', { type: 'image/jpeg' }) })
    const { calls, steps: s } = steps()
    expect(await uploadLiffPhoto(camera, s)).toEqual({ ok: false, reason: 'EMPTY' })
    expect(calls).toEqual([])
  })

  it('tells the page when the server says its session ended, and sends nothing more (not "check the connection")', async () => {
    const ended = vi.fn()
    const first = steps({ requestUpload: async () => ({ ok: false, reason: 'UNAUTHENTICATED' }), onSessionEnded: ended })
    expect(await uploadLiffPhoto(camera, first.steps)).toEqual({ ok: false, reason: 'NOT_SENT' })
    expect(ended).toHaveBeenCalledTimes(1)
    expect(puts).toEqual([])
    const last = steps({ completeUpload: async () => ({ ok: false, reason: 'UNAUTHENTICATED' }), onSessionEnded: ended })
    expect(await uploadLiffPhoto(camera, last.steps)).toEqual({ ok: false, reason: 'NOT_SENT' })
    expect(ended).toHaveBeenCalledTimes(2)
  })
})

describe('[FR-LINE-003/AC3] a LIFF photo send always ends: a time limit, and a stop for the receiver', () => {
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

  it('gives up a PUT that never answers after LIFF_PHOTO_SEND_LIMIT_MS: the send failed, the PUT is cancelled, nothing is recorded', async () => {
    const seen = stalledPut()
    const { calls, steps: s } = steps()
    let outcome: unknown = null
    void uploadLiffPhoto(camera, s).then((sent) => (outcome = sent))
    await vi.advanceTimersByTimeAsync(LIFF_PHOTO_SEND_LIMIT_MS - 1)
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
      void uploadLiffPhoto(camera, stuck.steps).then((sent) => (outcome = sent))
      await vi.advanceTimersByTimeAsync(LIFF_PHOTO_SEND_LIMIT_MS)
      expect(outcome).toEqual({ ok: false, reason: 'FAILED' })
    }
  })

  it('stops when the receiver stops it: nothing is attached, the page is not told of a failure, and nothing more goes out', async () => {
    const seen = stalledPut()
    const { calls, steps: s } = steps()
    const send = openPhotoSendWindow()
    const sent = uploadLiffPhoto(camera, { ...s, window: send })
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toContain(`request IMG_0042.jpg image/jpeg ${prepared.size}`)
    send.stop()
    expect(await sent).toEqual({ ok: false, reason: 'NOT_SENT' })
    expect(send.timedOut()).toBe(false)
    expect(seen.signal?.aborted).toBe(true)
    expect(calls).not.toContain('complete ticket-1')
    send.close()
  })

  it('sends nothing at all when stopped while the session is being made sure of', async () => {
    let answer: (ok: boolean) => void = () => undefined
    const { calls, steps: s } = steps({ ready: () => new Promise<boolean>((resolve) => (answer = resolve)) })
    const send = openPhotoSendWindow()
    const sent = uploadLiffPhoto(camera, { ...s, window: send })
    await vi.advanceTimersByTimeAsync(10)
    send.stop()
    expect(await sent).toEqual({ ok: false, reason: 'NOT_SENT' })
    answer(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([])
    expect(puts).toEqual([])
    send.close()
  })

  it('a window says whether it ran out of time or was stopped, and a closed one never aborts', async () => {
    const late = openPhotoSendWindow(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect([late.signal.aborted, late.timedOut()]).toEqual([true, true])
    const stopped = openPhotoSendWindow(5000)
    stopped.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect([stopped.signal.aborted, stopped.timedOut()]).toEqual([true, false])
    const closed = openPhotoSendWindow(5000)
    closed.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(closed.signal.aborted).toBe(false)
  })

  it('untilAborted answers with the work, or PhotoSendAborted as soon as the window closes on it', async () => {
    const open = openPhotoSendWindow(5000)
    expect(await untilAborted(Promise.resolve('done'), open.signal)).toBe('done')
    const waiting = untilAborted(new Promise<never>(() => undefined), open.signal)
    open.stop()
    await expect(waiting).rejects.toBeInstanceOf(PhotoSendAborted)
    await expect(untilAborted(Promise.resolve('late'), open.signal)).rejects.toBeInstanceOf(PhotoSendAborted)
    open.close()
  })
})

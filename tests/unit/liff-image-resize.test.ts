import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_IMAGE_SIDE_PX } from '@/lib/constants'
import { distinctPhotoName, fitWithin, LIFF_PHOTO_JPEG_QUALITY, LIFF_PHOTO_MAX_SIDE_PX, LIFF_PHOTO_TYPE, photoFileName, prepareLiffPhoto } from '@/ui/liff/image-resize'

// S5-06 · the photos of /liff/gr/[poId] are made ready in the phone before the presigned upload (§9.4 "ย่อรูปฝั่ง
// client", FR-LINE-003 AC3, FR-PLT-004 AC3): scaled so the longest side is at most the limit, re-encoded as JPEG at a
// named quality (which keeps only pixels: the camera's EXIF and its GPS position go), and refused — never sent as they
// are — when the phone cannot decode them. The browser parts (createImageBitmap, <img>, a canvas) are stand-ins here;
// tests/e2e/liff-gr.spec.ts runs the real ones in Chromium and reads the stored file back.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('[FR-LINE-003/AC3] the size and the name of a LIFF photo', () => {
  it('names its limits: at most the 2,000 px of FR-PLT-004 AC3, a JPEG quality between 0 and 1', () => {
    expect(LIFF_PHOTO_MAX_SIDE_PX).toBeLessThanOrEqual(MAX_IMAGE_SIDE_PX)
    expect(MAX_IMAGE_SIDE_PX).toBe(2000)
    expect(LIFF_PHOTO_JPEG_QUALITY).toBeGreaterThan(0)
    expect(LIFF_PHOTO_JPEG_QUALITY).toBeLessThan(1)
    expect(LIFF_PHOTO_TYPE).toBe('image/jpeg')
  })

  it.each([
    [4032, 3024, 2000, 1500],
    [3024, 4032, 1500, 2000],
    [3000, 2000, 2000, 1333],
    [2000, 2000, 2000, 2000],
    [1200, 900, 1200, 900],
    [8000, 10, 2000, 3],
    [10, 8000, 3, 2000],
    [1, 1, 1, 1],
  ])('scales %i × %i to %i × %i: the longest side within the limit, the shape kept, never larger', (width, height, w, h) => {
    expect(fitWithin(width, height, 2000)).toEqual({ width: w, height: h })
  })

  it('refuses sizes that are not a picture', () => {
    expect(() => fitWithin(0, 100, 2000)).toThrow(RangeError)
    expect(() => fitWithin(100, Number.NaN, 2000)).toThrow(RangeError)
    expect(() => fitWithin(100, 100, 0)).toThrow(RangeError)
  })

  it.each([
    ['IMG_0042.HEIC', 'IMG_0042.jpg'],
    ['site-delivery.jpg', 'site-delivery.jpg'],
    ['screen shot.png', 'screen shot.jpg'],
    ['a.b.jpeg', 'a.b.jpg'],
    ['snap', 'snap.jpg'],
    ['.jpg', 'photo.jpg'],
    ['', 'photo.jpg'],
  ])('sends %j as %j (every LIFF photo is a JPEG)', (name, sent) => {
    expect(photoFileName(name)).toBe(sent)
  })

  it.each([
    ['image.jpg', [], 'image.jpg'],
    ['image.jpg', ['site.jpg'], 'image.jpg'],
    ['image.jpg', ['image.jpg'], 'image-2.jpg'],
    ['image.jpg', ['IMAGE.JPG', 'image-2.jpg'], 'image-3.jpg'],
    ['image.jpg', ['image.jpg', 'image-3.jpg'], 'image-2.jpg'],
    ['snap', ['snap'], 'snap-2'],
    ['.jpg', ['.jpg'], '.jpg-2'],
  ] as const)('names %j apart from %j as %j (an iPhone calls every capture image.jpg)', (name, taken, sent) => {
    expect(distinctPhotoName(name, taken)).toBe(sent)
  })

  it('always finds a free name, however many photos share it', () => {
    const taken = ['image.jpg', ...Array.from({ length: 19 }, (_, i) => `image-${i + 2}.jpg`)]
    const name = distinctPhotoName('image.jpg', taken)
    expect(name).toBe('image-21.jpg')
    expect(taken.map((n) => n.toLowerCase())).not.toContain(name)
  })
})

/** A canvas that records what was drawn and hands back a JPEG blob (or nothing, when `blob` is null) */
function fakeCanvas(blob: Blob | null) {
  const drawn: Array<{ width: number; height: number }> = []
  const encoded: Array<{ type: string; quality: number }> = []
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: '',
      fillRect: () => undefined,
      drawImage: (_source: unknown, _x: number, _y: number, width: number, height: number) => drawn.push({ width, height }),
    }),
    toBlob: (done: (b: Blob | null) => void, type: string, quality: number) => {
      encoded.push({ type, quality })
      done(blob)
    },
  }
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'canvas' ? canvas : null) })
  return { canvas, drawn, encoded }
}

describe('[FR-LINE-003/AC3] a photo is shrunk and re-encoded in the phone before it is sent', () => {
  it('draws a 4032 × 3024 camera photo at 2,000 × 1,500, upright, and sends it as a JPEG at the named quality', async () => {
    const closed = vi.fn()
    const bitmap = vi.fn(async () => ({ width: 4032, height: 3024, close: closed }))
    vi.stubGlobal('createImageBitmap', bitmap)
    const { canvas, drawn, encoded } = fakeCanvas(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }))
    const photo = new File([new Uint8Array([1, 2, 3])], 'IMG_0042.HEIC', { type: 'image/heic', lastModified: 1_700_000_000_000 })

    const prepared = await prepareLiffPhoto(photo)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    // EXIF orientation applied while decoding, so the photo stays upright
    expect(bitmap).toHaveBeenCalledWith(photo, { imageOrientation: 'from-image' })
    expect([canvas.width, canvas.height]).toEqual([2000, 1500])
    expect(drawn).toEqual([{ width: 2000, height: 1500 }])
    expect(encoded).toEqual([{ type: 'image/jpeg', quality: LIFF_PHOTO_JPEG_QUALITY }])
    expect(prepared.file).toMatchObject({ name: 'IMG_0042.jpg', type: 'image/jpeg', lastModified: 1_700_000_000_000 })
    expect(closed).toHaveBeenCalledOnce()
  })

  it('refuses a photo the phone cannot decode instead of sending the camera file with its position', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('unsupported format')
    })
    // The fallback <img> cannot decode it either
    vi.stubGlobal(
      'Image',
      class {
        decoding = ''
        src = ''
        naturalWidth = 0
        naturalHeight = 0
        decode() {
          return Promise.reject(new Error('cannot decode'))
        }
      },
    )
    const revoked: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => void revoked.push(url))
    fakeCanvas(new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }))
    expect(await prepareLiffPhoto(new File([new Uint8Array([1])], 'odd.heic', { type: 'image/heic' }))).toEqual({ ok: false })
    expect(revoked).toEqual(['blob:photo'])
  })

  it('decodes through an <img> in a WebView without createImageBitmap', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    vi.stubGlobal(
      'Image',
      class {
        decoding = ''
        src = ''
        naturalWidth = 1600
        naturalHeight = 1200
        decode() {
          return Promise.resolve()
        }
      },
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const { drawn } = fakeCanvas(new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }))
    const prepared = await prepareLiffPhoto(new File([new Uint8Array([1])], 'small.jpg', { type: 'image/jpeg' }))
    expect(prepared).toMatchObject({ ok: true, file: { name: 'small.jpg', type: 'image/jpeg' } })
    // Already within the limit: never scaled up
    expect(drawn).toEqual([{ width: 1600, height: 1200 }])
  })

  it('refuses when the phone gives no JPEG back', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close: () => undefined }))
    fakeCanvas(null)
    expect(await prepareLiffPhoto(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))).toEqual({ ok: false })
    fakeCanvas(new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' }))
    expect(await prepareLiffPhoto(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))).toEqual({ ok: false })
  })
})

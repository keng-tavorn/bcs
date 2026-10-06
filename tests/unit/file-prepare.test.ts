import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_IMAGE_SIDE_PX } from '@/lib/constants'
import { MAX_IMAGE_SIDE, prepareFile, prepareImage, UnreadableImage } from '@/ui/files/prepare-image'

// FR-PLT-004 AC3 · the workspace prepares a photo in the browser before its presigned upload
// (src/ui/files/prepare-image.ts): upright, at most 2,000 px on its long side, encoded again — which keeps only the
// pixels, so the camera's EXIF and its GPS position go. A photo the browser cannot decode is refused, never uploaded as
// it is with its position (as the LIFF camera refuses one, tests/unit/liff-image-resize.test.ts); a file that is not a
// photo goes as it is. The browser parts (createImageBitmap, <img>, a canvas) are stand-ins here;
// tests/e2e/files.spec.ts runs the real ones in Chromium and reads the stored file back.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A canvas that records what was drawn and how it was encoded, and hands back `blob` */
function fakeCanvas(blob: Blob | null) {
  const drawn: Array<{ width: number; height: number }> = []
  const encoded: Array<{ type: string; quality: number }> = []
  const filled: string[] = []
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: '',
      fillRect(this: { fillStyle: string }) {
        filled.push(this.fillStyle)
      },
      drawImage: (_source: unknown, _x: number, _y: number, width: number, height: number) => drawn.push({ width, height }),
    }),
    toBlob: (done: (b: Blob | null) => void, type: string, quality: number) => {
      encoded.push({ type, quality })
      done(blob)
    },
  }
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'canvas' ? canvas : null) })
  return { canvas, drawn, encoded, filled }
}

/** No decoder in the browser: createImageBitmap refuses the file and an <img> cannot decode it either */
function noDecoder() {
  vi.stubGlobal('createImageBitmap', async () => {
    throw new Error('unsupported format')
  })
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
  return { revoked }
}

const jpegBlob = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])], { type: 'image/jpeg' })

describe('[FR-PLT-004/AC3] a photo is shrunk and encoded again in the browser before it is uploaded', () => {
  it('keeps FR-PLT-004 AC3’s limit of 2,000 px', () => {
    expect(MAX_IMAGE_SIDE).toBe(MAX_IMAGE_SIDE_PX)
    expect(MAX_IMAGE_SIDE_PX).toBe(2000)
  })

  it('draws a 4032 × 3024 camera photo upright at 2,000 × 1,500 and uploads the JPEG the canvas wrote, not the camera’s file', async () => {
    const closed = vi.fn()
    const bitmap = vi.fn(async () => ({ width: 4032, height: 3024, close: closed }))
    vi.stubGlobal('createImageBitmap', bitmap)
    const { canvas, drawn, encoded } = fakeCanvas(jpegBlob())
    const photo = new File([new Uint8Array([1, 2, 3])], 'IMG_0042.jpg', { type: 'image/jpeg', lastModified: 1_700_000_000_000 })

    const prepared = await prepareFile(photo)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    // EXIF orientation applied while decoding, so the photo stays upright
    expect(bitmap).toHaveBeenCalledWith(photo, { imageOrientation: 'from-image' })
    expect([canvas.width, canvas.height]).toEqual([2000, 1500])
    expect(drawn).toEqual([{ width: 2000, height: 1500 }])
    expect(encoded.map((e) => e.type)).toEqual(['image/jpeg'])
    expect(prepared.file).not.toBe(photo)
    expect(prepared.file).toMatchObject({ name: 'IMG_0042.jpg', type: 'image/jpeg', lastModified: 1_700_000_000_000 })
    expect(closed).toHaveBeenCalledOnce()
  })

  it('turns a HEIC into a JPEG (named .jpg, on white) and keeps a PNG a PNG, never larger than it was', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 1200, height: 900, close: () => undefined }))
    const heic = fakeCanvas(jpegBlob())
    const fromHeic = await prepareFile(new File([new Uint8Array([1])], 'IMG_0042.HEIC', { type: 'image/heic' }))
    expect(fromHeic).toMatchObject({ ok: true, file: { name: 'IMG_0042.jpg', type: 'image/jpeg' } })
    expect(heic.drawn).toEqual([{ width: 1200, height: 900 }])
    expect(heic.filled).toEqual(['white'])

    const png = fakeCanvas(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }))
    const fromPng = await prepareFile(new File([new Uint8Array([1])], 'scan.png', { type: 'image/png' }))
    expect(fromPng).toMatchObject({ ok: true, file: { name: 'scan.png', type: 'image/png' } })
    expect(png.encoded.map((e) => e.type)).toEqual(['image/png'])
    expect(png.filled).toEqual([])
  })

  it('knows a photo by its name when the browser gives it no type (some phones send HEIC that way)', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 800, height: 600, close: () => undefined }))
    fakeCanvas(jpegBlob())
    expect(await prepareFile(new File([new Uint8Array([1])], 'IMG_0007.heic', { type: '' }))).toMatchObject({ ok: true, file: { name: 'IMG_0007.jpg', type: 'image/jpeg' } })
    expect(await prepareFile(new File([new Uint8Array([1])], 'site.jpg', { type: '' }))).toMatchObject({ ok: true, file: { name: 'site.jpg', type: 'image/jpeg' } })
  })

  it('refuses a photo the browser cannot decode instead of uploading the camera’s file with its position', async () => {
    const { revoked } = noDecoder()
    fakeCanvas(jpegBlob())
    for (const photo of [
      new File([new Uint8Array([1])], 'IMG_0042.HEIC', { type: 'image/heic' }),
      new File([new Uint8Array([0xff, 0xd8, 0xff])], 'broken.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([1])], 'no-type.heif', { type: '' }),
    ]) {
      expect(await prepareFile(photo)).toEqual({ ok: false, reason: 'UNREADABLE' })
    }
    // The fallback's object URLs are freed
    expect(revoked).toEqual(['blob:photo', 'blob:photo', 'blob:photo'])
    // A caller that takes a File gets an error it can tell apart, never the photo as it was
    await expect(prepareImage(new File([new Uint8Array([1])], 'IMG_0042.HEIC', { type: 'image/heic' }))).rejects.toBeInstanceOf(UnreadableImage)
  })

  it('refuses a photo when the browser has no decoder at all, no drawing context, or encodes nothing or another type', async () => {
    // No createImageBitmap and no Image (an environment without either)
    vi.stubGlobal('createImageBitmap', undefined)
    vi.stubGlobal('Image', undefined)
    expect(await prepareFile(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))).toEqual({ ok: false, reason: 'UNREADABLE' })

    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close: () => undefined }))
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) })
    expect(await prepareFile(new File([new Uint8Array([1])], 'b.jpg', { type: 'image/jpeg' }))).toEqual({ ok: false, reason: 'UNREADABLE' })

    fakeCanvas(null)
    expect(await prepareFile(new File([new Uint8Array([1])], 'c.jpg', { type: 'image/jpeg' }))).toEqual({ ok: false, reason: 'UNREADABLE' })
    fakeCanvas(new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' }))
    expect(await prepareFile(new File([new Uint8Array([1])], 'd.jpg', { type: 'image/jpeg' }))).toEqual({ ok: false, reason: 'UNREADABLE' })
    fakeCanvas(new Blob([], { type: 'image/jpeg' }))
    expect(await prepareFile(new File([new Uint8Array([1])], 'e.jpg', { type: 'image/jpeg' }))).toEqual({ ok: false, reason: 'UNREADABLE' })

    vi.stubGlobal('createImageBitmap', async () => ({ width: 0, height: 0, close: () => undefined }))
    fakeCanvas(jpegBlob())
    expect(await prepareFile(new File([new Uint8Array([1])], 'f.jpg', { type: 'image/jpeg' }))).toEqual({ ok: false, reason: 'UNREADABLE' })
  })

  it('leaves a file that is not a photo as it is: a PDF, a spreadsheet, a type the server will refuse', async () => {
    const decoder = vi.fn()
    vi.stubGlobal('createImageBitmap', decoder)
    for (const file of [
      new File(['%PDF-1.7'], 'quote.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'prices.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    ]) {
      expect(await prepareFile(file)).toEqual({ ok: true, file })
      expect(await prepareImage(file)).toBe(file)
    }
    expect(decoder).not.toHaveBeenCalled()
  })
})

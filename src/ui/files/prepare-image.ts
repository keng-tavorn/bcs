// Files are prepared in the browser before upload (FR-PLT-004 AC3). A photo — JPEG, PNG or HEIC, by its type or, when
// the browser gives none, by its name — is decoded upright (EXIF orientation applied), scaled so its long side is at
// most 2,000 px, and encoded again, which keeps only the pixels: the camera's EXIF with the GPS position goes. PNG stays
// PNG (a picture of a document keeps its sharp edges); HEIC becomes JPEG. A photo the browser cannot decode (HEIC outside
// Safari, a damaged file) is refused and never uploaded as it is, because it would carry its position to the server —
// as the LIFF camera refuses one (src/ui/liff/image-resize.ts). A browser whose createImageBitmap refuses the options or
// the format decodes through an <img>, which browsers also turn upright. Any other file (PDF, Excel, Word) goes as it is;
// the server checks every file's type, size and first bytes again.

import { MAX_IMAGE_SIDE_PX } from '@/lib/constants'
import { mimeTypeFromName } from '@/lib/file-types'

export const MAX_IMAGE_SIDE = MAX_IMAGE_SIDE_PX
const JPEG_QUALITY = 0.85
/** The photos prepared before upload, and what each is encoded again as */
const REENCODE: Readonly<Record<string, string>> = { 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/heic': 'image/jpeg' }

/** The file as it is uploaded, or why a photo is refused: the browser cannot decode it, so it cannot lose its EXIF */
export type PreparedFile = { readonly ok: true; readonly file: File } | { readonly ok: false; readonly reason: 'UNREADABLE' }

const UNREADABLE: PreparedFile = { ok: false, reason: 'UNREADABLE' }

/** Thrown by prepareImage for a photo the browser cannot decode (nothing of it is uploaded) */
export class UnreadableImage extends Error {
  constructor() {
    super('the browser cannot decode this photo, so it cannot be uploaded without its metadata')
    this.name = 'UnreadableImage'
  }
}

function renamed(name: string, type: string): string {
  if (type !== 'image/jpeg') return name
  return /\.(jpe?g)$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, '')}.jpg`
}

/** What a photo is encoded again as; null for a file that is not a photo */
function photoTarget(file: File): string | null {
  const declared = file.type || mimeTypeFromName(file.name) || ''
  return REENCODE[declared] ?? (/\.hei[cf]$/i.test(file.name) ? 'image/jpeg' : null)
}

interface Decoded {
  readonly source: CanvasImageSource
  readonly width: number
  readonly height: number
  close(): void
}

async function decode(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch {
      // Fall through: some browsers refuse the options, or the format
    }
  }
  if (typeof Image !== 'function') return null
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

/** The file as it is uploaded: a photo upright, at most MAX_IMAGE_SIDE px, encoded again without metadata; any other as it is */
export async function prepareFile(file: File): Promise<PreparedFile> {
  const target = photoTarget(file)
  if (!target) return { ok: true, file }
  const decoded = await decode(file)
  if (!decoded) return UNREADABLE
  try {
    if (!(decoded.width > 0) || !(decoded.height > 0)) return UNREADABLE
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return UNREADABLE
    // A JPEG has no transparency: what was transparent becomes white, not black
    if (target === 'image/jpeg') {
      context.fillStyle = 'white'
      context.fillRect(0, 0, width, height)
    }
    context.drawImage(decoded.source, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, target, JPEG_QUALITY))
    // Nothing encoded, or encoded as another type than asked: nothing a browser made of the photo is sent instead
    if (!blob || blob.size === 0 || blob.type !== target) return UNREADABLE
    return { ok: true, file: new File([blob], renamed(file.name, target), { type: target, lastModified: file.lastModified }) }
  } catch {
    return UNREADABLE
  } finally {
    decoded.close()
  }
}

/** prepareFile for a caller that takes a File: throws UnreadableImage for a photo the browser cannot decode */
export async function prepareImage(file: File): Promise<File> {
  const prepared = await prepareFile(file)
  if (!prepared.ok) throw new UnreadableImage()
  return prepared.file
}

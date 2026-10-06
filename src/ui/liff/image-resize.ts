import { MAX_IMAGE_SIDE_PX } from '@/lib/constants'

// A photo taken in LIFF, made ready for upload in the phone (§9.4 "กล้องใช้ <input type="file" accept="image/*"
// capture="environment"> แล้วย่อรูปฝั่ง client", FR-PLT-004 AC3, FR-LINE-003 AC3): decoded upright (EXIF orientation
// applied), scaled so its longest side is at most LIFF_PHOTO_MAX_SIDE_PX, and encoded again as JPEG at
// LIFF_PHOTO_JPEG_QUALITY. Encoding again drops every metadata block of the camera — EXIF with the GPS position
// included — because a canvas keeps only the pixels. A photo this cannot decode is refused (the page asks for another
// one), as the workspace's src/ui/files/prepare-image.ts refuses one: a camera file sent as it is would carry its
// position to the server. Unlike the workspace's, which keeps PNG as PNG, every LIFF photo becomes a JPEG. An older
// WebView without createImageBitmap decodes through an <img>, which browsers also turn upright. A name
// another photo of the same receipt already has gets a number (distinctPhotoName). Loaded only when a photo is chosen
// (with ./receiving/photo-upload.ts, through import() in ./receiving/photos.tsx), so it costs the page's first
// JavaScript nothing (§9.4: 200 KB gzip).

/** The longest side of a LIFF photo in pixels: FR-PLT-004 AC3's limit (2,000 px), the same as the workspace's photos */
export const LIFF_PHOTO_MAX_SIDE_PX = MAX_IMAGE_SIDE_PX
/**
 * JPEG quality of the photo sent (0 to 1): a delivery note and damage stay readable, and a 12-megapixel camera photo
 * leaves a phone on a site's mobile network as a few hundred kilobytes instead of several megabytes
 */
export const LIFF_PHOTO_JPEG_QUALITY = 0.8
/** Every LIFF photo is sent as JPEG, whatever the camera or the gallery gave */
export const LIFF_PHOTO_TYPE = 'image/jpeg'
/** What a picture without a name of its own is called */
const DEFAULT_NAME = 'photo'

/** The size of a picture scaled down so its longest side is at most `maxSide` (never scaled up), in whole pixels */
export function fitWithin(width: number, height: number, maxSide: number): { readonly width: number; readonly height: number } {
  if (!(width > 0) || !(height > 0) || !(maxSide > 0)) throw new RangeError('a picture and its limit need positive sizes')
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The name of the photo sent: the camera's name with the extension of a JPEG ("IMG_0042.HEIC" → "IMG_0042.jpg") */
export function photoFileName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, '').trim()
  return `${base || DEFAULT_NAME}.jpg`
}

/**
 * A name no other photo of the receipt has (case ignored): "image.jpg" → "image-2.jpg", then "image-3.jpg". An iPhone
 * names every camera capture of a file input "image.jpg", and each photo is listed, removed and opened by its name — the
 * buttons would otherwise share one name for a screen reader.
 */
export function distinctPhotoName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  // One of the first taken.length + 1 numbers is free
  for (let n = 2; n <= used.size + 1; n++) {
    const candidate = `${base}-${n}${extension}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${used.size + 2}${extension}`
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
      // Fall through: some WebViews refuse the options, or the format
    }
  }
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

export type PreparedPhoto = { readonly ok: true; readonly file: File } | { readonly ok: false }

/** The photo as it is sent: upright, at most LIFF_PHOTO_MAX_SIDE_PX on its longest side, a JPEG without metadata */
export async function prepareLiffPhoto(file: File): Promise<PreparedPhoto> {
  const decoded = await decode(file)
  if (!decoded) return { ok: false }
  try {
    if (!(decoded.width > 0) || !(decoded.height > 0)) return { ok: false }
    const size = fitWithin(decoded.width, decoded.height, LIFF_PHOTO_MAX_SIDE_PX)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return { ok: false }
    // A JPEG has no transparency: what was transparent (a PNG) becomes white, not black
    context.fillStyle = 'white'
    context.fillRect(0, 0, size.width, size.height)
    context.drawImage(decoded.source, 0, 0, size.width, size.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, LIFF_PHOTO_TYPE, LIFF_PHOTO_JPEG_QUALITY))
    if (!blob || blob.type !== LIFF_PHOTO_TYPE || blob.size === 0) return { ok: false }
    return { ok: true, file: new File([blob], photoFileName(file.name), { type: LIFF_PHOTO_TYPE, lastModified: file.lastModified }) }
  } catch {
    return { ok: false }
  } finally {
    decoded.close()
  }
}

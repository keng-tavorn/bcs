// Photos are prepared in the browser before upload (FR-PLT-004 AC3): the long side becomes at most 2,000 px and the
// picture is re-encoded, which drops EXIF metadata including the GPS position. EXIF orientation is applied first so
// the photo stays upright. A format the browser cannot decode (HEIC outside Safari) is uploaded unchanged.

import { MAX_IMAGE_SIDE_PX } from '@/lib/constants'

export const MAX_IMAGE_SIDE = MAX_IMAGE_SIDE_PX
const JPEG_QUALITY = 0.85
const REENCODE: Record<string, string> = { 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/heic': 'image/jpeg' }

function renamed(name: string, type: string): string {
  if (type !== 'image/jpeg') return name
  return /\.(jpe?g)$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, '')}.jpg`
}

export async function prepareImage(file: File): Promise<File> {
  const target = REENCODE[file.type] ?? (/\.hei[cf]$/i.test(file.name) ? 'image/jpeg' : null)
  if (!target) return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return file
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, target, JPEG_QUALITY))
  if (!blob) return file
  return new File([blob], renamed(file.name, target), { type: target, lastModified: file.lastModified })
}

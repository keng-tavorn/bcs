import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getEnv } from '@/lib/env'

// Private object storage over the S3 API (spec §5.1, ADR-033, ADR-036). Browsers upload and download directly with
// presigned URLs that live at most 5 minutes (NFR-SEC-08); the bucket itself is never public.

export const PRESIGN_TTL_SECONDS = 300

let client: S3Client | null = null
function s3(): S3Client {
  if (client) return client
  const env = getEnv()
  client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    // The SDK otherwise adds checksum parameters to presigned PUT URLs, which browsers cannot satisfy
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return client
}
const bucket = () => getEnv().S3_BUCKET

/** A PUT URL bound to one content type and exact length: the upload must match what the server accepted. */
export async function presignUpload(key: string, contentType: string, contentLength: number, ttlSeconds = PRESIGN_TTL_SECONDS): Promise<string> {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, ContentLength: contentLength }), {
    expiresIn: Math.min(ttlSeconds, PRESIGN_TTL_SECONDS),
    signableHeaders: new Set(['content-type', 'content-length']),
  })
}

/** A GET URL; Office files download as attachments, pdf and images may open in the browser. */
export async function presignDownload(
  key: string,
  options: { fileName: string; contentType: string; inline: boolean },
  ttlSeconds = PRESIGN_TTL_SECONDS,
): Promise<string> {
  const disposition = `${options.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(options.fileName)}`
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentDisposition: disposition, ResponseContentType: options.contentType }),
    { expiresIn: Math.min(ttlSeconds, PRESIGN_TTL_SECONDS) },
  )
}

/** The private bucket answers with the app's credentials (health check, FR-PLT-008 AC1). Throws when it does not. */
export async function checkBucket(signal?: AbortSignal): Promise<void> {
  await s3().send(new HeadBucketCommand({ Bucket: bucket() }), signal ? { abortSignal: signal } : {})
}

export async function headObject(key: string): Promise<{ sizeBytes: number; contentType: string | null } | null> {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return { sizeBytes: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? null }
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status === 404 || (error as { name?: string }).name === 'NotFound') return null
    throw error
  }
}

/** The first bytes of an object, for type sniffing. */
export async function readHead(key: string, length: number): Promise<Uint8Array> {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${length - 1}` }))
  return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array()
}

/** sha256 of the whole object, streamed (files are at most 20 MB). */
export async function sha256Of(key: string): Promise<string> {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
  const hash = createHash('sha256')
  for await (const chunk of r.Body as Readable) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** The whole object, for a file the server sends on (a scheduled report, a PO's PDF); files are at most 20 MB */
export async function readObject(key: string): Promise<Uint8Array> {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
  return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array()
}

/** A file the server made itself (an export, a PDF): written straight to the bucket */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, ContentLength: body.length }))
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}

/** Test seam: forget the client so a changed environment is picked up. */
export function resetStorageClient(): void {
  client = null
}

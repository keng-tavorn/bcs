// Ensures the private S3 bucket exists with a CORS rule for the app origins, so browsers can upload and
// download through presigned URLs (FR-PLT-004, NFR-SEC-08). Idempotent; safe to run before every seed/test.
// Usage: pnpm exec tsx scripts/storage-init.ts
import {
  CreateBucketCommand,
  GetBucketCorsCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { config } from 'dotenv'

config({ path: '.env', quiet: true })

const bucket = process.env.S3_BUCKET ?? 'bcs-local'
const origins = [process.env.APP_URL ?? 'http://localhost:3000', 'http://localhost:3000', 'http://localhost:3100']

export function s3FromEnv(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION ?? 'ap-southeast-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' || process.env.S3_FORCE_PATH_STYLE === '1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
    // SDK ≥ 3.729 adds CRC32 checksum params to presigned PUT URLs by default, which breaks browser uploads.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

/** Makes the bucket when it is missing and sets its CORS rule; returns whether it was made. Idempotent. */
export async function ensureBucket(): Promise<{ created: boolean; allowed: string[] }> {
  const s3 = s3FromEnv()
  let created = false
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
    created = true
  }
  // Keep the origins already allowed: e2e runs on other ports (3101…) each add their own APP_URL
  const existing = await s3
    .send(new GetBucketCorsCommand({ Bucket: bucket }))
    .then((r) => (r.CORSRules ?? []).flatMap((rule) => rule.AllowedOrigins ?? []))
    .catch(() => [] as string[])
  const allowed = [...new Set([...origins, ...existing.filter((o) => /^http:\/\/localhost:\d+$/.test(o))])]
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: allowed,
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 300,
          },
        ],
      },
    }),
  )
  return { created, allowed }
}

async function main() {
  const { created, allowed } = await ensureBucket()
  console.log(`bucket ${bucket}: ${created ? 'สร้างใหม่' : 'มีอยู่แล้ว'} · ตั้ง CORS ให้ ${allowed.join(', ')}`)
}

if (process.argv[1]?.endsWith('storage-init.ts')) {
  main().catch((error: unknown) => {
    console.error(`ตั้งค่าที่เก็บไฟล์ไม่สำเร็จ: ${(error as Error).message}`)
    process.exit(1)
  })
}

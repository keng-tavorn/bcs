import { randomUUID } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { expect, test } from '@playwright/test'
import { config } from 'dotenv'
import { s3FromEnv } from '../../scripts/storage-init'

config({ path: '.env', quiet: true })
const bucket = process.env.S3_BUCKET ?? 'bcs-local'

// Decides the local S3 server (user decision 2026-10-02): a *browser* must be able to upload and download
// through presigned URLs (Node fetch ignores CORS, so it cannot prove this). Run `tsx scripts/storage-init.ts` first.
test('browser uploads and downloads through presigned URLs on the local S3 server', async ({ page }) => {
  const s3 = s3FromEnv()
  const key = `e2e/presign-${randomUUID()}.txt`
  const body = 'presigned upload ทดสอบภาษาไทย'
  const putUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'text/plain; charset=utf-8' }), {
    expiresIn: 300,
  })
  await page.goto('/')
  const putStatus = await page.evaluate(
    async ([url, text]) => {
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text })
      return res.status
    },
    [putUrl, body] as const,
  )
  expect(putStatus).toBe(200)

  const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 })
  const downloaded = await page.evaluate(async (url) => (await fetch(url)).text(), getUrl)
  expect(downloaded).toBe(body)
})

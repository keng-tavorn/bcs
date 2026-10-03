import { execSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@/lib/file-types'
import { getEnv } from '@/lib/env'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { completeUpload, getDownloadUrl, requestUpload } from '@/server/services/files'
import { createMember, createOrg } from '../support/factory'

// FR-PLT-004 against the real local S3 server (RustFS, ADR-036): upload through a presigned PUT, server-side
// verification, sha256, and short-lived downloads. The browser path (CORS, resizing) is in tests/e2e/files.spec.ts.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 56 }, (_, i) => i)])
const PDF = Buffer.from('%PDF-1.7\n' + 'x'.repeat(200) + '\n%%EOF\n', 'latin1')

beforeAll(() => {
  execSync('pnpm exec tsx scripts/storage-init.ts', { stdio: 'ignore' })
})

async function orgMember() {
  const org = await createOrg()
  const member = await createMember(org.id)
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: new Date() })
  return { org, member, ctx }
}

async function upload(ctx: ReturnType<typeof makeCtx>, body: Buffer, mimeType: string, fileName = 'quote.pdf') {
  const started = await requestUpload(ctx, { fileName, mimeType, sizeBytes: body.length })
  if (!started.ok) return { started, completed: null }
  const put = await fetch(started.data.uploadUrl, { method: 'PUT', headers: { 'content-type': mimeType }, body: new Uint8Array(body) })
  expect(put.status).toBe(200)
  return { started, completed: await completeUpload(ctx, { ticket: started.data.ticket }, { sender: null }) }
}

describe('[FR-PLT-004/AC1] allowed files up to 20 MB are stored with their sha256', () => {
  it('records the file, its sha256 and the event', async () => {
    const { ctx, member } = await orgMember()
    const { completed } = await upload(ctx, PDF, 'application/pdf', 'ใบเสนอราคา.pdf')
    expect(completed).toMatchObject({ ok: true, data: { fileName: 'ใบเสนอราคา.pdf' } })
    if (!completed?.ok) return
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: completed.data.fileId } })
    expect(file).toMatchObject({ status: 'AVAILABLE', mimeType: 'application/pdf', sizeBytes: PDF.length, uploadedById: member.id })
    const { createHash } = await import('node:crypto')
    expect(file.sha256).toBe(createHash('sha256').update(PDF).digest('hex'))
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: file.id, type: 'file.uploaded' } })
    expect(JSON.stringify(event.data)).not.toContain('ใบเสนอราคา')
  })

  it.each([
    ['text/html', 10, 'TYPE_NOT_ALLOWED'],
    ['image/svg+xml', 10, 'TYPE_NOT_ALLOWED'],
    ['application/pdf', MAX_UPLOAD_BYTES + 1, 'TOO_LARGE'],
    ['application/pdf', 0, 'EMPTY'],
  ])('refuses %s of %s bytes (%s) before any upload URL is given', async (mimeType, sizeBytes, reason) => {
    const { ctx } = await orgMember()
    expect(await requestUpload(ctx, { fileName: 'x', mimeType, sizeBytes })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason } } })
  })

  it('refuses and deletes a file whose bytes do not match its type (a PNG renamed .pdf)', async () => {
    const { ctx } = await orgMember()
    const started = await requestUpload(ctx, { fileName: 'fake.pdf', mimeType: 'application/pdf', sizeBytes: PNG.length })
    if (!started.ok) throw new Error('expected an upload URL')
    await fetch(started.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array(PNG) })
    const done = await completeUpload(ctx, { ticket: started.data.ticket }, { sender: null })
    expect(done).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'CONTENT_MISMATCH' } } })
    expect(await prisma.fileObject.count({ where: { organizationId: ctx.organizationId } })).toBe(0)
    // the object is gone: completing again finds nothing
    expect(await completeUpload(ctx, { ticket: started.data.ticket }, { sender: null })).toMatchObject({ ok: false, error: { details: { reason: 'NOT_UPLOADED' } } })
  })

  it('the upload URL only accepts the declared length and type', async () => {
    const { ctx } = await orgMember()
    const started = await requestUpload(ctx, { fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length })
    if (!started.ok) throw new Error('expected an upload URL')
    const longer = await fetch(started.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array(Buffer.concat([PDF, PDF])) })
    expect(longer.ok).toBe(false)
    const otherType = await fetch(started.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: new Uint8Array(PDF) })
    expect(otherType.ok).toBe(false)
  })

  it('a tampered ticket, or another member\'s ticket, is refused', async () => {
    const { ctx, org } = await orgMember()
    const started = await requestUpload(ctx, { fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length })
    if (!started.ok) throw new Error('expected an upload URL')
    const [payload, mac] = started.data.ticket.split('.')
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString())
    forged.size = 1
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${mac}`
    expect(await completeUpload(ctx, { ticket: tampered }, { sender: null })).toMatchObject({ ok: false, error: { details: { reason: 'TICKET_INVALID' } } })
    const other = await createMember(org.id)
    const otherCtx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: other.id }, channel: 'WEB', now: new Date() })
    expect(await completeUpload(otherCtx, { ticket: started.data.ticket }, { sender: null })).toMatchObject({ ok: false, error: { details: { reason: 'TICKET_INVALID' } } })
  })
})

describe('[FR-PLT-004/AC2] downloads use presigned URLs of at most 5 minutes; the bucket is not reachable directly', () => {
  it('the uploader gets a short-lived URL that works; other members and organizations do not', async () => {
    const { ctx, org } = await orgMember()
    const { completed } = await upload(ctx, PDF, 'application/pdf')
    if (!completed?.ok) throw new Error('upload failed')
    const r = await getDownloadUrl(ctx, { fileId: completed.data.fileId })
    if (!r.ok) throw new Error('expected a URL')
    expect(Number(new URL(r.data.url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
    const got = await fetch(r.data.url)
    expect(got.status).toBe(200)
    expect(Buffer.from(await got.arrayBuffer()).equals(PDF)).toBe(true)

    const colleague = await createMember(org.id)
    const colleagueCtx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: colleague.id }, channel: 'WEB', now: new Date() })
    expect(await getDownloadUrl(colleagueCtx, { fileId: completed.data.fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const stranger = await orgMember()
    expect(await getDownloadUrl(stranger.ctx, { fileId: completed.data.fileId })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('the object cannot be read from the bucket without a signature', async () => {
    const { ctx } = await orgMember()
    const { completed } = await upload(ctx, PDF, 'application/pdf')
    if (!completed?.ok) throw new Error('upload failed')
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: completed.data.fileId } })
    const env = getEnv()
    const direct = await fetch(`${env.S3_ENDPOINT}/${env.S3_BUCKET}/${file.storageKey}`)
    expect(direct.status).toBe(403)
  })
})

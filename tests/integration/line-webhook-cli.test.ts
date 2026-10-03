import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST } from '@/app/api/webhooks/line/[channelKey]/route'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { newLineUserId } from '../../scripts/line-simulate'
import { createMember, createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-02 · FR-LINE-005 with the command itself: `pnpm line:simulate` (scripts/line-simulate.ts, run here with tsx as the
// package script does) signs a webhook with the channel secret of the environment, finds the channel key in the
// database, posts to APP_URL/api/webhooks/line/<channelKey> and says what the app answered — and the route takes it. The
// app runs in this process behind a small HTTP server standing in for `pnpm dev`, on a free port.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const OTHER_SECRET = 'fedcba9876543210fedcba9876543210'

const line = withFakeLine()
let inngestBefore: OutboxSender | null = null
let server: Server
let appUrl = ''
let stateDir = ''

beforeAll(async () => {
  inngestBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(null)
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'bcs-line-simulate-'))
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        const match = /^\/api\/webhooks\/line\/([^/?]+)$/.exec(req.url ?? '')
        if (!match || req.method !== 'POST') {
          res.statusCode = 404
          res.end()
          return
        }
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value)
        const response = await POST(new Request(`${appUrl}${req.url}`, { method: 'POST', headers, body: Buffer.concat(chunks) }), {
          params: Promise.resolve({ channelKey: decodeURIComponent(match[1]!) }),
        })
        res.statusCode = response.status
        res.end()
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  setDefaultOutboxSender(inngestBefore)
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(stateDir, { recursive: true, force: true })
})

/** Runs `pnpm line:simulate …` (tsx scripts/line-simulate.ts, without a shell: postback data holds "&") */
function simulate(args: readonly string[], env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, 'scripts/line-simulate.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, APP_ENV: 'local', APP_URL: appUrl, LINE_SIMULATE_STATE_FILE: path.join(stateDir, 'last.json'), ...env },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

describe('[FR-LINE-005/AC1] pnpm line:simulate signs a webhook the route takes, and one signed with another secret is refused', () => {
  it('sends a follow (200, processed), redelivers it (200, not processed again) and is refused with another secret (401)', async () => {
    const org = await createOrg()
    const admin = await createMember(org.id, 'ผู้ดูแล')
    await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: new Date() })
    const saved = await saveLineChannelSettings(
      ctx,
      { providerId: '1650000001', messagingChannelId: '1650000002', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, active: true },
      { idempotencyKey: randomUUID(), sender: null },
    )
    if (!saved.ok) throw new Error(saved.error.code)
    const user = newLineUserId()
    const env = { LINE_MESSAGING_CHANNEL_SECRET: TEST_CHANNEL_SECRET }

    // The channel key comes from the database (--org picks the organization), the secret from the environment
    const sent = await simulate(['follow', '--org', org.code, '--user', user], env)
    expect(sent.code).toBe(0)
    expect(sent.output).toContain(`/api/webhooks/line/${saved.data.channelKey} → 200`)
    const events = await prisma.lineWebhookEvent.findMany({ where: { organizationId: org.id } })
    expect(events).toMatchObject([{ type: 'follow', status: 'PROCESSED', payload: { userId: user, redelivery: false } }])
    expect(sent.output).toContain(events[0]!.webhookEventId)
    const replies = () => line.fake.messages().filter((m) => m.kind === 'reply' && events.some((e) => (e.payload as { replyToken?: string }).replyToken === m.replyToken))
    expect(replies()).toHaveLength(1)

    const again = await simulate(['redeliver'], env)
    expect(again.code).toBe(0)
    expect(again.output).toContain('(ส่งซ้ำ)')
    expect(again.output).toContain('→ 200')
    expect(await prisma.lineWebhookEvent.count({ where: { organizationId: org.id } })).toBe(1)
    expect(replies()).toHaveLength(1)

    const forged = await simulate(['unfollow', '--org', org.code, '--user', user, '--secret', OTHER_SECRET], env)
    expect(forged.code).toBe(1)
    expect(forged.output).toContain('→ 401')
    expect(await prisma.lineWebhookEvent.count({ where: { organizationId: org.id } })).toBe(1)

    // Never prints a secret
    for (const output of [sent.output, again.output, forged.output]) {
      expect(output).not.toContain(TEST_CHANNEL_SECRET)
      expect(output).not.toContain(OTHER_SECRET)
    }
  })

  it('refuses to run outside APP_ENV=local, and without a secret', async () => {
    const outside = await simulate(['follow', '--url', `${appUrl}/api/webhooks/line/${'A'.repeat(24)}`], { APP_ENV: 'staging', LINE_MESSAGING_CHANNEL_SECRET: TEST_CHANNEL_SECRET })
    expect(outside.code).toBe(1)
    expect(outside.output).toContain('APP_ENV=local')
    const noSecret = await simulate(['follow', '--url', `${appUrl}/api/webhooks/line/${'A'.repeat(24)}`], { LINE_MESSAGING_CHANNEL_SECRET: '' })
    expect(noSecret.code).toBe(1)
    expect(noSecret.output).toContain('LINE_MESSAGING_CHANNEL_SECRET')
  })
})

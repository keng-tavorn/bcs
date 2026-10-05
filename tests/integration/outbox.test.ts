import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { maxDuration } from '@/app/api/inngest/route'
import {
  MS_PER_SECOND,
  OUTBOX_DISPATCH_TIMEOUT_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_MAX_MS,
  OUTBOX_STALL_ALERT_AFTER_MS,
  OUTBOX_SWEEP_AFTER_MS,
  OUTBOX_SWEEP_BATCH_SIZE,
  OUTBOX_SWEEP_BUDGET_MS,
  OUTBOX_SWEEP_SEND_TIMEOUT_MS,
} from '@/lib/constants'
import { newId } from '@/lib/ids'
import { logger, REDACTED } from '@/lib/logger'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import {
  describeSendError,
  OutboxRefusedError,
  OutboxUncertainError,
  OutboxUnavailableError,
  sweepOutbox,
  type OutboxMessage,
  type OutboxSender,
} from '@/server/events/outbox'
import { defineEvents } from '@/server/events/registry'
import { createInngestSender } from '@/server/inngest'
import { OUTBOX_SWEEPER_CRON, outboxSweeper } from '@/server/jobs/outbox-sweeper'
import { defineCommand, runCommand, scopedIdempotencyKey, type CommandOutcome } from '@/server/services/_pipeline'
import { createMember, createOrg } from '../support/factory'
import { testMigratorUrl } from '../support/test-db'

// The transactional outbox relay against real Postgres (ADR-030, spec §4.3 step 5, FR-PLT-012 AC3): the send
// right after commit, and the outbox-sweeper job.
//
// The sweeper works across organizations, and other test files write outbox rows into the same database at the
// same time. Rows built here are stamped in a past year and swept with `now` in that year, where no row of
// another file is due; every test retires (deadAt) its leftover rows so no later sweep picks them up.

defineEvents('RelayProbe', {
  'relay_probe.touched': { schema: z.object({ label: z.string() }) },
})

const touch = defineCommand({
  name: 'test.relay_touch',
  capability: 'test.relay_touch',
  input: z.object({ label: z.string() }),
  async execute(_tx, input, ctx): Promise<CommandOutcome<{ label: string }>> {
    return {
      ok: true,
      result: { label: input.label },
      events: [{ type: 'relay_probe.touched', aggregateType: 'RelayProbe', aggregateId: ctx.organizationId, data: { label: input.label } }],
    }
  },
})

const NOW = new Date('2026-10-05T03:00:00Z')
const MINUTE = 60_000
const era = (n: number) => Date.UTC(2000 + n, 0, 1)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const orgsOfTest: string[] = []
async function newOrg() {
  const org = await createOrg()
  orgsOfTest.push(org.id)
  return org
}

async function memberCtx(organizationId: string): Promise<Ctx> {
  const member = await createMember(organizationId)
  return makeCtx({ organizationId, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: NOW })
}

/** Unsent rows created at base, base + 1 s, … (as if written while Inngest was away). */
async function insertRows(organizationId: string, count: number, base: number, extra: { eventName?: string; suppressed?: boolean } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: newId(),
    organizationId,
    eventName: extra.eventName ?? 'bcs/relay_probe.touched',
    payload: { i },
    suppressed: extra.suppressed ?? false,
    createdAt: new Date(base + i * 1000),
  }))
  await prisma.outbox.createMany({ data: rows })
  return rows.map((r) => r.id)
}

function recorder() {
  const delivered = new Map<string, number>()
  const batches: number[] = []
  const sender: OutboxSender = async (messages) => {
    batches.push(messages.length)
    for (const m of messages) delivered.set(m.id, (delivered.get(m.id) ?? 0) + 1)
  }
  return { sender, delivered, batches }
}

interface ApiEvent {
  readonly id: string
  readonly name: string
}

interface FakeAnswer {
  readonly status?: number
  readonly delayMs?: number
  /** Accept the request and never answer it */
  readonly hang?: boolean
}

/** A fake Inngest event API (POST /e/<event key>) behind the real sender, createInngestSender. */
async function fakeEventApi(answer: (events: readonly ApiEvent[]) => FakeAnswer = () => ({})) {
  const accepted = new Map<string, number>()
  /** The event ids of every request received, in order */
  const requests: string[][] = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const events = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApiEvent[]
      requests.push(events.map((e) => e.id))
      const { status = 200, delayMs = 0, hang = false } = answer(events)
      if (hang) return
      setTimeout(() => {
        if (res.destroyed) return
        if (status === 200) for (const e of events) accepted.set(e.id, (accepted.get(e.id) ?? 0) + 1)
        // connection: close — each case starts a fake on a free port, and the OS may hand the next case the same port:
        // a keep-alive socket of the closed fake must never be reused for it (fetch failed under load)
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify(status === 200 ? { ids: events.map((e) => e.id), status } : { error: `fake answer ${status}`, status }))
      }, delayMs)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const baseUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`
  return {
    sender: createInngestSender({ baseUrl, isDev: true }),
    accepted,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** A local port nothing listens on: connecting is refused at once. */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Unsent rows with one poison message in the middle, ordered as the sweeper claims them. */
async function rowsWithPoison(organizationId: string, count: number, base: number) {
  const ids = await insertRows(organizationId, count, base)
  const poisonId = ids[Math.floor(count / 2)]!
  return { poisonId, good: ids.filter((id) => id !== poisonId) }
}

const alertsOf = (errorLog: { mock: { calls: unknown[][] } }) =>
  errorLog.mock.calls.map(([fields]) => fields as Record<string, unknown>).filter((fields) => fields.alert === true)

afterEach(async () => {
  vi.restoreAllMocks()
  if (orgsOfTest.length) {
    await prisma.outbox.updateMany({ where: { organizationId: { in: orgsOfTest }, sentAt: null, deadAt: null }, data: { deadAt: new Date() } })
    orgsOfTest.length = 0
  }
})

describe('[FR-PLT-012/AC3] the outbox survives an Inngest outage', () => {
  it('keeps the outbox when sending fails at commit and the sweeper sends it within 2 minutes after recovery', async () => {
    const org = await newOrg()
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'SYSTEM' }, channel: 'SYSTEM', now: NOW })
    const downSender: OutboxSender = async () => {
      throw new Error('inngest unavailable')
    }
    const r = await runCommand(ctx, touch, { label: 'Outage Co' }, { idempotencyKey: randomUUID(), sender: downSender })
    expect(r.ok).toBe(true)
    const pending = await prisma.outbox.findMany({ where: { organizationId: org.id } })
    expect(pending.length).toBeGreaterThan(0)
    expect(pending.every((o) => o.sentAt === null && o.attempts === 1 && o.lastError === 'inngest unavailable')).toBe(true)

    // The sweeper runs every minute and retries a row 30 s after its failed send → out within ~90 s.
    expect(OUTBOX_SWEEPER_CRON).toBe('* * * * *')
    const { sender, delivered } = recorder()
    const createdAt = Math.max(...pending.map((o) => o.createdAt.getTime()))
    await sweepOutbox(sender, new Date(createdAt + 10_000))
    expect(await prisma.outbox.count({ where: { organizationId: org.id, sentAt: { not: null } } })).toBe(0)
    await sweepOutbox(sender, new Date(createdAt + MINUTE))
    expect(await prisma.outbox.count({ where: { organizationId: org.id, sentAt: null } })).toBe(0)
    expect(pending.every((o) => delivered.get(o.id) === 1)).toBe(true)
  })

  it('sends a backlog much larger than one batch in a single sweeper run', async () => {
    const org = await newOrg()
    const base = era(1)
    const ids = await insertRows(org.id, 2 * OUTBOX_SWEEP_BATCH_SIZE + 50, base)
    const { sender, delivered, batches } = recorder()
    const result = await sweepOutbox(sender, new Date(base + 60 * MINUTE))
    expect(result).toEqual({ claimed: ids.length, sent: ids.length, failed: 0, dead: 0, stoppedBy: 'drained' })
    expect(ids.every((id) => delivered.get(id) === 1)).toBe(true)
    expect(Math.max(...batches)).toBeLessThanOrEqual(OUTBOX_SWEEP_BATCH_SIZE)
    expect(await prisma.outbox.count({ where: { id: { in: ids }, sentAt: null } })).toBe(0)
  })

  it('does not let one message Inngest refuses hold back any other message, of any organization', async () => {
    const orgA = await newOrg()
    const orgB = await newOrg()
    const base = era(2)
    const [poisonId] = await insertRows(orgA.id, 1, base, { eventName: 'bcs/relay_probe.oversized' })
    const good = [...(await insertRows(orgA.id, 75, base + 1000)), ...(await insertRows(orgB.id, 75, base + 2000))]
    const { delivered } = recorder()
    const sender: OutboxSender = async (messages) => {
      if (messages.some((m) => m.id === poisonId)) throw new Error('Inngest API Error: 413 Event payload too large')
      for (const m of messages) delivered.set(m.id, (delivered.get(m.id) ?? 0) + 1)
    }
    const now = new Date(base + 5 * MINUTE)
    const result = await sweepOutbox(sender, now)
    expect(result).toEqual({ claimed: 151, sent: 150, failed: 1, dead: 0, stoppedBy: 'drained' })
    expect(good.every((id) => delivered.get(id) === 1)).toBe(true)
    const poison = await prisma.outbox.findUniqueOrThrow({ where: { id: poisonId! } })
    expect(poison).toMatchObject({ sentAt: null, deadAt: null, attempts: 1, nextAttemptAt: new Date(now.getTime() + OUTBOX_RETRY_BASE_MS) })
    expect(poison.lastError).toContain('413')
  })

  it('[NFR-OBS-02] backs a refused message off exponentially, then marks it dead and raises an alert', async () => {
    const org = await newOrg()
    const base = era(3)
    const [poisonId] = await insertRows(org.id, 1, base, { eventName: 'bcs/relay_probe.malformed' })
    const sender: OutboxSender = async (messages) => {
      if (messages.some((m) => m.id === poisonId)) throw new Error('Inngest API Error: 400 Cannot process event payload')
    }
    const errorLog = vi.spyOn(logger, 'error')
    let now = new Date(base + OUTBOX_SWEEP_AFTER_MS)
    const delays: number[] = []
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      expect((await sweepOutbox(sender, now)).failed).toBe(1)
      const row = await prisma.outbox.findUniqueOrThrow({ where: { id: poisonId! } })
      expect(row.attempts).toBe(attempt)
      if (attempt === OUTBOX_MAX_ATTEMPTS) {
        expect(row).toMatchObject({ deadAt: now, nextAttemptAt: null, sentAt: null })
        break
      }
      expect(row.deadAt).toBeNull()
      delays.push(row.nextAttemptAt!.getTime() - now.getTime())
      expect((await sweepOutbox(sender, new Date(row.nextAttemptAt!.getTime() - 1))).claimed).toBe(0)
      now = row.nextAttemptAt!
    }
    expect(delays).toEqual(Array.from({ length: OUTBOX_MAX_ATTEMPTS - 1 }, (_, i) => Math.min(OUTBOX_RETRY_BASE_MS * 2 ** i, OUTBOX_RETRY_MAX_MS)))
    const alerts = errorLog.mock.calls.filter(([fields]) => (fields as { alert?: boolean }).alert === true)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]![0]).toMatchObject({ alert: true, outboxId: poisonId, organizationId: org.id, eventName: 'bcs/relay_probe.malformed' })
    // A dead row is never claimed again
    expect((await sweepOutbox(sender, new Date(now.getTime() + 24 * 60 * MINUTE))).claimed).toBe(0)
  })

  it('stops after one try while Inngest is unavailable, never kills a row for it, and sends everything at the first sweep after it returns', async () => {
    const org = await newOrg()
    const base = era(4)
    const ids = await insertRows(org.id, 30, base)
    let calls = 0
    const down: OutboxSender = async () => {
      calls++
      throw new OutboxUnavailableError('Inngest API Error: 401 Event key Not Found')
    }
    let now = new Date(base + MINUTE)
    for (let minute = 0; minute < OUTBOX_MAX_ATTEMPTS + 2; minute++, now = new Date(now.getTime() + MINUTE)) {
      calls = 0
      expect(await sweepOutbox(down, now)).toMatchObject({ claimed: ids.length, sent: 0, dead: 0, stoppedBy: 'unavailable' })
      expect(calls).toBe(1)
    }
    // Unavailability is never counted as an attempt (only refusals are), and the cause is kept for the team
    const rows = await prisma.outbox.findMany({ where: { id: { in: ids } } })
    expect(rows.every((r) => r.attempts === 0 && r.deadAt === null && r.sentAt === null && r.lastError?.includes('401'))).toBe(true)
    // Inngest is back: the next minute's run sends the whole backlog
    const { sender, delivered } = recorder()
    expect(await sweepOutbox(sender, now)).toMatchObject({ sent: ids.length, stoppedBy: 'drained' })
    expect(ids.every((id) => delivered.get(id) === 1)).toBe(true)
  })

  it('never sends a row twice when two sweeper runs overlap', async () => {
    const org = await newOrg()
    const base = era(5)
    const ids = await insertRows(org.id, 120, base)
    const { delivered } = recorder()
    const slow: OutboxSender = async (messages) => {
      await sleep(30)
      for (const m of messages) delivered.set(m.id, (delivered.get(m.id) ?? 0) + 1)
    }
    const now = new Date(base + 5 * MINUTE)
    const [a, b] = await Promise.all([sweepOutbox(slow, now, { batchSize: 20 }), sweepOutbox(slow, now, { batchSize: 20 })])
    expect(a.sent + b.sent).toBe(ids.length)
    expect(ids.every((id) => delivered.get(id) === 1)).toBe(true)
  })

  it('never sends suppressed rows (demo history)', async () => {
    const org = await newOrg()
    const base = era(6)
    const ids = await insertRows(org.id, 3, base, { suppressed: true })
    const { sender, delivered } = recorder()
    expect((await sweepOutbox(sender, new Date(base + 60 * MINUTE))).claimed).toBe(0)
    expect(ids.some((id) => delivered.has(id))).toBe(false)
  })

  it('runs as one Inngest execution per minute: no Inngest-side retries', () => {
    expect(outboxSweeper.opts).toMatchObject({ id: 'outbox-sweeper', retries: 0, triggers: [{ cron: OUTBOX_SWEEPER_CRON }] })
  })

  it('fits one sweeper run (its time budget plus one last send) in the time limit of the Inngest route', () => {
    expect(maxDuration * MS_PER_SECOND).toBeGreaterThanOrEqual(OUTBOX_SWEEP_BUDGET_MS + OUTBOX_SWEEP_SEND_TIMEOUT_MS)
  })

  it('never lets an outage use up the refusal budget: a message refused after a long outage still gets every attempt', async () => {
    const org = await newOrg()
    const base = era(12)
    const [id] = await insertRows(org.id, 1, base)
    const row = () => prisma.outbox.findUniqueOrThrow({ where: { id: id! } })
    const down: OutboxSender = async () => {
      throw new OutboxUnavailableError('Inngest API Error: 503 down')
    }
    let now = new Date(base + MINUTE)
    for (let minute = 0; minute < OUTBOX_MAX_ATTEMPTS + 2; minute++, now = new Date(now.getTime() + MINUTE)) await sweepOutbox(down, now)
    expect(await row()).toMatchObject({ attempts: 0, deadAt: null, sentAt: null })
    const refuse: OutboxSender = async () => {
      throw new Error('Inngest API Error: 409 Event transformation failed')
    }
    for (let refusal = 1; refusal <= OUTBOX_MAX_ATTEMPTS; refusal++) {
      expect((await sweepOutbox(refuse, now)).failed).toBe(1)
      const current = await row()
      expect(current.attempts).toBe(refusal)
      if (refusal === OUTBOX_MAX_ATTEMPTS) {
        expect(current).toMatchObject({ deadAt: now, nextAttemptAt: null })
        break
      }
      expect(current.deadAt).toBeNull()
      expect(current.nextAttemptAt).toEqual(new Date(now.getTime() + Math.min(OUTBOX_RETRY_BASE_MS * 2 ** (refusal - 1), OUTBOX_RETRY_MAX_MS)))
      now = current.nextAttemptAt!
    }
  })

  it('[NFR-OBS-02] raises an alert, shaped like the dead-message alert, when no message could be sent for OUTBOX_STALL_ALERT_AFTER_MS', async () => {
    const org = await newOrg()
    const base = era(13)
    const ids = await insertRows(org.id, 5, base)
    const down: OutboxSender = async () => {
      throw new OutboxUnavailableError('Inngest API Error: 503 down')
    }
    const errorLog = vi.spyOn(logger, 'error')
    await sweepOutbox(down, new Date(base + MINUTE))
    await sweepOutbox(down, new Date(base + OUTBOX_STALL_ALERT_AFTER_MS - MINUTE))
    expect(alertsOf(errorLog)).toEqual([])
    const stalledAt = new Date(base + OUTBOX_STALL_ALERT_AFTER_MS)
    expect(await sweepOutbox(down, stalledAt)).toMatchObject({ sent: 0, stoppedBy: 'unavailable' })
    expect(alertsOf(errorLog)).toHaveLength(1)
    const [alert] = alertsOf(errorLog)
    expect(alert).toMatchObject({ alert: true, outboxId: ids[0], organizationId: org.id, eventName: 'bcs/relay_probe.touched', attempts: 0 })
    expect(alert!.err).toBeInstanceOf(OutboxUnavailableError)
    // Inngest is back: the backlog goes out and nothing more is raised
    const { sender, delivered } = recorder()
    expect(await sweepOutbox(sender, new Date(stalledAt.getTime() + MINUTE))).toMatchObject({ sent: ids.length, stoppedBy: 'drained' })
    expect(ids.every((id) => delivered.get(id) === 1)).toBe(true)
    expect(alertsOf(errorLog)).toHaveLength(1)
  })
})

describe('[FR-PLT-012/AC3] the relay through the real Inngest sender (fake event API)', () => {
  it('classifies what the event API answers: refused messages, Inngest unavailable, or no verdict', async () => {
    const message = (): OutboxMessage => ({ id: newId(), name: 'bcs/relay_probe.touched', data: { i: 0 } })
    const cases: Array<[number, new (...args: never[]) => Error]> = [
      [400, OutboxRefusedError],
      [413, OutboxRefusedError],
      [422, OutboxRefusedError],
      [401, OutboxUnavailableError],
      [403, OutboxUnavailableError],
      [404, OutboxUnavailableError],
      [429, OutboxUnavailableError],
      [500, OutboxUncertainError],
      [502, OutboxUncertainError],
      [503, OutboxUncertainError],
    ]
    for (const [status, expected] of cases) {
      const api = await fakeEventApi(() => ({ status }))
      try {
        const error = await api.sender([message()]).then(
          () => null,
          (e: unknown) => e,
        )
        expect(error, `status ${status}`).toBeInstanceOf(expected)
        expect((error as Error).message).toContain(String(status))
        expect(api.requests).toHaveLength(1)
      } finally {
        await api.close()
      }
    }
    // Nothing listens: Inngest cannot be reached, whatever the messages
    const refused = createInngestSender({ baseUrl: `http://127.0.0.1:${await closedPort()}/`, isDev: true })
    const unreachable = await refused([message()]).then(() => null, (e: unknown) => e)
    expect(unreachable).toBeInstanceOf(OutboxUnavailableError)
    expect((unreachable as Error).message).toContain('ECONNREFUSED')
    // The connection drops after the request was sent: no verdict on the messages
    const dropping = net.createServer((socket) => socket.once('data', () => socket.destroy()))
    await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', () => resolve()))
    try {
      const sender = createInngestSender({ baseUrl: `http://127.0.0.1:${(dropping.address() as net.AddressInfo).port}/`, isDev: true })
      expect(await sender([message()]).then(() => null, (e: unknown) => e)).toBeInstanceOf(OutboxUncertainError)
    } finally {
      dropping.close()
    }
  })

  it('sends a batch with one request: the sender never retries inside a send', async () => {
    const org = await newOrg()
    const base = era(7)
    const [id] = await insertRows(org.id, 1, base)
    const api = await fakeEventApi(() => ({ status: 400 }))
    try {
      expect(await sweepOutbox(api.sender, new Date(base + MINUTE))).toMatchObject({ claimed: 1, sent: 0, failed: 1, stoppedBy: 'drained' })
      expect(api.requests).toHaveLength(1)
      const row = await prisma.outbox.findUniqueOrThrow({ where: { id: id! } })
      expect(row).toMatchObject({ attempts: 1, deadAt: null, sentAt: null })
      expect(row.lastError).toContain('400')
    } finally {
      await api.close()
    }
  })

  it('isolates a message that makes Inngest answer 5xx, and sends every other message of every organization in the same run', async () => {
    const orgA = await newOrg()
    const orgB = await newOrg()
    const base = era(8)
    const { poisonId, good } = await rowsWithPoison(orgA.id, 90, base)
    const others = await insertRows(orgB.id, 60, base + 500)
    const api = await fakeEventApi((events) => ({ status: events.some((e) => e.id === poisonId) ? 500 : 200 }))
    try {
      expect(await sweepOutbox(api.sender, new Date(base + 5 * MINUTE))).toEqual({ claimed: 150, sent: 149, failed: 1, dead: 0, stoppedBy: 'drained' })
      expect([...good, ...others].every((id) => api.accepted.get(id) === 1)).toBe(true)
      const poison = await prisma.outbox.findUniqueOrThrow({ where: { id: poisonId } })
      expect(poison).toMatchObject({ sentAt: null, deadAt: null, attempts: 1 })
      expect(poison.lastError).toContain('500')
      // Bisection with control sends: a few requests per halving, never one per message
      expect(api.requests.length).toBeLessThanOrEqual(3 * Math.ceil(Math.log2(OUTBOX_SWEEP_BATCH_SIZE)) + 4)
    } finally {
      await api.close()
    }
  })

  it('isolates a message Inngest never answers within one run', async () => {
    const org = await newOrg()
    const base = era(9)
    const { poisonId, good } = await rowsWithPoison(org.id, 40, base)
    const api = await fakeEventApi((events) => (events.some((e) => e.id === poisonId) ? { hang: true } : {}))
    try {
      expect(await sweepOutbox(api.sender, new Date(base + 5 * MINUTE), { sendTimeoutMs: 300 })).toEqual({ claimed: 40, sent: 39, failed: 1, dead: 0, stoppedBy: 'drained' })
      expect(good.every((id) => api.accepted.get(id) === 1)).toBe(true)
      const poison = await prisma.outbox.findUniqueOrThrow({ where: { id: poisonId } })
      expect(poison).toMatchObject({ sentAt: null, deadAt: null, attempts: 1 })
      expect(poison.lastError).toContain('no answer')
    } finally {
      await api.close()
    }
  })

  it('isolates a refused message within one run although every answer is slow', async () => {
    const org = await newOrg()
    const base = era(10)
    const { poisonId, good } = await rowsWithPoison(org.id, 60, base)
    const api = await fakeEventApi((events) => ({ status: events.some((e) => e.id === poisonId) ? 400 : 200, delayMs: 250 }))
    try {
      expect(await sweepOutbox(api.sender, new Date(base + 5 * MINUTE), { sendTimeoutMs: 1000 })).toEqual({ claimed: 60, sent: 59, failed: 1, dead: 0, stoppedBy: 'drained' })
      expect(good.every((id) => api.accepted.get(id) === 1)).toBe(true)
      // Plain bisection: two requests per halving
      expect(api.requests.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(60)) + 1)
    } finally {
      await api.close()
    }
  })

  it('treats 5xx for every send as Inngest unavailable: a few requests per run, nothing counted, all sent once it recovers', async () => {
    const org = await newOrg()
    const base = era(11)
    const ids = await insertRows(org.id, 30, base)
    let status = 500
    const api = await fakeEventApi(() => ({ status }))
    try {
      let now = new Date(base + MINUTE)
      for (let minute = 0; minute < OUTBOX_MAX_ATTEMPTS + 2; minute++, now = new Date(now.getTime() + MINUTE)) {
        const before = api.requests.length
        expect(await sweepOutbox(api.sender, now)).toMatchObject({ sent: 0, dead: 0, stoppedBy: 'unavailable' })
        expect(api.requests.length - before).toBeLessThanOrEqual(3)
      }
      const rows = await prisma.outbox.findMany({ where: { id: { in: ids } } })
      expect(rows.every((r) => r.attempts === 0 && r.deadAt === null && r.sentAt === null && r.lastError?.includes('500'))).toBe(true)
      status = 200
      expect(await sweepOutbox(api.sender, now)).toMatchObject({ sent: ids.length, stoppedBy: 'drained' })
      expect(ids.every((id) => api.accepted.get(id) === 1)).toBe(true)
    } finally {
      await api.close()
    }
  })
})

describe('[FR-PLT-012/AC3] the send right after commit is bounded and never fails a committed command', () => {
  it('holds the response at most about 2 seconds when the sender never answers, and leaves the row to the sweeper', async () => {
    const org = await newOrg()
    const ctx = await memberCtx(org.id)
    const never: OutboxSender = () => new Promise<void>(() => {})
    const started = performance.now()
    const r = await Promise.race([
      runCommand(ctx, touch, { label: 'Hanging' }, { idempotencyKey: randomUUID(), sender: never }),
      sleep(10_000).then(() => 'still waiting' as const),
    ])
    expect(r).toEqual({ ok: true, data: { label: 'Hanging' } })
    expect(performance.now() - started).toBeLessThan(OUTBOX_DISPATCH_TIMEOUT_MS + 1000)
    // No answer is no verdict on the message: nothing is counted toward OUTBOX_MAX_ATTEMPTS, the cause is kept
    await vi.waitFor(async () => {
      const row = await prisma.outbox.findFirstOrThrow({ where: { organizationId: org.id } })
      expect(row).toMatchObject({ sentAt: null, attempts: 0 })
      expect(row.lastError).toContain('no answer')
      expect(row.nextAttemptAt).not.toBeNull()
    })
  })

  it('makes one request after commit and records why it failed, without making the command wait', async () => {
    const org = await newOrg()
    const ctx = await memberCtx(org.id)
    const rowOf = (label: string) => prisma.outbox.findFirstOrThrow({ where: { organizationId: org.id, payload: { path: ['data', 'label'], equals: label } } })
    // Inngest answers 503 at once: one request, no retries on the request path
    const api = await fakeEventApi(() => ({ status: 503 }))
    try {
      expect(await runCommand(ctx, touch, { label: 'Answered 503' }, { idempotencyKey: randomUUID(), sender: api.sender })).toEqual({ ok: true, data: { label: 'Answered 503' } })
      expect(api.requests).toHaveLength(1)
      const row = await rowOf('Answered 503')
      expect(row).toMatchObject({ sentAt: null, attempts: 0 })
      expect(row.lastError).toContain('503')
      expect(row.nextAttemptAt).not.toBeNull()
    } finally {
      await api.close()
    }
    // Nothing listens: the command answers without waiting for a deadline, and the cause is recorded
    const sender = createInngestSender({ baseUrl: `http://127.0.0.1:${await closedPort()}/`, isDev: true })
    const started = performance.now()
    expect(await runCommand(ctx, touch, { label: 'Refused' }, { idempotencyKey: randomUUID(), sender })).toEqual({ ok: true, data: { label: 'Refused' } })
    expect(performance.now() - started).toBeLessThan(OUTBOX_DISPATCH_TIMEOUT_MS / 2)
    const refused = await rowOf('Refused')
    expect(refused).toMatchObject({ sentAt: null, attempts: 0 })
    expect(refused.lastError).toContain('ECONNREFUSED')
  })

  it('gives up on an Inngest event API that accepts the connection but never answers, and closes the request', async () => {
    const org = await newOrg()
    const ctx = await memberCtx(org.id)
    const sockets: net.Socket[] = []
    const closed: Array<Promise<void>> = []
    const server = net.createServer((socket) => {
      sockets.push(socket)
      closed.push(new Promise<void>((resolve) => socket.on('close', () => resolve())))
      socket.resume() // read and drop the request, never answer
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const port = (server.address() as net.AddressInfo).port
      const sender = createInngestSender({ baseUrl: `http://127.0.0.1:${port}/`, isDev: true })
      const started = performance.now()
      const r = await Promise.race([
        runCommand(ctx, touch, { label: 'Blackhole' }, { idempotencyKey: randomUUID(), sender }),
        sleep(10_000).then(() => 'still waiting' as const),
      ])
      expect(r).toEqual({ ok: true, data: { label: 'Blackhole' } })
      expect(performance.now() - started).toBeLessThan(OUTBOX_DISPATCH_TIMEOUT_MS + 1000)
      expect(sockets.length).toBeGreaterThan(0)
      expect(await Promise.race([Promise.all(closed).then(() => 'closed'), sleep(5000).then(() => 'still open')])).toBe('closed')
      const row = await prisma.outbox.findFirstOrThrow({ where: { organizationId: org.id } })
      expect(row).toMatchObject({ sentAt: null, attempts: 0 })
      expect(row.lastError).toContain('no answer')
    } finally {
      for (const socket of sockets) socket.destroy()
      server.close()
    }
  })

  it('reports a committed command as ok when the sender rejects with something that is not an Error', async () => {
    const org = await newOrg()
    const ctx = await memberCtx(org.id)
    for (const [rejection, text] of [
      ['503 Service Unavailable', '503 Service Unavailable'],
      [{ status: 503 }, '{"status":503}'],
    ] as const) {
      const label = `Rejected ${text}`
      const sender: OutboxSender = async () => {
        throw rejection
      }
      expect(await runCommand(ctx, touch, { label }, { idempotencyKey: randomUUID(), sender })).toEqual({ ok: true, data: { label } })
      const rows = await prisma.outbox.findMany({ where: { organizationId: org.id, payload: { path: ['data', 'label'], equals: label } } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sentAt: null, attempts: 1, lastError: text })
    }
  })

  it('reports a committed command as ok when the database fails while the send is being recorded', async () => {
    const org = await newOrg()
    const ctx = await memberCtx(org.id)
    const migrator = new pg.Client({ connectionString: testMigratorUrl() })
    await migrator.connect()
    const name = `test_outbox_fail_${randomUUID().replaceAll('-', '')}`
    try {
      await migrator.query(`SET lock_timeout = '5s'`)
      await migrator.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated database outage'; END $$`)
      // Only this test's organization is affected: other files write to "Outbox" at the same time
      await migrator.query(`CREATE TRIGGER "${name}" BEFORE UPDATE ON "Outbox" FOR EACH ROW WHEN (OLD."organizationId" = '${org.id}'::uuid) EXECUTE FUNCTION "${name}"()`)
      const { sender, delivered } = recorder()
      const key = randomUUID()
      const r = await runCommand(ctx, touch, { label: 'Committed' }, { idempotencyKey: key, sender })
      expect(r).toEqual({ ok: true, data: { label: 'Committed' } })
      expect(delivered.size).toBe(1)
      expect(await prisma.commandLog.count({ where: { organizationId: org.id, idempotencyKey: scopedIdempotencyKey(ctx.actor, key) } })).toBe(1)
      // Not recorded as sent: the sweeper sends it again and Inngest drops the duplicate by its event id (Outbox.id)
      expect(await prisma.outbox.count({ where: { organizationId: org.id, sentAt: null } })).toBe(1)
    } finally {
      await migrator.query(`DROP TRIGGER IF EXISTS "${name}" ON "Outbox"`)
      await migrator.query(`DROP FUNCTION IF EXISTS "${name}"()`)
      await migrator.end()
    }
  })

  it('[NFR-SEC-09] keeps secrets out of Outbox.lastError', () => {
    const text = describeSendError(new Error('POST https://inn.gs/e/x?token=abc123secret failed: password=hunter2'))
    expect(text).not.toContain('abc123secret')
    expect(text).not.toContain('hunter2')
    expect(text).toContain(REDACTED)
  })
})

describe('[FR-PLT-012/AC3] outbox messages are what Inngest functions receive', () => {
  it('uses the Outbox id as the Inngest event id, so a re-send is de-duplicated', async () => {
    const org = await newOrg()
    const ctx = await memberCtx(org.id)
    const messages: OutboxMessage[] = []
    const sender: OutboxSender = async (batch) => {
      messages.push(...batch)
    }
    await runCommand(ctx, touch, { label: 'Ids' }, { idempotencyKey: randomUUID(), sender })
    const rows = await prisma.outbox.findMany({ where: { organizationId: org.id } })
    expect(messages.map((m) => m.id).sort()).toEqual(rows.map((r) => r.id).sort())
    expect(rows.every((r) => r.sentAt !== null && r.nextAttemptAt === null)).toBe(true)
  })
})

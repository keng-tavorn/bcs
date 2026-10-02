import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { defineEvents } from '@/server/events/registry'
import { sweepOutbox, type OutboxMessage, type OutboxSender } from '@/server/events/outbox'
import { OUTBOX_SWEEPER_CRON } from '@/server/jobs/outbox-sweeper'
import { getTimeline } from '@/server/queries/timeline'
import { defineCommand, isRetryableTxError, runCommand, type CommandOutcome } from '@/server/services/_pipeline'
import { createMember, createOrg } from '../support/factory'

// A test-only aggregate and command exercising the real pipeline against Postgres (spec §4.3, ADR-027).
defineEvents('TestProbe', {
  'test_probe.renamed': { schema: z.object({ from: z.string().nullable(), to: z.string() }) },
  'test_probe.blocked': { schema: z.object({ reason: z.string() }) },
  'test_probe.decided': { schema: z.object({ decision: z.string() }), requiresDoaRef: true },
})

const sent: OutboxMessage[] = []
const workingSender: OutboxSender = async (messages) => {
  sent.push(...messages)
}
const downSender: OutboxSender = async () => {
  throw new Error('inngest unavailable')
}

type Mode = 'normal' | 'no-events' | 'reject' | 'unknown-event' | 'missing-doa' | 'notify'

const rename = defineCommand({
  name: 'test.rename',
  capability: 'test.rename',
  input: z.object({ name: z.string().min(1), mode: z.enum(['normal', 'no-events', 'reject', 'unknown-event', 'missing-doa', 'notify']).default('normal') }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ name: string; at: Date }>> {
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } })
    if (input.mode === 'reject') {
      return {
        ok: false,
        error: { code: 'SOD_VIOLATION', message: 'blocked', details: { rule: 'BR-SOD-01' } },
        auditEvents: [{ type: 'test_probe.blocked', aggregateType: 'TestProbe', aggregateId: ctx.organizationId, data: { reason: 'BR-SOD-01' } }],
      }
    }
    await tx.organization.update({ where: { id: ctx.organizationId }, data: { legalNameEn: input.name } })
    const events =
      input.mode === 'no-events'
        ? []
        : input.mode === 'unknown-event'
          ? [{ type: 'test_probe.nonexistent', aggregateType: 'TestProbe', aggregateId: ctx.organizationId, data: {} }]
          : input.mode === 'missing-doa'
            ? [{ type: 'test_probe.decided', aggregateType: 'TestProbe', aggregateId: ctx.organizationId, data: { decision: 'APPROVE' } }]
            : [{ type: 'test_probe.renamed', aggregateType: 'TestProbe', aggregateId: ctx.organizationId, data: { from: org.legalNameEn, to: input.name } }]
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : ''
    return {
      ok: true,
      result: { name: input.name, at: ctx.now },
      events,
      notifications:
        input.mode === 'notify'
          ? [
              { recipientMemberId: actor, templateKey: 'test.renamed', data: { name: input.name }, urgency: 'IMMEDIATE', dedupeKey: `rename:${input.name}` },
              { recipientMemberId: actor, templateKey: 'test.renamed', data: { name: input.name }, urgency: 'DIGEST', dedupeKey: `rename-digest:${input.name}` },
            ]
          : [],
    }
  },
})

let orgId: string
let memberId: string
const NOW = new Date('2026-10-05T03:00:00Z')
const ctxFor = (organizationId: string): Ctx =>
  makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: NOW })

async function eventsOf(organizationId: string, type?: string) {
  return prisma.event.findMany({ where: { organizationId, aggregateId: organizationId, ...(type ? { type } : {}) }, orderBy: { seq: 'asc' } })
}

beforeAll(async () => {
  const org = await createOrg()
  orgId = org.id
  memberId = (await createMember(orgId, 'สมชาย ใจดี')).id
})

describe('[FR-PLT-012/AC1] [INV-PLT-01] idempotency under concurrency', () => {
  it('runs the same command twice at once and produces one result and one event set', async () => {
    const key = randomUUID()
    const [a, b] = await Promise.all([
      runCommand(ctxFor(orgId), rename, { name: 'Acme Concurrent' }, { idempotencyKey: key, sender: workingSender }),
      runCommand(ctxFor(orgId), rename, { name: 'Acme Concurrent' }, { idempotencyKey: key, sender: workingSender }),
    ])
    expect(a).toEqual(b)
    expect(a.ok).toBe(true)
    const renamed = (await eventsOf(orgId, 'test_probe.renamed')).filter((e) => (e.data as { to: string }).to === 'Acme Concurrent')
    expect(renamed).toHaveLength(1)
    expect(await prisma.commandLog.count({ where: { organizationId: orgId, idempotencyKey: key } })).toBe(1)
  })

  it('returns the stored result on a later replay without writing again', async () => {
    const key = randomUUID()
    const first = await runCommand(ctxFor(orgId), rename, { name: 'Replay Co' }, { idempotencyKey: key, sender: workingSender })
    const before = (await eventsOf(orgId)).length
    const again = await runCommand({ ...ctxFor(orgId), now: new Date('2027-01-01T00:00:00Z') }, rename, { name: 'Replay Co' }, { idempotencyKey: key, sender: workingSender })
    expect(again).toEqual(first)
    expect(first.ok && first.data.at).toBe(NOW.toISOString())
    expect((await eventsOf(orgId)).length).toBe(before)
  })
})

describe('[FR-PLT-012/AC2] same key, different input', () => {
  it('is refused with IDEMPOTENCY_CONFLICT and changes nothing', async () => {
    const key = randomUUID()
    await runCommand(ctxFor(orgId), rename, { name: 'Original Name' }, { idempotencyKey: key, sender: workingSender })
    const before = (await eventsOf(orgId)).length
    const second = await runCommand(ctxFor(orgId), rename, { name: 'Different Name' }, { idempotencyKey: key, sender: workingSender })
    expect(second).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } })
    expect((await eventsOf(orgId)).length).toBe(before)
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).legalNameEn).toBe('Original Name')
  })
})

describe('[FR-PLT-003/AC1] [INV-EVT-02] every state change writes an Event in the same transaction', () => {
  it('writes the event, the outbox row and the CommandLog together', async () => {
    const key = randomUUID()
    const r = await runCommand(ctxFor(orgId), rename, { name: 'Evented Co' }, { idempotencyKey: key, sender: workingSender })
    expect(r.ok).toBe(true)
    const event = (await eventsOf(orgId, 'test_probe.renamed')).at(-1)!
    expect(event).toMatchObject({ actorType: 'USER', actorMemberId: memberId, channel: 'WEB', occurredAt: NOW })
    const outbox = await prisma.outbox.findMany({ where: { organizationId: orgId, eventName: 'bcs/test_probe.renamed' } })
    expect(outbox.some((o) => (o.payload as { eventId: string }).eventId === event.id)).toBe(true)
  })

  it('rolls back and reports INTERNAL when a command changes state without an Event', async () => {
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
    const key = randomUUID()
    const r = await runCommand(ctxFor(orgId), rename, { name: 'Silent Change', mode: 'no-events' }, { idempotencyKey: key, sender: workingSender })
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).legalNameEn).toBe(before.legalNameEn)
    expect(await prisma.commandLog.count({ where: { organizationId: orgId, idempotencyKey: key } })).toBe(0)
  })

  it('rejects events without a registered schema and approval events without a DOA reference (INV-DOA-01)', async () => {
    for (const mode of ['unknown-event', 'missing-doa'] as const) {
      const r = await runCommand(ctxFor(orgId), rename, { name: `Bad ${mode}`, mode }, { idempotencyKey: randomUUID(), sender: workingSender })
      expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    }
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).legalNameEn).not.toMatch(/^Bad /)
  })
})

describe('validation and rejected commands', () => {
  it('reports VALIDATION_FAILED with the field and writes nothing', async () => {
    const key = randomUUID()
    const r = await runCommand(ctxFor(orgId), rename, { name: '' }, { idempotencyKey: key, sender: workingSender })
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'name' } } })
    expect(await prisma.commandLog.count({ where: { organizationId: orgId, idempotencyKey: key } })).toBe(0)
  })

  it('rolls back a rejected command but keeps its audit event', async () => {
    const before = (await eventsOf(orgId, 'test_probe.blocked')).length
    const r = await runCommand(ctxFor(orgId), rename, { name: 'Blocked Co', mode: 'reject' }, { idempotencyKey: randomUUID(), sender: workingSender })
    expect(r).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-01' } } })
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).legalNameEn).not.toBe('Blocked Co')
    expect((await eventsOf(orgId, 'test_probe.blocked')).length).toBe(before + 1)
  })
})

describe('[FR-PLT-012/AC3] outbox survives an Inngest outage', () => {
  it('keeps the outbox when sending fails and the sweeper sends it within 2 minutes after recovery', async () => {
    const org = await createOrg()
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'SYSTEM' }, channel: 'SYSTEM', now: NOW })
    const r = await runCommand(ctx, rename, { name: 'Outage Co' }, { idempotencyKey: randomUUID(), sender: downSender })
    expect(r.ok).toBe(true)
    const pending = await prisma.outbox.findMany({ where: { organizationId: org.id } })
    expect(pending.length).toBeGreaterThan(0)
    expect(pending.every((o) => o.sentAt === null && o.attempts === 1 && o.lastError === 'inngest unavailable')).toBe(true)

    // The sweeper re-sends rows older than 30 s and runs every minute → at most ~90 s after recovery.
    expect(OUTBOX_SWEEPER_CRON).toBe('* * * * *')
    const createdAt = Math.max(...pending.map((o) => o.createdAt.getTime()))
    await sweepOutbox(workingSender, new Date(createdAt + 10_000))
    expect((await prisma.outbox.findMany({ where: { organizationId: org.id, sentAt: { not: null } } })).length).toBe(0)
    await sweepOutbox(workingSender, new Date(createdAt + 60_000))
    const after = await prisma.outbox.findMany({ where: { organizationId: org.id } })
    expect(after.every((o) => o.sentAt !== null)).toBe(true)
    expect(sent.some((m) => pending.some((o) => o.id === m.id))).toBe(true)
  })
})

describe('notifications are written in the same transaction (spec §4.7)', () => {
  it('creates one row per dedupeKey and queues only IMMEDIATE ones for delivery', async () => {
    const name = `Notify ${randomUUID().slice(0, 6)}`
    await runCommand(ctxFor(orgId), rename, { name, mode: 'notify' }, { idempotencyKey: randomUUID(), sender: workingSender })
    await runCommand(ctxFor(orgId), rename, { name, mode: 'notify' }, { idempotencyKey: randomUUID(), sender: workingSender })
    const rows = await prisma.notification.findMany({ where: { organizationId: orgId, dedupeKey: { in: [`rename:${name}`, `rename-digest:${name}`] } } })
    expect(rows).toHaveLength(2)
    const immediate = rows.find((r) => r.urgency === 'IMMEDIATE')!
    const queued = await prisma.outbox.findMany({ where: { organizationId: orgId, eventName: 'bcs/notification.requested' } })
    expect(queued.filter((q) => (q.payload as { notificationId: string }).notificationId === immediate.id)).toHaveLength(1)
  })
})

describe('[FR-PLT-003/AC3] timeline from events', () => {
  it('lists who did what, when and through which channel, scoped to the tenant', async () => {
    const org = await createOrg()
    const member = await createMember(org.id, 'วีระ ปฏิบัติการ')
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'LINE_CHAT', now: NOW })
    await runCommand(ctx, rename, { name: 'Timeline Co' }, { idempotencyKey: randomUUID(), sender: workingSender })
    const timeline = await getTimeline(ctx, 'TestProbe', org.id)
    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      type: 'test_probe.renamed',
      channel: 'LINE_CHAT',
      occurredAt: NOW.toISOString(),
      actor: { kind: 'MEMBER', name: 'วีระ ปฏิบัติการ' },
    })
    // Another tenant asking for the same aggregate sees nothing (INV-TEN-01).
    expect(await getTimeline({ ...ctx, organizationId: orgId }, 'TestProbe', org.id)).toEqual([])
  })
})

describe('retry classification (spec §4.3 step 6)', () => {
  it('retries write conflicts, serialization failures and deadlocks only', () => {
    expect(isRetryableTxError({ code: 'P2034' })).toBe(true)
    expect(isRetryableTxError({ cause: { code: '40001' } })).toBe(true)
    expect(isRetryableTxError(new Error('deadlock detected'))).toBe(true)
    expect(isRetryableTxError({ code: 'P2002' })).toBe(false)
    expect(isRetryableTxError(new Error('boom'))).toBe(false)
  })
})

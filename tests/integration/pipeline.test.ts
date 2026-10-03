import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { PrismaPg } from '@prisma/adapter-pg'
import Decimal from 'decimal.js'
import fc from 'fast-check'
import { beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import type { Result } from '@/core/result'
import { COMMAND_TX_MAX_WAIT_MS, DB_POOL_ACQUIRE_TIMEOUT_MS, DB_POOL_MAX } from '@/lib/constants'
import { createLogger, logger } from '@/lib/logger'
import { makeCtx, systemCtx, type Actor, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { PrismaClient } from '@/server/db/generated/client'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { setTransactionTimeouts } from '@/server/db/sql/timeouts'
import { appendEvents } from '@/server/events/append'
import { defineEvents } from '@/server/events/registry'
import type { OutboxMessage, OutboxSender } from '@/server/events/outbox'
import { getTimeline } from '@/server/queries/timeline'
import {
  defineCommand,
  isBusyTxError,
  isRetryableTxError,
  runCommand,
  scopedIdempotencyKey,
  type CommandOutcome,
} from '@/server/services/_pipeline'
import { createMember, createOrg } from '../support/factory'
import { testAppUrl } from '../support/test-db'

// A test-only aggregate and commands exercising the real pipeline against Postgres (spec §4.3, ADR-027).
// The outbox relay (dispatch after commit, outbox-sweeper) is tested in outbox.test.ts.
defineEvents('TestProbe', {
  'test_probe.renamed': { schema: z.object({ from: z.string().nullable(), to: z.string() }) },
  'test_probe.blocked': { schema: z.object({ reason: z.string() }) },
  'test_probe.decided': { schema: z.object({ decision: z.string() }), requiresDoaRef: true },
  'test_probe.noted': { schema: z.object({ subjectId: z.string() }) },
  'test_probe.escalated': { schema: z.object({ subjectId: z.string() }) },
  'test_probe.measured': { schema: z.object({ quantity: z.instanceof(Decimal) }) },
})

const sent: OutboxMessage[] = []
const workingSender: OutboxSender = async (messages) => {
  sent.push(...messages)
}

const MODES = ['normal', 'no-events', 'reject', 'reject-unregistered-audit', 'unknown-event', 'missing-doa', 'notify', 'stall', 'slow-statement'] as const

// 'stall' parks execute() (holding the idempotency lock) until the test opens the gate
let stalled: () => void = () => {}
let gate: Promise<void> = Promise.resolve()

const rename = defineCommand({
  name: 'test.rename',
  capability: 'test.rename',
  input: z.object({ name: z.string().min(1), mode: z.enum(MODES).default('normal') }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ name: string; at: Date }>> {
    if (input.mode === 'stall') {
      stalled()
      await gate
    }
    if (input.mode === 'slow-statement') {
      await setTransactionTimeouts(tx, 2000, 200)
      await tx.$executeRaw`SELECT pg_sleep(1)`
    }
    await lockRowsForUpdate(tx, 'Organization', ctx.organizationId, [ctx.organizationId])
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } })
    if (input.mode === 'reject' || input.mode === 'reject-unregistered-audit') {
      return {
        ok: false,
        error: { code: 'SOD_VIOLATION', message: 'blocked', details: { rule: 'BR-SOD-01' } },
        auditEvents: [
          {
            type: input.mode === 'reject' ? 'test_probe.blocked' : 'test_probe.unregistered',
            aggregateType: 'TestProbe',
            aggregateId: ctx.organizationId,
            data: { reason: 'BR-SOD-01' },
          },
        ],
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

// Any actor may note a subject; only jobs (SYSTEM) may escalate it, and the escalation result is sensitive.
const note = defineCommand({
  name: 'test.note',
  capability: 'test.note',
  input: z.object({ subjectId: z.string() }),
  async execute(_tx, input, ctx): Promise<CommandOutcome<{ noted: string }>> {
    return {
      ok: true,
      result: { noted: input.subjectId },
      events: [{ type: 'test_probe.noted', aggregateType: 'TestProbe', aggregateId: ctx.organizationId, data: { subjectId: input.subjectId } }],
    }
  },
})

let escalations = 0
const escalate = defineCommand({
  name: 'test.escalate',
  capability: 'test.escalate',
  input: z.object({ subjectId: z.string() }),
  async execute(_tx, input, ctx): Promise<CommandOutcome<{ escalated: string; route: string }>> {
    escalations++
    if (ctx.actor.type !== 'SYSTEM') return { ok: false, error: { code: 'FORBIDDEN', message: 'jobs only' } }
    return {
      ok: true,
      result: { escalated: input.subjectId, route: 'CEO via rule PO-3' },
      events: [{ type: 'test_probe.escalated', aggregateType: 'TestProbe', aggregateId: ctx.organizationId, data: { subjectId: input.subjectId } }],
    }
  },
})

// A supplier contact may submit only its own quotation; the stored result names who submitted it.
let quotes = 0
const quote = defineCommand({
  name: 'test.quote',
  capability: 'test.quote',
  input: z.object({ rfqId: z.string(), ownerContactId: z.string() }),
  async execute(_tx, input, ctx): Promise<CommandOutcome<{ submittedBy: string; quotationRef: string }>> {
    quotes++
    if (ctx.actor.type !== 'SUPPLIER' || ctx.actor.supplierContactId !== input.ownerContactId) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'not your quotation' } }
    }
    return {
      ok: true,
      result: { submittedBy: ctx.actor.supplierContactId, quotationRef: `Q-${input.rfqId.slice(0, 4)}` },
      events: [{ type: 'test_probe.noted', aggregateType: 'TestProbe', aggregateId: ctx.organizationId, data: { subjectId: input.rfqId } }],
    }
  },
})

const NAMESPACE_TYPES = { u: 'USER', sys: 'SYSTEM', pa: 'PLATFORM_ADMIN', ai: 'AI_AGENT', sup: 'SUPPLIER' } as const

/** Reads a stored key back as (actor type, identity, key); null when it is not in the documented format. */
function decodeScopedKey(stored: string): { type: Actor['type']; identity: string; key: string } | null {
  const head = /^(u|sys|pa|ai|sup):(0|[1-9]\d*):/.exec(stored)
  if (!head) return null
  const start = head[0].length
  const end = start + Number(head[2])
  if (stored.length <= end || stored[end] !== ':') return null
  return { type: NAMESPACE_TYPES[head[1] as keyof typeof NAMESPACE_TYPES], identity: stored.slice(start, end), key: stored.slice(end + 1) }
}

function identityOf(actor: Actor): string {
  switch (actor.type) {
    case 'USER':
      return actor.memberId
    case 'SYSTEM':
      return actor.job ?? ''
    case 'PLATFORM_ADMIN':
      return actor.platformAdminId
    case 'AI_AGENT':
      return actor.agentId
    case 'SUPPLIER':
      return actor.supplierContactId
  }
}

const price = defineCommand({
  name: 'test.price',
  capability: 'test.price',
  input: z.object({ quantity: z.string().transform((v) => new Decimal(v)) }),
  async execute(_tx, input, ctx): Promise<CommandOutcome<{ quantity: Decimal; netSatang: bigint; at: Date }>> {
    return {
      ok: true,
      result: { quantity: input.quantity, netSatang: 10700n, at: ctx.now },
      events: [{ type: 'test_probe.measured', aggregateType: 'TestProbe', aggregateId: ctx.organizationId, data: { quantity: input.quantity } }],
    }
  },
})

let orgId: string
let memberId: string
const NOW = new Date('2026-10-05T03:00:00Z')
const ctxFor = (organizationId: string, member = memberId): Ctx =>
  makeCtx({ organizationId, actor: { type: 'USER', memberId: member }, channel: 'WEB', now: NOW })

async function eventsOf(organizationId: string, type?: string) {
  return prisma.event.findMany({ where: { organizationId, aggregateId: organizationId, ...(type ? { type } : {}) }, orderBy: { seq: 'asc' } })
}

function commandLogs(ctx: Ctx, idempotencyKey: string) {
  return prisma.commandLog.findMany({ where: { organizationId: ctx.organizationId, idempotencyKey: scopedIdempotencyKey(ctx.actor, idempotencyKey) } })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
    expect(await commandLogs(ctxFor(orgId), key)).toHaveLength(1)
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

describe('[FR-PLT-012/AC1] [INV-PLT-01] an idempotency key belongs to the actor that sent it', () => {
  it('a member cannot claim a predictable job key in advance: the job still runs', async () => {
    const subjectId = randomUUID()
    const jobKey = `approval-task-sla:escalate:${subjectId}`
    const claimed = await runCommand(ctxFor(orgId), note, { subjectId }, { idempotencyKey: jobKey, sender: null })
    expect(claimed.ok).toBe(true)
    const before = escalations
    const job = await runCommand(systemCtx(orgId, NOW, 'approval-task-sla'), escalate, { subjectId }, { idempotencyKey: jobKey, sender: null })
    expect(job).toEqual({ ok: true, data: { escalated: subjectId, route: 'CEO via rule PO-3' } })
    expect(escalations - before).toBe(1)
  })

  it('never replays a stored result to another actor: execute() and its authorization run for them', async () => {
    const subjectId = randomUUID()
    const key = `approval-task-sla:escalate:${subjectId}`
    const job = await runCommand(systemCtx(orgId, NOW, 'approval-task-sla'), escalate, { subjectId }, { idempotencyKey: key, sender: null })
    expect(job.ok).toBe(true)
    const before = escalations
    const member = await runCommand(ctxFor(orgId), escalate, { subjectId }, { idempotencyKey: key, sender: null })
    expect(member).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'jobs only' } })
    expect(escalations - before).toBe(1)
    expect(JSON.stringify(member)).not.toContain('CEO')
  })

  it('stores the key inside the namespace of the actor type and identity', async () => {
    const key = randomUUID()
    const other = await createMember(orgId, 'สมศรี มีสุข')
    const job = systemCtx(orgId, NOW, 'approval-task-sla')
    const results = await Promise.all([
      runCommand(ctxFor(orgId), note, { subjectId: key }, { idempotencyKey: key, sender: null }),
      runCommand(ctxFor(orgId, other.id), note, { subjectId: key }, { idempotencyKey: key, sender: null }),
      runCommand(job, note, { subjectId: key }, { idempotencyKey: key, sender: null }),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    const keys = (await prisma.commandLog.findMany({ where: { organizationId: orgId, idempotencyKey: { endsWith: key } } })).map((l) => l.idempotencyKey).sort()
    // <namespace>:<length of the identity>:<identity>:<key>
    expect(keys).toEqual([`sys:17:approval-task-sla:${key}`, `u:36:${memberId}:${key}`, `u:36:${other.id}:${key}`].sort())
    expect(scopedIdempotencyKey({ type: 'SYSTEM' }, 'k')).toBe('sys:0::k')
    expect(scopedIdempotencyKey({ type: 'PLATFORM_ADMIN', platformAdminId: 'p1' }, 'k')).toBe('pa:2:p1:k')
    expect(scopedIdempotencyKey({ type: 'AI_AGENT', agentId: 'a1' }, 'k')).toBe('ai:2:a1:k')
    expect(scopedIdempotencyKey({ type: 'SUPPLIER', supplierContactId: 's1' }, 'k')).toBe('sup:2:s1:k')
  })

  it("a supplier contact never receives another contact's stored result: execute() and its authorization run for them", async () => {
    const [contactA, contactB] = [randomUUID(), randomUUID()]
    const ctxOf = (supplierContactId: string) => makeCtx({ organizationId: orgId, actor: { type: 'SUPPLIER', supplierContactId }, channel: 'PORTAL', now: NOW })
    const key = `portal:${randomUUID()}`
    const input = { rfqId: randomUUID(), ownerContactId: contactA }
    const first = await runCommand(ctxOf(contactA), quote, input, { idempotencyKey: key, sender: null })
    expect(first).toEqual({ ok: true, data: { submittedBy: contactA, quotationRef: `Q-${input.rfqId.slice(0, 4)}` } })
    const before = quotes
    const other = await runCommand(ctxOf(contactB), quote, input, { idempotencyKey: key, sender: null })
    expect(other).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'not your quotation' } })
    expect(quotes - before).toBe(1)
    // The first contact's resend still replays its own result without running again
    expect(await runCommand(ctxOf(contactA), quote, input, { idempotencyKey: key, sender: null })).toEqual(first)
    expect(quotes - before).toBe(1)
  })

  it('stores keys injectively: a ":" in an identity or a key never lands in another actor\'s namespace', () => {
    // The collisions of the plain "<namespace>:<identity>:<key>" form
    expect(scopedIdempotencyKey({ type: 'AI_AGENT', agentId: 'agent:x' }, 'k')).not.toBe(scopedIdempotencyKey({ type: 'AI_AGENT', agentId: 'agent' }, 'x:k'))
    expect(scopedIdempotencyKey({ type: 'SYSTEM', job: 'a:b' }, 'c')).not.toBe(scopedIdempotencyKey({ type: 'SYSTEM', job: 'a' }, 'b:c'))
    expect(scopedIdempotencyKey({ type: 'SUPPLIER', supplierContactId: 's1' }, 'k')).not.toBe(scopedIdempotencyKey({ type: 'SUPPLIER', supplierContactId: 's2' }, 'k'))
    const text = fc.string({ unit: fc.constantFrom(':', '0', '1', '2', 'a', 'b', 'ก'), maxLength: 6 })
    const actor = fc.oneof(
      text.map((memberId): Actor => ({ type: 'USER', memberId })),
      fc.option(text, { nil: undefined }).map((job): Actor => (job === undefined ? { type: 'SYSTEM' } : { type: 'SYSTEM', job })),
      text.map((platformAdminId): Actor => ({ type: 'PLATFORM_ADMIN', platformAdminId })),
      text.map((agentId): Actor => ({ type: 'AI_AGENT', agentId })),
      text.map((supplierContactId): Actor => ({ type: 'SUPPLIER', supplierContactId })),
    )
    // Every stored key reads back as exactly the actor and key that produced it, so no two senders share one
    fc.assert(
      fc.property(actor, text, (a, key) => {
        expect(decodeScopedKey(scopedIdempotencyKey(a, key))).toEqual({ type: a.type, identity: identityOf(a), key })
      }),
    )
    // Moving text between the identity and the key always changes the stored key
    fc.assert(
      fc.property(text, text, text, (x, y, z) => {
        for (const make of [(id: string): Actor => ({ type: 'AI_AGENT', agentId: id }), (id: string): Actor => ({ type: 'SYSTEM', job: id })]) {
          expect(scopedIdempotencyKey(make(`${x}:${y}`), z)).not.toBe(scopedIdempotencyKey(make(x), `${y}:${z}`))
        }
      }),
    )
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
    expect(await commandLogs(ctxFor(orgId), key)).toHaveLength(1)
  })

  it('rolls back and reports INTERNAL when a command changes state without an Event', async () => {
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
    const key = randomUUID()
    const r = await runCommand(ctxFor(orgId), rename, { name: 'Silent Change', mode: 'no-events' }, { idempotencyKey: key, sender: workingSender })
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).legalNameEn).toBe(before.legalNameEn)
    expect(await commandLogs(ctxFor(orgId), key)).toHaveLength(0)
  })

  it('rejects events without a registered schema and approval events without a DOA reference (INV-DOA-01)', async () => {
    for (const mode of ['unknown-event', 'missing-doa'] as const) {
      const r = await runCommand(ctxFor(orgId), rename, { name: `Bad ${mode}`, mode }, { idempotencyKey: randomUUID(), sender: workingSender })
      expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    }
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).legalNameEn).not.toMatch(/^Bad /)
  })

  it('stores and returns Decimal quantities as decimal strings, never as decimal.js internals (spec §6.1)', async () => {
    const org = await createOrg()
    const ctx = ctxFor(org.id, (await createMember(org.id)).id)
    const key = randomUUID()
    const r = await runCommand(ctx, price, { quantity: '12.50' }, { idempotencyKey: key, sender: null })
    expect(r).toEqual({ ok: true, data: { quantity: '12.5', netSatang: '10700', at: NOW.toISOString() } })
    const event = await prisma.event.findFirstOrThrow({ where: { organizationId: org.id, type: 'test_probe.measured' } })
    expect(event.data).toEqual({ quantity: '12.5' })
    const outbox = await prisma.outbox.findFirstOrThrow({ where: { organizationId: org.id, eventName: 'bcs/test_probe.measured' } })
    expect((outbox.payload as { data: unknown }).data).toEqual({ quantity: '12.5' })
    expect((await commandLogs(ctx, key))[0]!.result).toEqual({ ok: true, data: { quantity: '12.5', netSatang: '10700', at: NOW.toISOString() } })
    expect(await runCommand(ctx, price, { quantity: '12.5' }, { idempotencyKey: key, sender: null })).toEqual(r)
  })
})

describe('[FR-PLT-012/AC1] the declared result type is what callers receive (spec §14.1)', () => {
  it('types bigint, Date and Decimal fields as the strings they arrive as, on the first run and on a replay', async () => {
    const key = randomUUID()
    const first = await runCommand(ctxFor(orgId), price, { quantity: '3.25' }, { idempotencyKey: key, sender: null })
    const replay = await runCommand(ctxFor(orgId), price, { quantity: '3.25' }, { idempotencyKey: key, sender: null })
    expectTypeOf(first).toEqualTypeOf<Result<{ quantity: string; netSatang: string; at: string }>>()
    const renamed = await runCommand(ctxFor(orgId), rename, { name: 'Typed Co' }, { idempotencyKey: randomUUID(), sender: null })
    expectTypeOf(renamed).toEqualTypeOf<Result<{ name: string; at: string }>>()
    expect(renamed.ok && typeof renamed.data.at).toBe('string')
    for (const r of [first, replay]) {
      if (!r.ok) throw new Error(r.error.message)
      expect([typeof r.data.quantity, typeof r.data.netSatang, typeof r.data.at]).toEqual(['string', 'string', 'string'])
      expect(BigInt(r.data.netSatang) + 700n).toBe(11400n)
    }
  })
})

describe('validation and rejected commands', () => {
  it('[FR-PLT-012/AC1] reports VALIDATION_FAILED with the field and writes nothing', async () => {
    const key = randomUUID()
    const r = await runCommand(ctxFor(orgId), rename, { name: '' }, { idempotencyKey: key, sender: workingSender })
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'name' } } })
    expect(await commandLogs(ctxFor(orgId), key)).toHaveLength(0)
  })

  it('[FR-PLT-012/AC1] reports VALIDATION_FAILED, never throws, when an input transform throws or a refinement is async', async () => {
    let executed = 0
    const reserve = defineCommand({
      name: 'test.reserve',
      capability: 'test.reserve',
      input: z.object({ amount: z.string().transform(amountToSatang), code: z.string().refine(async (v) => v !== 'taken', 'taken') }),
      async execute(): Promise<CommandOutcome<never>> {
        executed++
        throw new Error('execute() must not run for invalid input')
      },
    })
    const bad = await runCommand(ctxFor(orgId), reserve, { amount: '12.345', code: 'free' }, { idempotencyKey: randomUUID(), sender: null })
    expect(bad).toEqual({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'invalid input', details: { field: '(input)' } } })
    const taken = await runCommand(ctxFor(orgId), reserve, { amount: '12.34', code: 'taken' }, { idempotencyKey: randomUUID(), sender: null })
    expect(taken).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'code' } } })
    expect(executed).toBe(0)
  })

  it('[FR-PLT-003/AC1] rolls back a rejected command but keeps its audit event', async () => {
    const before = (await eventsOf(orgId, 'test_probe.blocked')).length
    const r = await runCommand(ctxFor(orgId), rename, { name: 'Blocked Co', mode: 'reject' }, { idempotencyKey: randomUUID(), sender: workingSender })
    expect(r).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-01' } } })
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).legalNameEn).not.toBe('Blocked Co')
    expect((await eventsOf(orgId, 'test_probe.blocked')).length).toBe(before + 1)
  })

  it('[INV-PLT-01] records a rejection that wrote audit events: resends with the same key replay it without auditing again', async () => {
    const org = await createOrg()
    const ctx = ctxFor(org.id, (await createMember(org.id)).id)
    const key = randomUUID()
    const delivered: OutboxMessage[] = []
    const sender: OutboxSender = async (messages) => {
      delivered.push(...messages)
    }
    const input = { name: 'Blocked Twice', mode: 'reject' as const }
    const results = await Promise.all([
      runCommand(ctx, rename, input, { idempotencyKey: key, sender }),
      runCommand(ctx, rename, input, { idempotencyKey: key, sender }),
    ])
    results.push(await runCommand(ctx, rename, input, { idempotencyKey: key, sender }))
    const rejection = { ok: false, error: { code: 'SOD_VIOLATION', message: 'blocked', details: { rule: 'BR-SOD-01' } } }
    expect(results).toEqual([rejection, rejection, rejection])
    expect(await eventsOf(org.id, 'test_probe.blocked')).toHaveLength(1)
    expect(await prisma.outbox.count({ where: { organizationId: org.id, eventName: 'bcs/test_probe.blocked' } })).toBe(1)
    expect(delivered.filter((m) => m.name === 'bcs/test_probe.blocked')).toHaveLength(1)
    expect((await commandLogs(ctx, key)).map((l) => l.result)).toEqual([rejection])
  })

  it('[FR-PLT-003/AC1] sends audit events of a rejection with the same payload shape as any other event', async () => {
    const org = await createOrg()
    const ctx = ctxFor(org.id, (await createMember(org.id)).id)
    await runCommand(ctx, rename, { name: 'Shape Co' }, { idempotencyKey: randomUUID(), sender: null })
    await runCommand(ctx, rename, { name: 'Shape Co', mode: 'reject' }, { idempotencyKey: randomUUID(), sender: null })
    const rows = await prisma.outbox.findMany({ where: { organizationId: org.id, eventName: { in: ['bcs/test_probe.renamed', 'bcs/test_probe.blocked'] } } })
    expect(rows).toHaveLength(2)
    const [success, audit] = ['bcs/test_probe.renamed', 'bcs/test_probe.blocked'].map((name) => rows.find((r) => r.eventName === name)!.payload as Record<string, unknown>)
    expect(Object.keys(audit!).sort()).toEqual(Object.keys(success!).sort())
    expect(audit).toMatchObject({ aggregateType: 'TestProbe', aggregateId: org.id, correlationId: ctx.correlationId, occurredAt: NOW.toISOString() })
  })

  it('[INV-PLT-01] does not record a plain rejection: the same key runs again once the command is allowed', async () => {
    const org = await createOrg()
    const ctx = ctxFor(org.id, (await createMember(org.id)).id)
    const gated = defineCommand({
      name: 'test.gated',
      capability: 'test.gated',
      input: z.object({}),
      async execute(tx, _input, c): Promise<CommandOutcome<{ opened: true }>> {
        const current = await tx.organization.findUniqueOrThrow({ where: { id: c.organizationId } })
        if (current.legalNameEn !== 'open') return { ok: false, error: { code: 'FORBIDDEN', message: 'not yet' } }
        return { ok: true, result: { opened: true }, events: [{ type: 'test_probe.noted', aggregateType: 'TestProbe', aggregateId: c.organizationId, data: { subjectId: 'gate' } }] }
      },
    })
    const key = randomUUID()
    expect(await runCommand(ctx, gated, {}, { idempotencyKey: key, sender: null })).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'not yet' } })
    expect(await commandLogs(ctx, key)).toHaveLength(0)
    await prisma.organization.update({ where: { id: org.id }, data: { legalNameEn: 'open' } })
    expect(await runCommand(ctx, gated, {}, { idempotencyKey: key, sender: null })).toEqual({ ok: true, data: { opened: true } })
  })

  it('[FR-PLT-003/AC1] reports INTERNAL, never the rejection, when its audit events cannot be written, and writes nothing', async () => {
    const org = await createOrg()
    const ctx = ctxFor(org.id, (await createMember(org.id)).id)
    const key = randomUUID()
    const r = await runCommand(ctx, rename, { name: 'Lost Audit', mode: 'reject-unregistered-audit' }, { idempotencyKey: key, sender: null })
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(await prisma.event.count({ where: { organizationId: org.id } })).toBe(0)
    expect(await prisma.outbox.count({ where: { organizationId: org.id } })).toBe(0)
    expect(await commandLogs(ctx, key)).toHaveLength(0)
  })

  it('[FR-PLT-003/AC1] keeps the audit event when execute() recovered from a failed statement before rejecting', async () => {
    const org = await createOrg()
    const existing = await createMember(org.id)
    const ctx = ctxFor(org.id, existing.id)
    const addMember = defineCommand({
      name: 'test.add_member',
      capability: 'test.add_member',
      input: z.object({ email: z.string() }),
      async execute(tx, input, c): Promise<CommandOutcome<never>> {
        try {
          await tx.member.create({ data: { organizationId: c.organizationId, displayNameTh: 'ซ้ำ', email: input.email, status: 'ACTIVE' } })
        } catch {
          return {
            ok: false,
            error: { code: 'VALIDATION_FAILED', message: 'email already used', details: { field: 'email' } },
            auditEvents: [{ type: 'test_probe.blocked', aggregateType: 'TestProbe', aggregateId: c.organizationId, data: { reason: 'duplicate' } }],
          }
        }
        throw new Error('expected a duplicate e-mail')
      },
    })
    const r = await runCommand(ctx, addMember, { email: existing.email }, { idempotencyKey: randomUUID(), sender: null })
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'email' } } })
    expect(await eventsOf(org.id, 'test_probe.blocked')).toHaveLength(1)
  })

  it('[INV-PLT-01] [FR-PLT-003/AC1] rolls back every row and Event execute() wrote before rejecting, with and without audit events', async () => {
    // execute() writes to several tables and appends an Event itself, then rejects (savepoint, spec §4.3 step 4)
    const scribble = defineCommand({
      name: 'test.scribble_then_reject',
      capability: 'test.scribble',
      input: z.object({ label: z.string(), audit: z.boolean() }),
      async execute(tx, input, c): Promise<CommandOutcome<never>> {
        const author = c.actor.type === 'USER' ? c.actor.memberId : ''
        await tx.organization.update({ where: { id: c.organizationId }, data: { legalNameEn: input.label } })
        await tx.comment.create({ data: { organizationId: c.organizationId, subjectType: 'Member', subjectId: author, authorMemberId: author, body: input.label } })
        await tx.notification.create({
          data: { organizationId: c.organizationId, recipientMemberId: author, templateKey: 'test.scribbled', data: {}, urgency: 'IMMEDIATE', dedupeKey: `scribble:${input.label}` },
        })
        await tx.outbox.create({ data: { organizationId: c.organizationId, eventName: 'bcs/test_probe.scribbled', payload: {} } })
        await appendEvents(tx, c, [{ type: 'test_probe.noted', aggregateType: 'TestProbe', aggregateId: c.organizationId, data: { subjectId: input.label } }])
        return {
          ok: false,
          error: { code: 'FORBIDDEN', message: 'changed its mind' },
          ...(input.audit ? { auditEvents: [{ type: 'test_probe.blocked', aggregateType: 'TestProbe', aggregateId: c.organizationId, data: { reason: 'BR-SOD-01' } }] } : {}),
        }
      },
    })
    for (const audit of [false, true]) {
      const org = await createOrg()
      const ctx = ctxFor(org.id, (await createMember(org.id)).id)
      const key = randomUUID()
      const r = await runCommand(ctx, scribble, { label: `Scribbled ${audit}`, audit }, { idempotencyKey: key, sender: null })
      expect(r).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'changed its mind' } })
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).legalNameEn).toBeNull()
      expect(await prisma.comment.count({ where: { organizationId: org.id } })).toBe(0)
      expect(await prisma.notification.count({ where: { organizationId: org.id } })).toBe(0)
      const events = await prisma.event.findMany({ where: { organizationId: org.id } })
      const outbox = await prisma.outbox.findMany({ where: { organizationId: org.id } })
      if (audit) {
        // Only the audit event survives, with its outbox row, and the rejection is recorded for replays
        expect(events.map((e) => e.type)).toEqual(['test_probe.blocked'])
        expect(outbox.map((o) => o.eventName)).toEqual(['bcs/test_probe.blocked'])
        expect(await commandLogs(ctx, key)).toHaveLength(1)
      } else {
        expect(events).toEqual([])
        expect(outbox).toEqual([])
        expect(await commandLogs(ctx, key)).toHaveLength(0)
      }
    }
  })
})

/** The JSON lines runCommand logs, written by a logger built like the app's (same serializers and redaction). */
function captureCommandLog() {
  const lines: string[] = []
  const sink = createLogger(
    new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk))
        done()
      },
    }),
    'trace',
  )
  const spy = vi.spyOn(logger, 'child').mockImplementation(((bindings, options) => sink.child(bindings, options)) as typeof logger.child)
  return { lines, restore: () => spy.mockRestore() }
}

describe('[FR-PLT-008/AC3] an unexpected error returns only a reference id (spec §14.2)', () => {
  const PLANTED = { email: 'somchai@example.com', name: 'สมชาย ใจดี', phone: '0812345678', value: 'not-a-uuid' }

  it('logs a description with organizationId and the error codes, never the error text or the query arguments', async () => {
    // A driver error quotes the offending input; a Prisma validation error echoes every argument of the call
    const leaky = defineCommand({
      name: 'test.leaky_query',
      capability: 'test.leaky',
      input: z.object({ memberId: z.string() }),
      async execute(tx, input): Promise<CommandOutcome<never>> {
        await tx.member.findMany({ where: { id: input.memberId } })
        throw new Error('unreachable: the query above fails')
      },
    })
    const invalid = defineCommand({
      name: 'test.leaky_create',
      capability: 'test.leaky',
      input: z.object({ email: z.string(), name: z.string(), phone: z.string() }),
      async execute(tx, input, c): Promise<CommandOutcome<never>> {
        await tx.member.create({ data: { organizationId: c.organizationId, displayNameTh: input.name, email: input.email, phone: input.phone, status: 'NOPE' as never } })
        throw new Error('unreachable: the create above fails')
      },
    })
    const cases = [
      {
        run: (ctx: Ctx) => runCommand(ctx, leaky, { memberId: `${PLANTED.value} ${PLANTED.phone} ${PLANTED.email} ${PLANTED.name}` }, { idempotencyKey: randomUUID(), sender: null }),
        command: leaky.name,
        error: { type: 'PrismaClientKnownRequestError', code: 'P2007', sqlState: '22P02', model: 'Member' },
      },
      {
        run: (ctx: Ctx) => runCommand(ctx, invalid, { email: PLANTED.email, name: PLANTED.name, phone: PLANTED.phone }, { idempotencyKey: randomUUID(), sender: null }),
        command: invalid.name,
        error: { type: 'PrismaClientValidationError' },
      },
    ]
    for (const c of cases) {
      const ctx = ctxFor(orgId)
      const capture = captureCommandLog()
      try {
        expect(await c.run(ctx)).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'unexpected error', details: { requestId: ctx.requestId } } })
      } finally {
        capture.restore()
      }
      const line = capture.lines.find((l) => l.includes('command failed unexpectedly'))
      expect(line).toBeDefined()
      for (const planted of Object.values(PLANTED)) expect(line).not.toContain(planted)
      const entry = JSON.parse(line!) as { error: { frames?: string[] } }
      expect(entry).toMatchObject({ level: 50, organizationId: orgId, requestId: ctx.requestId, correlationId: ctx.correlationId, command: c.command, error: c.error })
      // Where it happened stays in the line for the team: the stack frames, without the message lines
      expect(entry.error.frames?.some((frame) => frame.includes('_pipeline.ts'))).toBe(true)
    }
  })

  it('keeps exception text, query arguments and file paths out of the Result', async () => {
    const leaky = defineCommand({
      name: 'test.leaky',
      capability: 'test.leaky',
      input: z.object({ memberId: z.string() }),
      async execute(tx, input): Promise<CommandOutcome<never>> {
        await tx.member.findMany({ where: { id: input.memberId } })
        throw new Error('unreachable: the query above fails')
      },
    })
    const ctx = ctxFor(orgId)
    const r = await runCommand(ctx, leaky, { memberId: 'not-a-uuid 0812345678 somchai@example.com' }, { idempotencyKey: randomUUID(), sender: null })
    expect(r).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'unexpected error', details: { requestId: ctx.requestId } } })
  })
})

describe('[FR-PLT-012/AC1] lock and statement waits are bounded (spec §4.3 step 6)', () => {
  it('a duplicate of a stuck delivery gives up with RATE_LIMITED within seconds, and other organizations keep working', async () => {
    const orgA = await createOrg()
    const orgB = await createOrg()
    const ctxA = ctxFor(orgA.id, (await createMember(orgA.id)).id)
    const ctxB = ctxFor(orgB.id, (await createMember(orgB.id)).id)
    const key = randomUUID()
    let open!: () => void
    gate = new Promise<void>((resolve) => (open = resolve))
    const isStalled = new Promise<void>((resolve) => (stalled = resolve))
    const input = { name: 'Stuck Co', mode: 'stall' as const }
    const first = runCommand(ctxA, rename, input, { idempotencyKey: key, sender: null })
    try {
      await isStalled
      const started = performance.now()
      // More waiting duplicates than the pool has connections (DB_POOL_MAX)
      const duplicates = Array.from({ length: 10 }, () => runCommand(ctxA, rename, input, { idempotencyKey: key, sender: null }))
      await sleep(300)
      const b = await runCommand(ctxB, rename, { name: 'Unrelated Co' }, { idempotencyKey: randomUUID(), sender: null })
      expect(b.ok).toBe(true)
      expect(performance.now() - started).toBeLessThan(9000)
      const settled = await Promise.race([Promise.all(duplicates), sleep(15_000).then(() => 'still waiting' as const)])
      expect(settled).not.toBe('still waiting')
      if (settled !== 'still waiting') {
        for (const r of settled) expect(r).toEqual({ ok: false, error: { code: 'RATE_LIMITED', message: expect.any(String), details: { requestId: ctxA.requestId } } })
      }
    } finally {
      open()
    }
    const done = await first
    expect(done).toEqual({ ok: true, data: { name: 'Stuck Co', at: NOW.toISOString() } })
    // Once the first delivery committed, a resend replays it
    expect(await runCommand(ctxA, rename, input, { idempotencyKey: key, sender: null })).toEqual(done)
    expect(await commandLogs(ctxA, key)).toHaveLength(1)
  })

  it('a statement cancelled by statement_timeout is reported as RATE_LIMITED, not INTERNAL', async () => {
    const org = await createOrg()
    const ctx = ctxFor(org.id, (await createMember(org.id)).id)
    const key = randomUUID()
    const r = await runCommand(ctx, rename, { name: 'Slow Co', mode: 'slow-statement' }, { idempotencyKey: key, sender: null })
    expect(r).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { requestId: ctx.requestId } } })
    expect(await commandLogs(ctx, key)).toHaveLength(0)
  })

  it('treats "no free pooled connection" as busy, as both pg and Prisma report it', async () => {
    // A pool of one connection held by a transaction: the next transaction cannot start. Either the pool's
    // acquire timeout fires first (pg) or the transaction's maxWait does (Prisma P2028); both mean "busy".
    const errors: unknown[] = []
    for (const { poolTimeoutMs, maxWaitMs } of [
      { poolTimeoutMs: 200, maxWaitMs: 5000 },
      { poolTimeoutMs: 5000, maxWaitMs: 200 },
    ]) {
      const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: testAppUrl(), max: 1, connectionTimeoutMillis: poolTimeoutMs }) })
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      let holding!: () => void
      const isHolding = new Promise<void>((resolve) => (holding = resolve))
      const holder = client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`
          holding()
          await held
        },
        { maxWait: 5000, timeout: 20_000 },
      )
      try {
        await isHolding
        await client.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: maxWaitMs, timeout: 5000 }).then(
          () => errors.push('started'),
          (error: unknown) => errors.push(error),
        )
      } finally {
        release()
        await holder
        await client.$disconnect()
      }
    }
    expect(errors.map((e) => isBusyTxError(e))).toEqual([true, true])
    expect(isBusyTxError(new Error('Transaction already closed: the transaction expired'))).toBe(false)
  })

  it('a command that cannot get a pooled connection is retried once, then answered RATE_LIMITED, not INTERNAL', async () => {
    const org = await createOrg()
    const ctx = ctxFor(org.id, (await createMember(org.id)).id)
    const key = randomUUID()
    // Every connection of this process's pool is held by a transaction that waits for the gate
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let holding = 0
    const allHeld = new Promise<void>((resolve) => {
      const holders = Array.from({ length: DB_POOL_MAX }, () =>
        prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1`
            if (++holding === DB_POOL_MAX) resolve()
            await held
          },
          { maxWait: 30_000, timeout: 60_000 },
        ),
      )
      void Promise.all(holders).catch(() => {})
    })
    let started = 0
    const r = await (async () => {
      try {
        await allHeld
        started = performance.now()
        return await runCommand(ctx, note, { subjectId: key }, { idempotencyKey: key, sender: null })
      } finally {
        release()
      }
    })()
    const elapsed = performance.now() - started
    expect(r).toEqual({ ok: false, error: { code: 'RATE_LIMITED', message: expect.any(String), details: { requestId: ctx.requestId } } })
    // Two waits for a connection: the first try and the one retry
    expect(elapsed).toBeGreaterThan(2 * Math.min(COMMAND_TX_MAX_WAIT_MS, DB_POOL_ACQUIRE_TIMEOUT_MS) - 1000)
    // Once connections are free again the same key runs normally
    expect(await runCommand(ctx, note, { subjectId: key }, { idempotencyKey: key, sender: null })).toEqual({ ok: true, data: { noted: key } })
  }, 45_000)
})

describe('notifications are written in the same transaction (spec §4.7)', () => {
  it('[FR-NOTI-001/AC2] creates one row per dedupeKey and queues only IMMEDIATE ones for delivery', async () => {
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

describe('[FR-PLT-012/AC1] retry classification (spec §4.3 step 6)', () => {
  it('retries write conflicts, serialization failures and deadlocks only', () => {
    expect(isRetryableTxError({ code: 'P2034' })).toBe(true)
    expect(isRetryableTxError({ cause: { code: '40001' } })).toBe(true)
    expect(isRetryableTxError(new Error('deadlock detected'))).toBe(true)
    expect(isRetryableTxError({ code: 'P2002' })).toBe(false)
    expect(isRetryableTxError(new Error('boom'))).toBe(false)
  })

  it('treats lock_timeout and statement_timeout cancellations, as Prisma wraps them, as busy', () => {
    const wrapped = (code: string) => ({ code: 'P2010', meta: { driverAdapterError: { cause: { code, originalCode: code } } } })
    expect(isBusyTxError(wrapped('55P03'))).toBe(true)
    expect(isBusyTxError(wrapped('57014'))).toBe(true)
    expect(isBusyTxError(new Error('canceling statement due to lock timeout'))).toBe(true)
    expect(isBusyTxError(wrapped('23505'))).toBe(false)
    expect(isBusyTxError(new Error('boom'))).toBe(false)
  })
})

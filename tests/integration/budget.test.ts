import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fund, reserve } from '@/core/budget'
import { prisma } from '@/server/db/client'
import { defineCommand, runCommand } from '@/server/services/_pipeline'
import { applyBudget } from '@/server/budget/ledger'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S3-03 (spec §7.7, FR-BUD-002 AC3): budget operations on real Postgres. The balance row is locked FOR UPDATE, so
// reservations at the same moment never spend more than the line has (INV-BUD-05, GC-BUD-07); every ledger row names
// the event of its operation (INV-BUD-04); the balance is the sum of the ledger (BR-BUD-01).

const NOW = new Date('2026-10-05T03:00:00Z')

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
})

/** A budget line of CON with an empty balance, as the import creates it (S3-04) */
async function budgetLine(): Promise<string> {
  const organizationId = org.organizationId
  const fiscalYear = await prisma.fiscalYear.upsert({
    where: { organizationId_code: { organizationId, code: 'FY2569' } },
    create: { organizationId, code: 'FY2569', startsOn: new Date('2026-01-01T00:00:00Z'), endsOn: new Date('2026-12-31T00:00:00Z') },
    update: {},
  })
  const costCenter = await prisma.costCenter.upsert({
    where: { organizationId_code: { organizationId, code: 'CC-CON' } },
    create: { organizationId, code: 'CC-CON', nameTh: 'ศูนย์ต้นทุนก่อสร้าง', departmentId: org.department.CON! },
    update: {},
  })
  const line = await prisma.budgetLine.create({
    data: { organizationId, fiscalYearId: fiscalYear.id, departmentId: org.department.CON!, costCenterId: costCenter.id, code: `CON-${randomUUID().slice(0, 8)}`, nameTh: 'ค่าใช้จ่ายดำเนินงาน', plannedSatang: 0n },
  })
  await prisma.budgetLineBalance.create({ data: { organizationId, budgetLineId: line.id } })
  return line.id
}

// Commands that run one engine operation through the ledger service, as the import and the request submit do
const fundCommand = defineCommand({
  name: 'test.budget_fund',
  capability: 'budget.import',
  input: z.strictObject({ budgetLineId: z.uuid(), amountSatang: z.string() }),
  async execute(tx, input, ctx) {
    const importId = randomUUID()
    const r = await applyBudget(tx, ctx, [{ budgetLineId: input.budgetLineId, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, BigInt(input.amountSatang), importId) }])
    return r.ok ? { ok: true, result: null, events: r.events } : { ok: false, error: r.error }
  },
})
const reserveCommand = defineCommand({
  name: 'test.budget_reserve',
  capability: 'request.submit',
  input: z.strictObject({ budgetLineId: z.uuid(), requestId: z.uuid(), amountSatang: z.string() }),
  async execute(tx, input, ctx) {
    const r = await applyBudget(tx, ctx, [
      { budgetLineId: input.budgetLineId, document: { type: 'REQUEST', id: input.requestId }, run: (s) => reserve(s, [{ requestLineId: input.requestId, amount: BigInt(input.amountSatang) }]) },
    ])
    return r.ok ? { ok: true, result: null, events: r.events } : { ok: false, error: r.error }
  },
})

const run = <I>(command: typeof fundCommand | typeof reserveCommand, input: I) =>
  runCommand(org.ctxOf('admin', NOW), command as never, input, { idempotencyKey: randomUUID(), sender: null })

async function balanceOf(budgetLineId: string) {
  const b = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId } })
  return [b.availableSatang, b.reservedSatang, b.committedSatang, b.actualSatang]
}

/** The buckets as the ledger tells them, row by row (BR-BUD-01) */
async function balanceFromLedger(budgetLineId: string) {
  const rows = await prisma.budgetLedgerEntry.findMany({ where: { budgetLineId }, orderBy: { seq: 'asc' } })
  const buckets: Record<string, bigint> = { AVAILABLE: 0n, RESERVED: 0n, COMMITTED: 0n, ACTUAL: 0n }
  for (const r of rows) {
    if (r.fromBucket !== 'OUTSIDE') buckets[r.fromBucket]! -= r.amountSatang
    buckets[r.toBucket]! += r.amountSatang
  }
  return { seqs: rows.map((r) => r.seq), buckets: [buckets.AVAILABLE, buckets.RESERVED, buckets.COMMITTED, buckets.ACTUAL] }
}

describe('[GC-BUD-07] [FR-BUD-002/AC1] two reservations of 300,000 at the same moment on 500,000: exactly one succeeds', () => {
  it('locks the balance row, so the second sees what the first left (INV-BUD-05)', async () => {
    const line = await budgetLine()
    expect(await run(fundCommand, { budgetLineId: line, amountSatang: '50000000' })).toMatchObject({ ok: true })
    const results = await Promise.all([0, 1].map(() => run(reserveCommand, { budgetLineId: line, requestId: randomUUID(), amountSatang: '30000000' })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', details: { available: '200000.00', shortfall: '100000.00' } } })
    expect(await balanceOf(line)).toEqual([20_000_000n, 30_000_000n, 0n, 0n])
  })
})

describe('[FR-BUD-002/AC3] many reservations at once never spend more than the line has (INV-BUD-05)', () => {
  it('20 reservations of 30,000 on 500,000: 16 succeed, the ledger has no gap and adds up to the balance', async () => {
    const line = await budgetLine()
    await run(fundCommand, { budgetLineId: line, amountSatang: '50000000' })
    const results = await Promise.all(Array.from({ length: 20 }, () => run(reserveCommand, { budgetLineId: line, requestId: randomUUID(), amountSatang: '3000000' })))
    expect(results.filter((r) => r.ok)).toHaveLength(16)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error.code === 'BUDGET_INSUFFICIENT')).toBe(true)
    expect(await balanceOf(line)).toEqual([2_000_000n, 48_000_000n, 0n, 0n])
    const ledger = await balanceFromLedger(line)
    expect(ledger.seqs).toEqual(Array.from({ length: 17 }, (_, i) => i + 1))
    expect(ledger.buckets).toEqual(await balanceOf(line))
    expect(await prisma.budgetAllocation.count({ where: { budgetLineId: line, reservedSatang: 3_000_000n } })).toBe(16)
  })
})

describe('[INV-BUD-04] every ledger row names the event of its operation', () => {
  it('names an event of the same transaction, and a row without one is refused when the transaction commits', async () => {
    const line = await budgetLine()
    await run(fundCommand, { budgetLineId: line, amountSatang: '100000' })
    const row = await prisma.budgetLedgerEntry.findFirstOrThrow({ where: { budgetLineId: line } })
    expect(await prisma.event.findUniqueOrThrow({ where: { id: row.eventId } })).toMatchObject({ type: 'budget.imported', aggregateId: line, organizationId: org.organizationId })
    await expect(
      prisma.$transaction((tx) =>
        tx.budgetLedgerEntry.create({ data: { organizationId: org.organizationId, budgetLineId: line, seq: 99, fromBucket: 'OUTSIDE', toBucket: 'AVAILABLE', amountSatang: 1n, sourceType: 'IMPORT', sourceId: randomUUID(), eventId: randomUUID() } }),
      ),
    ).rejects.toThrow(/INV-BUD-04|does not exist|ForeignKeyConstraintViolation/)
    expect(await prisma.budgetLedgerEntry.count({ where: { budgetLineId: line, seq: 99 } })).toBe(0)
  })
})

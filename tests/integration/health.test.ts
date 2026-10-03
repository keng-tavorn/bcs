import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GET } from '@/app/api/health/route'
import { prisma } from '@/server/db/client'
import { oldestPendingOutboxAgeMs } from '@/server/db/sql/health'
import { checkHealth, DEFAULT_PROBES, inngestProbeWith, type HealthProbe } from '@/server/services/health'
import { createOrg } from '../support/factory'

// /api/health (FR-PLT-008 AC1, FR-PLT-006 AC2): each part reports ok or fail on its own, the deployed commit is
// shown, and no internal detail leaks. The database and storage probes run against the real local services.

const ok: HealthProbe = async () => undefined
const broken: HealthProbe = async () => {
  throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2')
}
const hanging: HealthProbe = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))

describe('[FR-PLT-008/AC1] /api/health checks the database, storage and Inngest and reports each one', () => {
  it('reports ok for the real database and storage', async () => {
    const report = await checkHealth({ database: DEFAULT_PROBES.database, storage: DEFAULT_PROBES.storage, inngest: ok })
    expect(report).toMatchObject({ status: 'ok', checks: { database: 'ok', storage: 'ok', inngest: 'ok' } })
  })

  it('marks only the failing part as fail, and a slow part fails within the time limit', async () => {
    const started = performance.now()
    const report = await checkHealth({ database: ok, storage: broken, inngest: hanging })
    expect(report).toMatchObject({ status: 'degraded', checks: { database: 'ok', storage: 'fail', inngest: 'fail' } })
    expect(performance.now() - started).toBeLessThan(5000)
    expect(JSON.stringify(report)).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|hunter2/)
  })

  it('counts Inngest as failing when the outbox holds an event that has waited too long', async () => {
    const minutes = (n: number) => n * 60 * 1000
    const stalled = await checkHealth({ database: ok, storage: ok, inngest: inngestProbeWith(async () => minutes(6)) })
    expect(stalled.checks.inngest).toBe('fail')
    const moving = await checkHealth({ database: ok, storage: ok, inngest: inngestProbeWith(async () => minutes(1)) })
    const empty = await checkHealth({ database: ok, storage: ok, inngest: inngestProbeWith(async () => null) })
    // Locally the dev server must also answer; elsewhere the keys must be set (both hold in this test environment or neither)
    expect(moving.checks.inngest).toBe(empty.checks.inngest)
  })

  it('measures the oldest waiting outbox row, ignoring sent, dead and suppressed rows and rows Inngest refused', async () => {
    const org = await createOrg()
    const now = new Date()
    // Inside a transaction that is rolled back, so the outbox sweeper of other tests never sees these rows
    await expect(
      prisma.$transaction(async (tx) => {
        const row = (createdAt: Date, extra: object = {}) =>
          tx.outbox.create({ data: { id: randomUUID(), organizationId: org.id, eventName: 'bcs/test.health', payload: {}, createdAt, ...extra } })
        // Older than any row another test could leave behind, so the minimum is one of these
        await row(new Date('1970-01-01T00:00:01Z'), { sentAt: now })
        await row(new Date('1970-01-01T00:00:02Z'), { deadAt: now })
        await row(new Date('1970-01-01T00:00:03Z'), { suppressed: true })
        // Refused by Inngest and backing off: a problem of that message (it dies after OUTBOX_MAX_ATTEMPTS with its own
        // alert), not a sign that events stopped reaching Inngest
        await row(new Date('1970-01-01T00:00:03.5Z'), { attempts: 1 })
        await row(new Date('1970-01-01T00:00:04Z'))
        const age = await oldestPendingOutboxAgeMs(now, tx)
        expect(age).toBe(now.getTime() - new Date('1970-01-01T00:00:04Z').getTime())
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
  })
})

describe('[FR-PLT-006/AC2] /api/health answers 200 with the commit sha when everything is ok', () => {
  it('returns JSON with status, commit and checks, never cached', async () => {
    const res = await GET()
    const body = (await res.json()) as { status: string; commit: string; checks: Record<string, string> }
    expect(Object.keys(body.checks).sort()).toEqual(['database', 'inngest', 'storage'])
    expect(body.commit).toBe(process.env.APP_COMMIT_SHA || 'local')
    expect(res.status).toBe(body.status === 'ok' ? 200 : 503)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

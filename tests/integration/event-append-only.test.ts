import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testAppUrl, testMigratorUrl } from '../support/test-db'

// INV-EVT-01: "Event" can never be updated or deleted — by the app role (privileges) nor by the owner
// role (trigger bcs_forbid_mutation). Uses real Postgres (ADR-027).
let app: pg.Client
let migrator: pg.Client
const eventId = randomUUID()

const insertProbe = `insert into "Event"(id, type, "aggregateType", "aggregateId", "occurredAt", "actorType", channel,
  "correlationId", "requestId", data, "schemaVersion") values ($1, 'test.probe', 'Test', $1, now(), 'SYSTEM', 'SYSTEM', $1, 'test', '{}', 1)`

async function errorCode(client: pg.Client, sql: string): Promise<string | undefined> {
  try {
    await client.query(sql)
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

beforeAll(async () => {
  app = new pg.Client({ connectionString: testAppUrl() })
  migrator = new pg.Client({ connectionString: testMigratorUrl() })
  await Promise.all([app.connect(), migrator.connect()])
  await app.query(insertProbe, [eventId])
})

afterAll(async () => {
  await Promise.all([app.end(), migrator.end()])
})

describe('[INV-EVT-01] [FR-PLT-003/AC2] Event is append-only', () => {
  it('lets the app role insert and read events', async () => {
    const r = await app.query('select type from "Event" where id = $1', [eventId])
    expect(r.rows[0]?.type).toBe('test.probe')
  })

  it('refuses UPDATE, DELETE and TRUNCATE by the app role (privileges)', async () => {
    expect(await errorCode(app, `update "Event" set type = 'x' where id = '${eventId}'`)).toBe('42501')
    expect(await errorCode(app, `delete from "Event" where id = '${eventId}'`)).toBe('42501')
    expect(await errorCode(app, 'truncate "Event"')).toBe('42501')
  })

  it('refuses UPDATE and DELETE even by the owner role (trigger)', async () => {
    expect(await errorCode(migrator, `update "Event" set type = 'x' where id = '${eventId}'`)).toBe('23001')
    expect(await errorCode(migrator, `delete from "Event" where id = '${eventId}'`)).toBe('23001')
    const r = await migrator.query('select type from "Event" where id = $1', [eventId])
    expect(r.rows[0]?.type).toBe('test.probe')
  })

  it('refuses UPDATE and DELETE of CommandLog by the app role (written once, purged by the migrator)', async () => {
    expect(await errorCode(app, 'update "CommandLog" set "commandName" = \'x\'')).toBe('42501')
    expect(await errorCode(app, 'delete from "CommandLog"')).toBe('42501')
  })
})

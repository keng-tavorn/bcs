import pg from 'pg'

// The wipe of the staging demo reset (ADR-056): every table of schema public emptied in one statement, as the migrator
// (DIRECT_URL, the owner of the tables), so the database is as the migrations left it with no data. _prisma_migrations
// stays, so the schema keeps its migration record and the next deploy migrates as usual. TRUNCATE fires no row
// trigger, which is why only the migrator may run it: the first migration (20261002024508_s1_platform) wrote "in
// local/test only", and ADR-056 adds staging when its owner types the day's confirmation. The caller
// (src/server/services/demo-seed) checks APP_ENV=staging and that confirmation.

const KEEP = '_prisma_migrations'

export class OtherOrganizationError extends Error {
  constructor(readonly codes: readonly string[]) {
    super(`the database holds organizations other than the sample ones (${codes.join(', ')}): nothing was wiped`)
    this.name = 'OtherOrganizationError'
  }
}

/** The TRUNCATE for these tables, quoted; null when there is nothing to empty */
export function wipeStatement(tables: readonly string[]): string | null {
  const names = tables.filter((t) => t !== KEEP).map((t) => `public."${t.replaceAll('"', '""')}"`)
  return names.length > 0 ? `TRUNCATE TABLE ${names.join(', ')} RESTART IDENTITY CASCADE` : null
}

/**
 * Empties every table of schema public but the migration record, in one transaction that first checks, on the same
 * connection, that no organization exists but those of `sampleCodes` (OtherOrganizationError otherwise, nothing emptied):
 * the organizations the seed makes from the input workbooks (P1-11, ADR-073). Returns how many tables it emptied.
 */
export async function wipeAllData(directUrl: string, sampleCodes: readonly string[]): Promise<number> {
  const client = new pg.Client({ connectionString: directUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public' order by tablename`)
    if (rows.some((r) => r.tablename === 'Organization')) {
      const others = await client.query<{ code: string }>(`select code from public."Organization" where code <> all($1::text[]) order by code`, [[...sampleCodes]])
      if (others.rows.length > 0) throw new OtherOrganizationError(others.rows.map((r) => r.code))
    }
    const statement = wipeStatement(rows.map((r) => r.tablename))
    if (statement) await client.query(statement)
    await client.query('COMMIT')
    return rows.filter((r) => r.tablename !== KEEP).length
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

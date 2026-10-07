import pg from 'pg'

// The wipe of the staging demo reset (ADR-056): every table of schema public emptied in one statement, as the migrator
// (DIRECT_URL, the owner of the tables), so the database is as the migrations left it with no data. _prisma_migrations
// stays, so the schema keeps its migration record and the next deploy migrates as usual. TRUNCATE fires no row
// trigger, which is why only the migrator may run it (prisma/migrations/20261002024508_s1_platform: append-only
// tables) — the caller (src/server/services/demo-seed) checks APP_ENV=staging and the person's typed confirmation.

const KEEP = '_prisma_migrations'

/** The TRUNCATE for these tables, quoted; null when there is nothing to empty */
export function wipeStatement(tables: readonly string[]): string | null {
  const names = tables.filter((t) => t !== KEEP).map((t) => `public."${t.replaceAll('"', '""')}"`)
  return names.length > 0 ? `TRUNCATE TABLE ${names.join(', ')} RESTART IDENTITY CASCADE` : null
}

/** Empties every table of schema public but the migration record; returns how many tables it emptied */
export async function wipeAllData(directUrl: string): Promise<number> {
  const client = new pg.Client({ connectionString: directUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public' order by tablename`)
    const statement = wipeStatement(rows.map((r) => r.tablename))
    if (statement) await client.query(statement)
    return rows.filter((r) => r.tablename !== KEEP).length
  } finally {
    await client.end()
  }
}

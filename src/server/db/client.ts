import { PrismaPg } from '@prisma/adapter-pg'
import { DB_POOL_ACQUIRE_TIMEOUT_MS, DB_POOL_MAX } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { PrismaClient } from './generated/client'

// Runtime client: role bcs_app via DATABASE_URL (pooled on Neon) through the pg driver adapter, which supports
// interactive transactions and SELECT … FOR UPDATE (spec §5.1, §5.2). Never the Neon HTTP mode for money.
// The pool is sized explicitly per server process; the Neon pooler (transaction mode) multiplexes these
// connections, so only transaction-scoped settings are used (SET LOCAL, pg_advisory_xact_lock). Waits for a
// free connection are bounded, so a burst of blocked commands cannot hang every other query.
function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: getEnv().DATABASE_URL,
    max: DB_POOL_MAX,
    connectionTimeoutMillis: DB_POOL_ACQUIRE_TIMEOUT_MS,
  })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { bcsPrisma?: PrismaClient }

/** Base client. Tenant data must be accessed through db.forTenant() (spec §4.8), added in S1-06. */
export const prisma: PrismaClient = globalForPrisma.bcsPrisma ?? createClient()
if (getEnv().APP_ENV === 'local') globalForPrisma.bcsPrisma = prisma

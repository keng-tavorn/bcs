import { PrismaPg } from '@prisma/adapter-pg'
import { getEnv } from '@/lib/env'
import { PrismaClient } from './generated/client'

// Runtime client: role bcs_app via DATABASE_URL (pooled on Neon) through the pg driver adapter, which supports
// interactive transactions and SELECT … FOR UPDATE (spec §5.1, §5.2). Never the Neon HTTP mode for money.
function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { bcsPrisma?: PrismaClient }

/** Base client. Tenant data must be accessed through db.forTenant() (spec §4.8), added in S1-06. */
export const prisma: PrismaClient = globalForPrisma.bcsPrisma ?? createClient()
if (getEnv().APP_ENV === 'local') globalForPrisma.bcsPrisma = prisma

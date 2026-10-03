import { prisma } from './client'

// Cross-tenant access for platform infrastructure only: the outbox relay/sweeper, platform administration
// and health checks. Business services and queries must use db.forTenant() (spec §4.8).
export const systemDb = prisma

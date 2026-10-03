import { systemDb } from '@/server/db/system'

// The signed-in devices of one identity (FR-AUTH-003 AC3). Signing one out is a member command
// (revokeOwnSession in src/server/services/members) so it is recorded as an event.

export interface DeviceSessionDto {
  readonly id: string
  readonly createdAt: string
  readonly lastActiveAt: string | null
  readonly userAgent: string | null
  readonly ipAddress: string | null
  readonly current: boolean
}

export async function listMySessions(userId: string, currentSessionId: string): Promise<DeviceSessionDto[]> {
  const rows = await systemDb.session.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
  return rows.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    lastActiveAt: s.lastActiveAt?.toISOString() ?? null,
    userAgent: s.userAgent,
    ipAddress: s.ipAddress,
    current: s.id === currentSessionId,
  }))
}

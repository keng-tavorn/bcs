import { checkHealth } from '@/server/services/health'

// GET /api/health (FR-PLT-008 AC1, FR-PLT-006 AC2): 200 when database, storage and Inngest are all ok, otherwise 503.
// Read-only and never cached.
export const dynamic = 'force-dynamic'

const DEGRADED_STATUS = 503

export async function GET(): Promise<Response> {
  const report = await checkHealth()
  return Response.json(report, { status: report.status === 'ok' ? 200 : DEGRADED_STATUS, headers: { 'cache-control': 'no-store' } })
}

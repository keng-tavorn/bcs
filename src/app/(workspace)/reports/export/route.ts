import { z } from 'zod'
import { HTTP_STATUS, isErrorCode } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { exportReport } from '@/server/services/reports'
import { toInsightFailure } from '@/ui/insight/outcome'
import { json, readJson, sameOrigin } from '../_lib/http'

// POST a report's file (FR-VIS-002 AC1 "ส่งออก Excel", FR-VIS-003 AC3 the KPI CSV of the 60-day review): the report
// within the reader's report.view scope (AC3), written as Excel or CSV with its SHA-256 and recorded as an ExportJob of
// kind REPORT with its event. The service checks the capability, the report and its parameters.

const Body = z.object({
  idempotencyKey: z.uuid(),
  format: z.enum(['xlsx', 'csv']),
  reportCode: z.string().min(1).max(40),
  params: z.record(z.string(), z.unknown()),
})

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ ok: false, code: 'FORBIDDEN' }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ ok: false, code: 'UNAUTHENTICATED' }, HTTP_STATUS.UNAUTHENTICATED)
  const body = Body.safeParse(await readJson(request))
  if (!body.success) return json({ ok: false, code: 'VALIDATION_FAILED', field: body.error.issues[0]?.path.join('.') || '(body)' }, HTTP_STATUS.VALIDATION_FAILED)
  const { idempotencyKey, format, reportCode, params } = body.data
  const result = await exportReport(ctx, { reportCode, params, format }, { idempotencyKey })
  if (!result.ok) return json(toInsightFailure(result.error), isErrorCode(result.error.code) ? HTTP_STATUS[result.error.code] : HTTP_STATUS.INTERNAL)
  return json({ ok: true, exportJobId: result.data.exportJobId, fileId: result.data.fileId, rowCount: result.data.rowCount, checksum: result.data.checksum })
}

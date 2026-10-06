import { z } from 'zod'
import { HTTP_STATUS, isErrorCode } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { exportAudit } from '@/server/services/audit'
import { toInsightFailure } from '@/ui/insight/outcome'
import { json, readJson, sameOrigin } from '../../reports/_lib/http'

// POST the audit export (FR-VIS-004 AC2 AC3, FR-DOA-005 AC3): the events of the search as Excel or CSV with the DOA
// version and rule, the channel, the actor and on whose behalf in every row, and the file's SHA-256; the export is
// recorded as audit.exported. Only the AUDITOR may export (audit.export, ADR-038 ข้อ 5) — the service checks it, so the
// CEO's export is refused with 403 FORBIDDEN whatever the screen shows. The filter is checked by the service's schema;
// a period that ends before it starts is refused here first, as the page refuses to search it (it holds no event).

const Body = z.object({
  idempotencyKey: z.uuid(),
  format: z.enum(['xlsx', 'csv']),
  filter: z.record(z.string(), z.unknown()).default({}),
})

/** The filter's period ends where or before it starts: from 00:00 of a day to 00:00 of the day after the last one */
const reversed = (filter: Record<string, unknown>): boolean => typeof filter.from === 'string' && typeof filter.to === 'string' && Date.parse(filter.from) >= Date.parse(filter.to)

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ ok: false, code: 'FORBIDDEN' }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ ok: false, code: 'UNAUTHENTICATED' }, HTTP_STATUS.UNAUTHENTICATED)
  const body = Body.safeParse(await readJson(request))
  if (!body.success) return json({ ok: false, code: 'VALIDATION_FAILED', field: body.error.issues[0]?.path.join('.') || '(body)' }, HTTP_STATUS.VALIDATION_FAILED)
  const { idempotencyKey, format, filter } = body.data
  if (reversed(filter)) return json({ ok: false, code: 'VALIDATION_FAILED', field: 'filter.to', reason: 'PERIOD' }, HTTP_STATUS.VALIDATION_FAILED)
  // browser input on its way to the service, whose schema checks every value (runCommand step 2)
  const result = await exportAudit(ctx, { filter: filter as Parameters<typeof exportAudit>[1]['filter'], format }, { idempotencyKey })
  if (!result.ok) return json(toInsightFailure(result.error), isErrorCode(result.error.code) ? HTTP_STATUS[result.error.code] : HTTP_STATUS.INTERNAL)
  return json({ ok: true, exportJobId: result.data.exportJobId, fileId: result.data.fileId, rowCount: result.data.rowCount, checksum: result.data.checksum })
}

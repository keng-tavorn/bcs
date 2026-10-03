import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { AUDIT_EXPORT_MAX_ROWS, AUDIT_PAGE_MAX } from '@/lib/constants'
import { csv, utf8WithBom } from '@/lib/encoding'
import { newId } from '@/lib/ids'
import { putObject } from '@/integrations/storage'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import '../exports/file-policy'

// The audit trail (spec §4.5, FR-VIS-004, FR-DOA-005 AC3): the AUDITOR — and ORG_ADMIN, who may look — searches the
// events by document, actor, period, type and channel, newest first; only the AUDITOR exports them as Excel or CSV
// with the DOA version and rule, the channel and on whose behalf, and the file's sha256 (ADR-038 ข้อ 5: the CEO's demo
// scene uses the auditor). Every export is an event of its own (audit.exported) and an ExportJob of kind AUDIT.

const CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const

export const AuditFilterSchema = z.strictObject({
  /** The document (aggregate) the events are about */
  aggregateId: z.uuid().optional(),
  actorMemberId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  types: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_]*$/)).max(50).optional(),
  channel: z.enum(CHANNELS).optional(),
})
export type AuditFilter = z.infer<typeof AuditFilterSchema>

export interface AuditRowDto {
  readonly seq: string
  readonly occurredAt: string
  readonly type: string
  readonly aggregateType: string
  readonly aggregateId: string
  readonly actorType: string
  readonly actorName: string | null
  readonly onBehalfOfName: string | null
  readonly channel: string
  readonly doaVersionId: string | null
  readonly doaRuleCode: string | null
  readonly data: unknown
}

function where(filter: AuditFilter, beforeSeq?: bigint) {
  return {
    ...(filter.aggregateId ? { aggregateId: filter.aggregateId } : {}),
    ...(filter.actorMemberId ? { actorMemberId: filter.actorMemberId } : {}),
    ...(filter.types?.length ? { type: { in: filter.types } } : {}),
    ...(filter.channel ? { channel: filter.channel } : {}),
    ...(filter.from || filter.to ? { occurredAt: { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lt: new Date(filter.to) } : {}) } } : {}),
    ...(beforeSeq !== undefined ? { seq: { lt: beforeSeq } } : {}),
  }
}

async function rows(tx: TenantTx, filter: AuditFilter, take: number, beforeSeq?: bigint): Promise<AuditRowDto[]> {
  const events = await tx.event.findMany({ where: where(filter, beforeSeq), orderBy: { seq: 'desc' }, take })
  const memberIds = [...new Set(events.flatMap((e) => [e.actorMemberId, e.onBehalfOfMemberId]).filter((m): m is string => Boolean(m)))]
  const members = new Map((await tx.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, displayNameTh: true } })).map((m) => [m.id, m.displayNameTh]))
  return events.map((e) => ({
    seq: e.seq.toString(),
    occurredAt: e.occurredAt.toISOString(),
    type: e.type,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    actorType: e.actorType,
    actorName: e.actorMemberId ? (members.get(e.actorMemberId) ?? null) : null,
    onBehalfOfName: e.onBehalfOfMemberId ? (members.get(e.onBehalfOfMemberId) ?? null) : null,
    channel: e.channel,
    doaVersionId: e.doaVersionId,
    doaRuleCode: e.doaRuleCode,
    data: e.data,
  }))
}

/** FR-VIS-004 AC1: a page of events, newest first; `beforeSeq` continues after the last row of the page before */
export async function searchAudit(ctx: Ctx, filter: AuditFilter, page: { limit?: number; beforeSeq?: string } = {}): Promise<Result<{ rows: AuditRowDto[]; nextBeforeSeq: string | null }>> {
  const parsed = AuditFilterSchema.safeParse(filter)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid filter', { field: parsed.error.issues[0]?.path.join('.') ?? 'filter' })
  const limit = Math.min(Math.max(page.limit ?? AUDIT_PAGE_MAX, 1), AUDIT_PAGE_MAX)
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'audit.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const found = await rows(tx, parsed.data, limit, page.beforeSeq ? BigInt(page.beforeSeq) : undefined)
    return ok({ rows: found, nextBeforeSeq: found.length === limit ? found.at(-1)!.seq : null })
  })
}

const HEADER = ['seq', 'occurredAt', 'type', 'aggregateType', 'aggregateId', 'actorType', 'actor', 'onBehalfOf', 'channel', 'doaVersionId', 'doaRuleCode', 'data']
const line = (r: AuditRowDto) => [r.seq, r.occurredAt, r.type, r.aggregateType, r.aggregateId, r.actorType, r.actorName ?? '', r.onBehalfOfName ?? '', r.channel, r.doaVersionId ?? '', r.doaRuleCode ?? '', JSON.stringify(r.data)]
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' } as const

const ExportInput = z.strictObject({ filter: AuditFilterSchema.default({}), format: z.enum(['xlsx', 'csv']).default('xlsx') })

export const exportAuditCommand = defineCommand({
  name: 'audit.export',
  capability: 'audit.export',
  input: ExportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ exportJobId: string; fileId: string; rowCount: number; checksum: string }>> {
    const allowed = await authorize(tx, ctx, 'audit.export')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member exports' } }
    const found = await rows(tx, input.filter, AUDIT_EXPORT_MAX_ROWS + 1)
    if (found.length > AUDIT_EXPORT_MAX_ROWS) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'too many events for one file: narrow the filter', details: { reason: 'TOO_MANY_ROWS', max: AUDIT_EXPORT_MAX_ROWS } } }
    let bytes: Uint8Array
    if (input.format === 'csv') bytes = utf8WithBom(csv([HEADER, ...found.map(line)]))
    else {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('audit')
      sheet.addRow(HEADER)
      for (const r of found) sheet.addRow(line(r))
      bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
    }
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const exportJobId = newId()
    const fileId = newId()
    const key = `org/${ctx.organizationId}/exports/${exportJobId}.${input.format}`
    await putObject(key, bytes, MIME[input.format])
    await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey: key, fileName: `audit-${ctx.now.toISOString().slice(0, 10)}-${exportJobId.slice(-6)}.${input.format}`, mimeType: MIME[input.format], sizeBytes: bytes.length, sha256: checksum, status: 'AVAILABLE', uploadedById: actor } })
    await tx.exportJob.create({ data: { id: exportJobId, organizationId: ctx.organizationId, kind: 'AUDIT', params: { filter: input.filter, format: input.format }, status: 'COMPLETED', fileId, rowCount: found.length, checksum, requestedById: actor, completedAt: ctx.now } })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'ExportJob', subjectId: exportJobId, kind: 'OTHER' } })
    return {
      ok: true,
      result: { exportJobId, fileId, rowCount: found.length, checksum },
      events: [{ type: 'audit.exported', aggregateType: 'ExportJob', aggregateId: exportJobId, data: { rowCount: found.length, checksum, fileId, format: input.format, filter: input.filter } }],
      notifications: [{ recipientMemberId: actor, templateKey: 'export.ready', data: { exportJobId, fileId, rowCount: found.length, kind: 'AUDIT' }, urgency: 'IMMEDIATE', dedupeKey: `export.ready:${exportJobId}`, subjectType: 'EXPORT_JOB', subjectId: exportJobId }],
    }
  },
})

export function exportAudit(ctx: Ctx, input: z.input<typeof ExportInput>, options: RunOptions) {
  return runCommand(ctx, exportAuditCommand, input, options)
}

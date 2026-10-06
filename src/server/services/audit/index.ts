import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { AUDIT_EXPORT_MAX_ROWS, AUDIT_PAGE_MAX } from '@/lib/constants'
import { csv, utf8WithBom } from '@/lib/encoding'
import { newId } from '@/lib/ids'
import { putObject } from '@/integrations/storage'
import { authorize, isAllowed, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { registeredEventTypes } from '@/server/events/registry'
import '@/server/events/schemas'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import '../exports/file-policy'
import { holdsNationalId, maskNationalIds, seesNationalIdsWhole } from './masking'

// The audit trail (spec §4.5, FR-VIS-004, FR-DOA-005 AC3): the AUDITOR — and ORG_ADMIN, who may look — searches the
// events by document, actor, period, type and channel, newest first; only the AUDITOR exports them as Excel or CSV
// with the DOA version and rule, the channel and on whose behalf, and the file's sha256 (ADR-038 ข้อ 5: the CEO's demo
// scene uses the auditor). Every export is an event of its own (audit.exported) and an ExportJob of kind AUDIT.
// BR-AUTH-04 (NEW-33): the rows show an individual's national id number in event data masked to every reader the supplier
// register shows it to masked or not at all (./masking.ts) — the search, the page and the file alike, so the file's
// checksum is over what it holds; a file that holds a number whole downloads only for readers who see them whole.

export const AUDIT_CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const
const CHANNELS = AUDIT_CHANNELS

export const AuditFilterSchema = z.strictObject({
  /** The document (aggregate) the events are about */
  aggregateId: z.uuid().optional(),
  /**
   * A document as people know it, by its number (PR-…, PO-…, GR-…) or its id: the document's own events and those of
   * its approval tasks — for a PO also its receipts, variances (with their tasks) and invoices — so its decisions come
   * too, and the budget movements that name the request or PO (budget.reserved, committed, released, actualized)
   */
  document: z.string().trim().min(1).max(60).optional(),
  actorMemberId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  types: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_]*$/)).max(50).optional(),
  channel: z.enum(CHANNELS).optional(),
})
export type AuditFilter = z.infer<typeof AuditFilterSchema>

/** The business document an event is about, as the screen names and links it */
export interface AuditDocumentDto {
  readonly type: 'REQUEST' | 'PURCHASE_ORDER' | 'GOODS_RECEIPT' | 'VARIANCE' | 'INVOICE' | 'EXPORT' | 'DOA_VERSION' | 'ORG_AUTHORITY_CHANGE' | 'BUDGET_LINE' | 'MEMBER' | 'SUPPLIER'
  readonly id: string
  readonly label: string
  /** The purchase order of a variance, a receipt or an invoice (the page that shows it) */
  readonly poId: string | null
  /** A DOA version's number (its label is the DOA's code) */
  readonly versionNo: number | null
}

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
  /** The DOA version a decision names (FR-DOA-005: "DOA-DEMO ฉบับ 1 ข้อ PR-02") */
  readonly doaVersion: { readonly code: string; readonly versionNo: number } | null
  readonly document: AuditDocumentDto | null
  /** The event's data as this reader may read it: an individual's national id number masked unless they see it whole (BR-AUTH-04) */
  readonly data: unknown
}

/** A document's trail: the aggregates whose events are its own, and the documents budget events name in data.documentId */
interface Trail {
  readonly aggregateIds: readonly string[]
  readonly documentIds: readonly string[]
}

/** Events of the trail: its aggregates', and the budget movements (aggregate BudgetLine) that name one of its documents */
function trailCondition(trail: Trail) {
  const budget = trail.documentIds.length ? [{ aggregateType: 'BudgetLine', OR: trail.documentIds.map((id) => ({ data: { path: ['documentId'], equals: id } })) }] : []
  return { OR: [{ aggregateId: { in: [...trail.aggregateIds] } }, ...budget] }
}

function where(filter: AuditFilter, beforeSeq?: bigint, trail?: Trail) {
  return {
    AND: [
      ...(filter.aggregateId ? [{ aggregateId: filter.aggregateId }] : []),
      ...(trail ? [trailCondition(trail)] : []),
      ...(filter.actorMemberId ? [{ actorMemberId: filter.actorMemberId }] : []),
      ...(filter.types?.length ? [{ type: { in: filter.types } }] : []),
      ...(filter.channel ? [{ channel: filter.channel }] : []),
      ...(filter.from || filter.to ? [{ occurredAt: { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lt: new Date(filter.to) } : {}) } }] : []),
      ...(beforeSeq !== undefined ? [{ seq: { lt: beforeSeq } }] : []),
    ],
  }
}

/** The aggregates and documents whose events make up a document's trail; none when no document has that number */
async function documentTrail(tx: TenantTx, document: string): Promise<Trail> {
  const match = z.uuid().safeParse(document).success ? { id: document } : { number: document }
  const [requests, pos, receipts] = await Promise.all([
    tx.request.findMany({ where: match, select: { id: true } }),
    tx.purchaseOrder.findMany({ where: match, select: { id: true } }),
    tx.goodsReceipt.findMany({ where: match, select: { id: true } }),
  ])
  const poIds = pos.map((p) => p.id)
  const [poReceipts, variances, invoices] = poIds.length
    ? await Promise.all([
        tx.goodsReceipt.findMany({ where: { poId: { in: poIds } }, select: { id: true } }),
        tx.variance.findMany({ where: { poId: { in: poIds } }, select: { id: true } }),
        tx.invoiceConfirmation.findMany({ where: { poId: { in: poIds } }, select: { id: true } }),
      ])
    : [[], [], []]
  const routed = [...requests.map((r) => r.id), ...poIds, ...variances.map((v) => v.id)]
  const tasks = routed.length ? await tx.approvalTask.findMany({ where: { step: { route: { subjectId: { in: routed } } } }, select: { id: true } }) : []
  return {
    aggregateIds: [...new Set([...routed, ...receipts.map((r) => r.id), ...poReceipts.map((r) => r.id), ...invoices.map((i) => i.id), ...tasks.map((t) => t.id)])],
    // budget events name the request or the PO whose action moved the money (src/server/events/schemas/budget.ts)
    documentIds: [...requests.map((r) => r.id), ...poIds],
  }
}

/** The business document of each event: its own aggregate, or the document an approval task decides */
async function documentsOf(tx: TenantTx, events: ReadonlyArray<{ aggregateType: string; aggregateId: string }>): Promise<Map<string, AuditDocumentDto>> {
  const ids = (type: string) => [...new Set(events.filter((e) => e.aggregateType === type).map((e) => e.aggregateId))]
  const tasks = await tx.approvalTask.findMany({ where: { id: { in: ids('ApprovalTask') } }, select: { id: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } } })
  const routed = (type: string) => tasks.filter((t) => t.step.route.subjectType === type).map((t) => t.step.route.subjectId)
  const [requests, pos, receipts, variances, invoices, exports, versions, changes, lines, members, suppliers] = await Promise.all([
    tx.request.findMany({ where: { id: { in: [...ids('Request'), ...routed('REQUEST')] } }, select: { id: true, number: true, title: true } }),
    tx.purchaseOrder.findMany({ where: { id: { in: [...ids('PurchaseOrder'), ...routed('PURCHASE_ORDER')] } }, select: { id: true, number: true } }),
    tx.goodsReceipt.findMany({ where: { id: { in: ids('GoodsReceipt') } }, select: { id: true, number: true, poId: true } }),
    tx.variance.findMany({ where: { id: { in: [...ids('Variance'), ...routed('VARIANCE')] } }, select: { id: true, poId: true, po: { select: { number: true } } } }),
    tx.invoiceConfirmation.findMany({ where: { id: { in: ids('InvoiceConfirmation') } }, select: { id: true, invoiceNo: true, poId: true } }),
    tx.exportJob.findMany({ where: { id: { in: ids('ExportJob') } }, select: { id: true, kind: true } }),
    tx.doaVersion.findMany({ where: { id: { in: [...ids('DoaVersion'), ...routed('DOA_VERSION')] } }, select: { id: true, code: true, versionNo: true } }),
    tx.orgAuthorityChange.findMany({ where: { id: { in: [...ids('OrgAuthorityChange'), ...routed('ORG_AUTHORITY_CHANGE')] } }, select: { id: true, kind: true } }),
    tx.budgetLine.findMany({ where: { id: { in: ids('BudgetLine') } }, select: { id: true, code: true } }),
    tx.member.findMany({ where: { id: { in: ids('Member') } }, select: { id: true, displayNameTh: true } }),
    tx.supplier.findMany({ where: { id: { in: ids('Supplier') } }, select: { id: true, nameTh: true } }),
  ])
  const doc = (type: AuditDocumentDto['type'], id: string, label: string, poId: string | null = null, versionNo: number | null = null): [string, AuditDocumentDto] => [id, { type, id, label, poId, versionNo }]
  const byId = new Map<string, AuditDocumentDto>([
    ...requests.map((r) => doc('REQUEST', r.id, r.number ? `${r.number} ${r.title}` : r.title)),
    ...pos.map((p) => doc('PURCHASE_ORDER', p.id, p.number ?? '', p.id)),
    ...receipts.map((g) => doc('GOODS_RECEIPT', g.id, g.number ?? '', g.poId)),
    ...variances.map((v) => doc('VARIANCE', v.id, v.po.number ?? '', v.poId)),
    ...invoices.map((i) => doc('INVOICE', i.id, i.invoiceNo, i.poId)),
    ...exports.map((x) => doc('EXPORT', x.id, x.kind)),
    ...versions.map((v) => doc('DOA_VERSION', v.id, v.code, null, v.versionNo)),
    ...changes.map((c) => doc('ORG_AUTHORITY_CHANGE', c.id, c.kind)),
    ...lines.map((l) => doc('BUDGET_LINE', l.id, l.code)),
    ...members.map((m) => doc('MEMBER', m.id, m.displayNameTh)),
    ...suppliers.map((s) => doc('SUPPLIER', s.id, s.nameTh)),
  ])
  // an approval task stands for the document it decides
  for (const t of tasks) {
    const subject = byId.get(t.step.route.subjectId)
    if (subject) byId.set(t.id, subject)
  }
  return byId
}

/** The events of the filter as `reader` may read them (BR-AUTH-04 masking of event data, ./masking.ts) */
async function rows(tx: TenantTx, reader: Principal, filter: AuditFilter, take: number, beforeSeq?: bigint): Promise<AuditRowDto[]> {
  const trail = filter.document ? await documentTrail(tx, filter.document) : undefined
  const events = await tx.event.findMany({ where: where(filter, beforeSeq, trail), orderBy: { seq: 'desc' }, take })
  const memberIds = [...new Set(events.flatMap((e) => [e.actorMemberId, e.onBehalfOfMemberId]).filter((m): m is string => Boolean(m)))]
  const versionIds = [...new Set(events.map((e) => e.doaVersionId).filter((v): v is string => Boolean(v)))]
  const [named, versions, documents] = await Promise.all([
    tx.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, displayNameTh: true } }),
    tx.doaVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, code: true, versionNo: true } }),
    documentsOf(tx, events),
  ])
  const members = new Map(named.map((m) => [m.id, m.displayNameTh]))
  const doa = new Map(versions.map((v) => [v.id, { code: v.code, versionNo: v.versionNo }]))
  const wholeIds = seesNationalIdsWhole(reader)
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
    doaVersion: e.doaVersionId ? (doa.get(e.doaVersionId) ?? null) : null,
    document: documents.get(e.aggregateId) ?? null,
    data: wholeIds ? e.data : maskNationalIds(e.type, e.data),
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
    const found = await rows(tx, allowed.data, parsed.data, limit, page.beforeSeq ? BigInt(page.beforeSeq) : undefined)
    return ok({ rows: found, nextBeforeSeq: found.length === limit ? found.at(-1)!.seq : null })
  })
}

export interface AuditViewDto {
  readonly rows: AuditRowDto[]
  readonly nextBeforeSeq: string | null
  /** audit.export: the AUDITOR alone (ADR-038 ข้อ 5); ORG_ADMIN may look but not take a file */
  readonly canExport: boolean
  /** What the search form offers: every event type the system writes, the channels, and the members as actors */
  readonly eventTypes: readonly string[]
  readonly channels: readonly (typeof AUDIT_CHANNELS)[number][]
  readonly members: ReadonlyArray<{ readonly id: string; readonly nameTh: string; readonly nameEn: string | null }>
}

/** The audit page (§9.1 /audit, FR-VIS-004 AC1): a page of the search with the form's choices, for audit.view */
export async function auditView(ctx: Ctx, filter: AuditFilter, page: { beforeSeq?: string } = {}): Promise<Result<AuditViewDto>> {
  const parsed = AuditFilterSchema.safeParse(filter)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid filter', { field: parsed.error.issues[0]?.path.join('.') ?? 'filter' })
  const before = page.beforeSeq && /^\d{1,19}$/.test(page.beforeSeq) ? BigInt(page.beforeSeq) : undefined
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'audit.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const found = await rows(tx, allowed.data, parsed.data, AUDIT_PAGE_MAX, before)
    const members = await tx.member.findMany({ select: { id: true, displayNameTh: true, displayNameEn: true }, orderBy: { displayNameTh: 'asc' } })
    return ok({
      rows: found,
      nextBeforeSeq: found.length === AUDIT_PAGE_MAX ? found.at(-1)!.seq : null,
      canExport: isAllowed(allowed.data, 'audit.export'),
      eventTypes: registeredEventTypes(),
      channels: AUDIT_CHANNELS,
      members: members.map((m) => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn })),
    })
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
    // the file holds the rows as this AUDITOR reads them (BR-AUTH-04 masking), and its checksum is over those bytes
    const found = await rows(tx, allowed.data, input.filter, AUDIT_EXPORT_MAX_ROWS + 1)
    if (found.length > AUDIT_EXPORT_MAX_ROWS) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'too many events for one file: narrow the filter', details: { reason: 'TOO_MANY_ROWS', max: AUDIT_EXPORT_MAX_ROWS } } }
    // whether a national id number is in the file whole (only a reader who sees them whole makes such a file): the file
    // policy gives it only to readers who see them whole (auditFileReadable)
    const wholeNationalIds = found.some((r) => holdsNationalId(r.type, r.data))
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
    await tx.exportJob.create({ data: { id: exportJobId, organizationId: ctx.organizationId, kind: 'AUDIT', params: { filter: input.filter, format: input.format, wholeNationalIds }, status: 'COMPLETED', fileId, rowCount: found.length, checksum, requestedById: actor, completedAt: ctx.now } })
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

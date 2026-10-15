import { createHash } from 'node:crypto'
import { z } from 'zod'
import { satangToAmount, amountToSatang } from '@/core/money/dto'
import { agreementDay, checkAgreement } from '@/core/pricing'
import { CONFIG_PACKAGE_MAX_CHARS } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { putObject } from '@/integrations/storage'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { doaVersionDataFromRows, doaYaml, parseDoaYaml } from '@/server/doa/yaml'
import type { EventDraft } from '@/server/events/append'
import { workflowRuleJson, workflowVersionFromRows } from '@/server/workflow/snapshot'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { importDoaDraftCommand } from '../doa'
import { thaiDateStart } from '../doa/dates'
import { parseFormJson } from '../request-types/form-import'
import { draftWorkflowCommand, updateWorkflowCommand } from '../workflow'

// Configuration packages (S6-21 · FR-PLT-101 AC2 · BR-UAT-02 BR-UAT-03 · ADR-110 · OQ-108): what an organization tried
// on its UAT sandbox goes to production as drafts only. Export: the request types' published forms, the workflow and the
// DOA versions in effect and the catalogue with its agreed prices, as JSON with schemaVersion and a sha256 of its content —
// never a request, a budget, an account number or a person's data (people appear only by employee code where a rule
// names one). Import: the checksum and schemaVersion are checked (CONFIG_PACKAGE_INVALID), then every reference —
// positions, departments, employee codes, request types, suppliers, catalogue codes, drafts already open — before
// anything is written; one that does not resolve is reported by its row and nothing is created. Then each part becomes a
// draft through the commands that make drafts, under the importer's own rights (admin.doa.draft for the DOA,
// admin.workflow.draft for the workflow: BR-WF-17), and goes through its normal approval: nothing is published here
// (NG-12, EG-8). The catalogue comes in inactive. PLATFORM_ADMIN neither exports nor imports.

export const CONFIG_PACKAGE_SCHEMA_VERSION = 1
export const CONFIG_PACKAGE_SECTIONS = ['FORMS', 'WORKFLOW', 'DOA', 'CATALOG'] as const
export type ConfigPackageSection = (typeof CONFIG_PACKAGE_SECTIONS)[number]

type FailCode = 'VALIDATION_FAILED' | 'FORBIDDEN' | 'CONFIG_PACKAGE_INVALID'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

// ---------- the package ----------

const Code = z.string().min(1).max(60)
const Baht = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const PortableReviewer = z.union([
  z.strictObject({ kind: z.literal('POSITION_AT'), position: Code, department: Code }),
  z.strictObject({ kind: z.literal('MEMBER'), employeeCode: Code }),
])
const WorkflowRuleJson = z.strictObject({
  code: Code,
  requestTypeCodes: z.array(Code).min(1),
  when: z.unknown(),
  reviewers: z.array(PortableReviewer).min(1),
  fallback: PortableReviewer.nullable(),
  mode: z.enum(['ALL', 'ANY', 'COUNT']),
  quorumCount: z.number().int().positive().nullable(),
  slaMinutes: z.number().int().positive(),
  descriptionTh: z.string().nullable(),
})
const Content = z.strictObject({
  kind: z.literal('BCS_CONFIG_PACKAGE'),
  schemaVersion: z.number().int(),
  organizationCode: Code,
  exportedAt: z.string(),
  forms: z.array(z.strictObject({ requestTypeCode: Code, schema: z.unknown() })).optional(),
  workflows: z.array(z.strictObject({ code: Code, rules: z.array(WorkflowRuleJson) })).optional(),
  doa: z.strictObject({ yaml: z.string().min(1) }).optional(),
  catalog: z
    .array(
      z.strictObject({
        code: Code,
        nameTh: z.string().min(1),
        nameEn: z.string().nullable(),
        uom: z.string().min(1),
        categoryCode: Code,
        isService: z.boolean(),
        whtIncomeType: z.string().nullable(),
        refUnitPrice: Baht,
        agreements: z.array(z.strictObject({ supplierCode: Code, unitPrice: Baht, validFrom: Day, validTo: Day })),
      }),
    )
    .optional(),
})
export type ConfigPackageContent = z.output<typeof Content>

/** JSON with the keys of every object in order, so the checksum does not depend on how the file was written */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** sha256 of the canonical JSON of the package's content (everything but the checksum itself) */
export const configPackageChecksum = (content: ConfigPackageContent) => createHash('sha256').update(canonical(content)).digest('hex')

/** The file of a package: its content and its checksum */
export function configPackageFile(content: ConfigPackageContent): string {
  return JSON.stringify({ ...content, checksum: configPackageChecksum(content) }, null, 2)
}

/** BR-UAT-03: a file that is a package of this schema version, unchanged since it was exported; else why not */
export function readConfigPackage(text: string): { ok: true; content: ConfigPackageContent; checksum: string } | { ok: false; reason: 'NOT_JSON' | 'NOT_A_PACKAGE' | 'SCHEMA_VERSION' | 'CHECKSUM' } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'NOT_JSON' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'NOT_A_PACKAGE' }
  const { checksum, ...rest } = raw as Record<string, unknown>
  const parsed = Content.safeParse(rest)
  if (!parsed.success || typeof checksum !== 'string') return { ok: false, reason: 'NOT_A_PACKAGE' }
  if (parsed.data.schemaVersion !== CONFIG_PACKAGE_SCHEMA_VERSION) return { ok: false, reason: 'SCHEMA_VERSION' }
  if (configPackageChecksum(parsed.data) !== checksum) return { ok: false, reason: 'CHECKSUM' }
  return { ok: true, content: parsed.data, checksum }
}

// ---------- export ----------

const ExportInput = z.strictObject({ sections: z.array(z.enum(CONFIG_PACKAGE_SECTIONS)).min(1) })

/** What the organization has in effect now, as a package of the sections asked for */
async function buildPackage(tx: TenantTx, ctx: Ctx, sections: readonly ConfigPackageSection[]): Promise<ConfigPackageContent> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { code: true } })
  const members = await tx.member.findMany({ where: { employeeCode: { not: null } }, select: { id: true, employeeCode: true } })
  const codeOf = new Map(members.map((m) => [m.id, m.employeeCode!]))
  const content: ConfigPackageContent = { kind: 'BCS_CONFIG_PACKAGE', schemaVersion: CONFIG_PACKAGE_SCHEMA_VERSION, organizationCode: org.code, exportedAt: ctx.now.toISOString() }
  const inEffect = { effectiveFrom: { lte: ctx.now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: ctx.now } }] }

  if (sections.includes('FORMS')) {
    const types = await tx.requestType.findMany({ where: { active: true, currentFormVersionId: { not: null } }, select: { code: true, currentFormVersion: { select: { schema: true } } }, orderBy: { code: 'asc' } })
    content.forms = types.map((t) => ({ requestTypeCode: t.code, schema: t.currentFormVersion!.schema }))
  }
  if (sections.includes('WORKFLOW')) {
    const versions = await tx.workflowVersion.findMany({ where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, ...inEffect }, include: { rules: true }, orderBy: [{ code: 'asc' }, { effectiveFrom: 'desc' }] })
    const latest = versions.filter((v, i) => versions.findIndex((x) => x.code === v.code) === i)
    const portable = (r: { kind: 'POSITION_AT'; position: string; department: string } | { kind: 'MEMBER'; memberId: string }) =>
      r.kind === 'MEMBER' ? { kind: 'MEMBER' as const, employeeCode: codeOf.get(r.memberId) ?? r.memberId } : { kind: 'POSITION_AT' as const, position: r.position, department: r.department }
    content.workflows = latest.map((v) => ({
      code: v.code,
      rules: workflowVersionFromRows(v, v.rules).rules.map((r) => {
        const json = workflowRuleJson(r) as { when: unknown; reviewers: Array<Parameters<typeof portable>[0]>; fallback: Parameters<typeof portable>[0] | null }
        return {
          code: r.code,
          requestTypeCodes: [...r.requestTypeCodes],
          when: json.when,
          reviewers: json.reviewers.map(portable),
          fallback: json.fallback ? portable(json.fallback) : null,
          mode: r.mode,
          quorumCount: r.quorumCount,
          slaMinutes: r.slaBusinessMinutes,
          descriptionTh: v.rules.find((x) => x.code === r.code)?.descriptionTh ?? null,
        }
      }),
    }))
  }
  if (sections.includes('DOA')) {
    const version = await tx.doaVersion.findFirst({ where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, ...inEffect }, orderBy: { effectiveFrom: 'desc' }, include: { rules: true } })
    if (version) content.doa = { yaml: doaYaml([doaVersionDataFromRows(version, version.rules)], codeOf) }
  }
  if (sections.includes('CATALOG')) {
    const items = await tx.catalogItem.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: {
        code: true,
        nameTh: true,
        nameEn: true,
        uom: true,
        categoryCode: true,
        isService: true,
        whtIncomeType: true,
        refUnitPriceSatang: true,
        priceAgreements: { where: { endedAt: null, validTo: { gt: new Date(`${agreementDay(ctx.now)}T00:00:00Z`) } }, select: { unitPriceSatang: true, validFrom: true, validTo: true, supplier: { select: { code: true } } } },
      },
    })
    const day = (d: Date) => d.toISOString().slice(0, 10)
    content.catalog = items.map((i) => ({
      code: i.code,
      nameTh: i.nameTh,
      nameEn: i.nameEn,
      uom: i.uom,
      categoryCode: i.categoryCode,
      isService: i.isService,
      whtIncomeType: i.whtIncomeType,
      refUnitPrice: satangToAmount(i.refUnitPriceSatang),
      agreements: i.priceAgreements.map((a) => ({ supplierCode: a.supplier.code, unitPrice: satangToAmount(a.unitPriceSatang), validFrom: day(a.validFrom), validTo: day(a.validTo) })),
    }))
  }
  return content
}

/** Keeps a package's file, as the export and the import both do (FileObject, ConfigPackage) */
async function keepFile(tx: TenantTx, ctx: Ctx, memberId: string, text: string, name: string): Promise<string> {
  const fileId = newId()
  const storageKey = `org/${ctx.organizationId}/config-packages/${fileId}.json`
  const bytes = new TextEncoder().encode(text)
  await putObject(storageKey, bytes, 'application/json')
  await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey, fileName: name, mimeType: 'application/json', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'AVAILABLE', uploadedById: memberId, scanStatus: 'NOT_REQUIRED' } })
  return fileId
}

export const exportConfigCommand = defineCommand({
  name: 'config.export',
  capability: 'config.export',
  input: ExportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ packageId: string; fileId: string; checksum: string; file: string }>> {
    const allowed = await authorize(tx, ctx, 'config.export')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'only a member of the organization exports its configuration')
    const content = await buildPackage(tx, ctx, input.sections)
    const file = configPackageFile(content)
    const checksum = configPackageChecksum(content)
    const fileId = await keepFile(tx, ctx, allowed.data.memberId, file, `config-${content.organizationCode}-${ctx.now.toISOString().slice(0, 10)}.json`)
    const id = newId()
    const summary = { forms: content.forms?.length ?? 0, workflows: content.workflows?.length ?? 0, doa: content.doa ? 1 : 0, catalog: content.catalog?.length ?? 0 }
    await tx.configPackage.create({ data: { id, organizationId: ctx.organizationId, direction: 'EXPORT', schemaVersion: CONFIG_PACKAGE_SCHEMA_VERSION, checksum, fileId, summary, createdById: allowed.data.memberId } })
    return { ok: true, result: { packageId: id, fileId, checksum, file }, events: [{ type: 'config_package.exported', aggregateType: 'ConfigPackage', aggregateId: id, data: { checksum, sections: [...input.sections], ...summary } }] }
  },
})

export function exportConfigPackage(ctx: Ctx, input: z.input<typeof ExportInput>, options: RunOptions) {
  return runCommand(ctx, exportConfigCommand, input, options)
}

// ---------- import ----------

const ImportInput = z.strictObject({
  file: z.string().min(1).max(CONFIG_PACKAGE_MAX_CHARS),
  /** Thai calendar date the imported workflow drafts would start on; they are drafts, its approver decides */
  effectiveDate: Day,
  changeReason: z.string().trim().min(3).max(500),
})

export interface ConfigImportRow {
  readonly section: ConfigPackageSection
  readonly ref: string
  readonly reason: 'REQUEST_TYPE_NOT_FOUND' | 'DRAFT_EXISTS' | 'FORM_INVALID' | 'POSITION_NOT_FOUND' | 'MEMBER_NOT_FOUND' | 'CATALOG_CODE_EXISTS' | 'SUPPLIER_NOT_FOUND' | 'AGREEMENT_INVALID'
}

/** Every reference of the package that does not resolve in this organization, or a draft that is already open */
async function checkReferences(tx: TenantTx, ctx: Ctx, content: ConfigPackageContent): Promise<ConfigImportRow[]> {
  const rows: ConfigImportRow[] = []
  for (const f of content.forms ?? []) {
    const type = await tx.requestType.findFirst({ where: { code: f.requestTypeCode }, select: { id: true } })
    if (!type) rows.push({ section: 'FORMS', ref: f.requestTypeCode, reason: 'REQUEST_TYPE_NOT_FOUND' })
    else if (await tx.formVersion.count({ where: { requestTypeId: type.id, status: 'DRAFT' } })) rows.push({ section: 'FORMS', ref: f.requestTypeCode, reason: 'DRAFT_EXISTS' })
    if (!parseFormJson(JSON.stringify(f.schema)).ok) rows.push({ section: 'FORMS', ref: f.requestTypeCode, reason: 'FORM_INVALID' })
  }
  if (content.workflows?.length) {
    const positions = new Set((await tx.position.findMany({ select: { code: true } })).map((p) => p.code))
    const departments = new Set((await tx.department.findMany({ select: { code: true } })).map((d) => d.code))
    const members = new Set((await tx.member.findMany({ where: { employeeCode: { not: null } }, select: { employeeCode: true } })).map((m) => m.employeeCode!))
    for (const w of content.workflows) {
      if (await tx.workflowVersion.count({ where: { code: w.code, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } })) rows.push({ section: 'WORKFLOW', ref: w.code, reason: 'DRAFT_EXISTS' })
      for (const r of w.rules) {
        for (const s of [...r.reviewers, ...(r.fallback ? [r.fallback] : [])]) {
          if (s.kind === 'MEMBER' && !members.has(s.employeeCode)) rows.push({ section: 'WORKFLOW', ref: `${w.code}/${r.code}/${s.employeeCode}`, reason: 'MEMBER_NOT_FOUND' })
          if (s.kind === 'POSITION_AT' && (!positions.has(s.position) || !departments.has(s.department))) rows.push({ section: 'WORKFLOW', ref: `${w.code}/${r.code}/${s.position}@${s.department}`, reason: 'POSITION_NOT_FOUND' })
        }
      }
    }
  }
  if (content.catalog?.length) {
    const existing = new Set((await tx.catalogItem.findMany({ where: { code: { in: content.catalog.map((i) => i.code) } }, select: { code: true } })).map((i) => i.code))
    // The checks priceAgreement.create makes (BR-PRC-06): an ACTIVE supplier, a price above zero, a period not over yet
    // and no overlap with another agreement of the item and supplier in the package (the item is new here)
    const suppliers = new Set((await tx.supplier.findMany({ where: { code: { in: content.catalog.flatMap((i) => i.agreements.map((a) => a.supplierCode)) }, status: 'ACTIVE' }, select: { code: true } })).map((s) => s.code))
    const today = agreementDay(ctx.now)
    for (const i of content.catalog) {
      // A code here already, or twice in the package
      if (existing.has(i.code)) rows.push({ section: 'CATALOG', ref: i.code, reason: 'CATALOG_CODE_EXISTS' })
      existing.add(i.code)
      const seen: Array<{ catalogItemId: string; supplierId: string; validFrom: string; validTo: string }> = []
      for (const a of i.agreements) {
        const ref = `${i.code}/${a.supplierCode}`
        if (!suppliers.has(a.supplierCode)) rows.push({ section: 'CATALOG', ref, reason: 'SUPPLIER_NOT_FOUND' })
        const period = { catalogItemId: i.code, supplierId: a.supplierCode, validFrom: a.validFrom, validTo: a.validTo }
        if (amountToSatang(a.unitPrice) <= 0n || a.validTo <= today || !checkAgreement(seen, period).ok) rows.push({ section: 'CATALOG', ref: `${ref}@${a.validFrom}`, reason: 'AGREEMENT_INVALID' })
        // Only an agreement that would be created counts against the next, so a row is never blamed for another's fault
        else seen.push(period)
      }
    }
  }
  return rows
}

export const importConfigCommand = defineCommand({
  name: 'config.import',
  capability: 'config.import',
  input: ImportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ packageId: string; created: Record<string, string[]> }>> {
    const allowed = await authorize(tx, ctx, 'config.import')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'only a member of the organization imports a configuration (NG-12)')
    const memberId = allowed.data.memberId
    const read = readConfigPackage(input.file)
    if (!read.ok) return fail('CONFIG_PACKAGE_INVALID', 'the configuration package is not valid or was changed', { reason: read.reason })
    const content = read.content
    const rows = await checkReferences(tx, ctx, content)
    if (rows.length) return fail('VALIDATION_FAILED', 'some rows of the package do not fit this organization; nothing was created', { reason: 'CONFIG_PACKAGE_ROWS', rows })

    const events: EventDraft[] = []
    const created: Record<string, string[]> = { forms: [], workflows: [], doa: [], catalog: [] }
    const failed = (error: { code: string; message: string; details?: Readonly<Record<string, unknown>> }) => ({ ok: false as const, error: error as never })

    // DOA: the next version of each code here, starting on the date asked, as a draft by the DOA import under
    // admin.doa.draft (BR-WF-17); the sandbox's own version numbers mean nothing here
    if (content.doa) {
      const members = await tx.member.findMany({ where: { employeeCode: { not: null } }, select: { id: true, employeeCode: true } })
      const parsed = parseDoaYaml(content.doa.yaml, new Map(members.map((m) => [m.employeeCode!, m.id])))
      if (!parsed.ok) return failed(parsed.error)
      const effectiveFrom = thaiDateStart(input.effectiveDate)
      if (!effectiveFrom) return fail('VALIDATION_FAILED', 'not a calendar date', { field: 'effectiveDate', reason: 'DATE' })
      const versions = []
      for (const v of parsed.data) {
        const last = await tx.doaVersion.aggregate({ where: { code: v.code }, _max: { versionNo: true } })
        versions.push({ ...v, versionNo: (last._max.versionNo ?? 0) + 1, effectiveFrom })
      }
      const yaml = doaYaml(versions, new Map(members.map((m) => [m.id, m.employeeCode!])))
      const r = await importDoaDraftCommand.execute(tx, { yaml, changeReason: input.changeReason }, ctx)
      if (!r.ok) return failed(r.error)
      created.doa!.push(...r.result.versionIds)
      events.push(...r.events)
    }
    // Workflow: a draft of each code, its rules from the package, under admin.workflow.draft
    if (content.workflows?.length) {
      const members = new Map((await tx.member.findMany({ where: { employeeCode: { not: null } }, select: { id: true, employeeCode: true } })).map((m) => [m.employeeCode!, m.id]))
      const local = (s: z.output<typeof PortableReviewer>) => (s.kind === 'MEMBER' ? { kind: 'MEMBER' as const, memberId: members.get(s.employeeCode)! } : s)
      for (const w of content.workflows) {
        const exists = await tx.workflowVersion.count({ where: { code: w.code } })
        const drafted = await draftWorkflowCommand.execute(tx, exists ? {} : { code: w.code }, ctx)
        if (!drafted.ok) return failed(drafted.error)
        const row = await tx.workflowVersion.findUniqueOrThrow({ where: { id: drafted.result.versionId }, select: { version: true } })
        const updated = await updateWorkflowCommand.execute(
          tx,
          {
            versionId: drafted.result.versionId,
            version: row.version,
            effectiveDate: input.effectiveDate,
            changeReason: input.changeReason,
            rules: w.rules.map((r) => ({ ...r, when: r.when as never, reviewers: r.reviewers.map(local), fallback: r.fallback ? local(r.fallback) : null })),
            testCases: [],
          },
          ctx,
        )
        if (!updated.ok) return failed(updated.error)
        created.workflows!.push(drafted.result.versionId)
        // The draft came from the package, not from a copy of a version here
        events.push(...drafted.events.map((e) => (e.type === 'workflow_version.drafted' ? { ...e, data: { code: drafted.result.code, versionNo: drafted.result.versionNo, via: 'CONFIG_IMPORT', rules: w.rules.length } } : e)), ...updated.events)
      }
    }
    // Forms: a DRAFT of each request type's form, published later through the form builder
    for (const f of content.forms ?? []) {
      const type = await tx.requestType.findFirstOrThrow({ where: { code: f.requestTypeCode }, select: { id: true, code: true, currentFormVersion: { select: { versionNo: true } } } })
      const last = await tx.formVersion.aggregate({ where: { requestTypeId: type.id }, _max: { versionNo: true } })
      const versionNo = (last._max.versionNo ?? 0) + 1
      const id = newId()
      await tx.formVersion.create({ data: { id, organizationId: ctx.organizationId, requestTypeId: type.id, versionNo, schema: f.schema as object, status: 'DRAFT' } })
      created.forms!.push(id)
      events.push({ type: 'form_version.drafted', aggregateType: 'FormVersion', aggregateId: id, data: { requestTypeCode: type.code, versionNo, via: 'CONFIG_IMPORT', fromVersionNo: type.currentFormVersion?.versionNo ?? null } })
    }
    // Catalogue: items inactive until PROCUREMENT turns them on, with their agreed prices
    if (content.catalog?.length) {
      const suppliers = new Map((await tx.supplier.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]))
      for (const i of content.catalog) {
        const id = newId()
        await tx.catalogItem.create({ data: { id, organizationId: ctx.organizationId, code: i.code, nameTh: i.nameTh, nameEn: i.nameEn, uom: i.uom, categoryCode: i.categoryCode, isService: i.isService, whtIncomeType: i.whtIncomeType, refUnitPriceSatang: amountToSatang(i.refUnitPrice), active: false } })
        created.catalog!.push(id)
        events.push({ type: 'catalog_item.created', aggregateType: 'CatalogItem', aggregateId: id, data: { code: i.code, via: 'CONFIG_IMPORT' } })
        for (const a of i.agreements) {
          const agreementId = newId()
          const supplierId = suppliers.get(a.supplierCode)!
          await tx.priceAgreement.create({ data: { id: agreementId, organizationId: ctx.organizationId, catalogItemId: id, supplierId, unitPriceSatang: amountToSatang(a.unitPrice), validFrom: new Date(`${a.validFrom}T00:00:00Z`), validTo: new Date(`${a.validTo}T00:00:00Z`), sourceRef: 'CONFIG_IMPORT', createdById: memberId } })
          events.push({ type: 'price_agreement.created', aggregateType: 'PriceAgreement', aggregateId: agreementId, data: { catalogItemId: id, supplierId, unitPriceSatang: amountToSatang(a.unitPrice).toString(), validFrom: a.validFrom, validTo: a.validTo, via: 'CONFIG_IMPORT' } })
        }
      }
    }

    const fileId = await keepFile(tx, ctx, memberId, input.file, `config-import-${ctx.now.toISOString().slice(0, 10)}.json`)
    const id = newId()
    const summary = { from: content.organizationCode, forms: created.forms!.length, workflows: created.workflows!.length, doa: created.doa!.length, catalog: created.catalog!.length }
    await tx.configPackage.create({ data: { id, organizationId: ctx.organizationId, direction: 'IMPORT', schemaVersion: content.schemaVersion, checksum: read.checksum, fileId, summary, createdById: memberId, createdObjects: created } })
    return { ok: true, result: { packageId: id, created }, events: [{ type: 'config_package.imported', aggregateType: 'ConfigPackage', aggregateId: id, data: { checksum: read.checksum, ...summary } }, ...events] }
  },
})

export function importConfigPackage(ctx: Ctx, input: z.input<typeof ImportInput>, options: RunOptions) {
  return runCommand(ctx, importConfigCommand, input, options)
}

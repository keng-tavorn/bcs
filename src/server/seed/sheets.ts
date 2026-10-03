import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import { isValidThaiTaxId } from '@/core/thai/taxid'
import type { DoaRuleSnapshot, DoaVersionSnapshot } from '@/core/doa'
import type { InputWorkbook } from './workbook'

// S2-15: the sheets Departments, Positions, DOA, DOA_Policy, RequestTypes and Holidays of
// docs/inputs/BCS_inputs_v1_demo.xlsx, read the way scripts/validate_inputs.py reads them. Every problem names the
// sheet and row so a person can fix the file in Excel (the agent never edits the workbook).

const text = z.string().trim().min(1)
const yesNo = z.enum(['Y', 'N']).transform((v) => v === 'Y')
/** Whole baht written as a number in the sheet ("20000") or empty; DOA amounts in the sheet have no satang */
const bahtOrNull = z
  .string()
  .nullable()
  .transform((v, ctx) => {
    if (v === null) return null
    if (!/^\d+(\.\d{1,2})?$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: `not an amount in baht: ${v}` })
      return z.NEVER
    }
    return amountToSatang(v)
  })

function issueText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(row)'}: ${i.message}`).join('; ')
}

function rows<T>(workbook: InputWorkbook, sheet: string, schema: z.ZodType<T>): T[] {
  return workbook.table(sheet).map(({ row, values }) => {
    const parsed = schema.safeParse(values)
    if (!parsed.success) throw new Error(`${sheet} row ${row}: ${issueText(parsed.error)}`)
    return parsed.data
  })
}

const DepartmentRow = z.object({ code: z.string().regex(/^[A-Z0-9_]{2,20}$/), nameTh: text, parent: z.string().nullable(), kind: z.enum(['COMPANY', 'DIVISION', 'DEPARTMENT', 'SECTION']) })
const PositionRow = z.object({ code: z.string().regex(/^[A-Z_]{2,20}$/), nameTh: text, scope: z.enum(['DEPARTMENT', 'ORG']) })
const DoaRow = z.object({
  version: z.coerce.number().int().min(1),
  ruleCode: z.string().regex(/^[A-Z0-9-]{2,20}$/),
  documentType: z.enum(['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE']),
  gt: bahtOrNull,
  lte: bahtOrNull,
  approverKind: z.enum(['POSITION_OF_DEPARTMENT', 'POSITION_OF_ORG', 'MEMBER']),
  approverPosition: z.string().nullable(),
  approverMember: z.string().nullable(),
  slaBusinessHours: z.coerce.number().int().min(1),
  descriptionTh: z.string().nullable(),
})
const RequestTypeRow = z.object({
  code: z.string().regex(/^[A-Z_]{2,30}$/),
  nameTh: text,
  documentType: z.enum(['PURCHASE_REQUEST', 'SUPPLIER_REQUEST']),
  descriptionTh: z.string().nullable(),
  keyFields: z.string().nullable(),
  attachmentRule: z.string().nullable(),
  active: yesNo,
})
const HolidayRow = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), nameTh: text, source: z.string().nullable() })

const DoaPolicy = z.object({
  code: text,
  version: z.coerce.number().int().min(1),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  amountBasis: z.enum(['GROSS', 'NET']),
  selfApprovalPolicy: z.enum(['ESCALATE_NEXT_BAND', 'BLOCK']),
  collapseDuplicateApprovers: yesNo,
  stepUpThreshold: bahtOrNull,
  approverMayReceive: yesNo,
  requesterMayReceive: yesNo,
  remindPct: z.coerce.number().min(0).max(1),
  escalateAfterBusinessHours: z.coerce.number().int().min(0),
})

export interface OrgStructureInput {
  readonly departments: z.infer<typeof DepartmentRow>[]
  readonly positions: z.infer<typeof PositionRow>[]
}

export interface DoaInput {
  readonly policy: z.infer<typeof DoaPolicy>
  readonly rules: z.infer<typeof DoaRow>[]
}

export function parseOrgStructure(workbook: InputWorkbook): OrgStructureInput {
  const departments = rows(workbook, 'Departments', DepartmentRow)
  const codes = new Set(departments.map((d) => d.code))
  if (codes.size !== departments.length) throw new Error('Departments: duplicate code')
  const roots = departments.filter((d) => d.parent === null)
  if (roots.length !== 1) throw new Error(`Departments: exactly one root (no parent) is needed, found ${roots.length}`)
  for (const d of departments) if (d.parent !== null && !codes.has(d.parent)) throw new Error(`Departments: ${d.code} has unknown parent ${d.parent}`)
  // No loops: walking up from every department reaches the root
  for (const d of departments) {
    const seen = new Set<string>()
    for (let p: string | null = d.code; p !== null; p = departments.find((x) => x.code === p)!.parent) {
      if (seen.has(p)) throw new Error(`Departments: ${d.code} is its own ancestor`)
      seen.add(p)
    }
  }
  const positions = rows(workbook, 'Positions', PositionRow)
  if (new Set(positions.map((p) => p.code)).size !== positions.length) throw new Error('Positions: duplicate code')
  return { departments, positions }
}

export function parseDoa(workbook: InputWorkbook): DoaInput {
  const kv = workbook.keyValues('DOA_Policy')
  const raw = Object.fromEntries([...kv].map(([key, { value }]) => [key, value]))
  const policy = DoaPolicy.safeParse(raw)
  if (!policy.success) throw new Error(`DOA_Policy: ${issueText(policy.error)}`)
  const rules = rows(workbook, 'DOA', DoaRow)
  for (const r of rules) {
    if (r.approverKind === 'MEMBER' ? !r.approverMember : !r.approverPosition) throw new Error(`DOA ${r.ruleCode}: approver ${r.approverKind === 'MEMBER' ? 'member' : 'position'} is missing`)
  }
  if (new Set(rules.map((r) => `${r.version}:${r.ruleCode}`)).size !== rules.length) throw new Error('DOA: duplicate rule code within a version')
  return { policy: policy.data, rules }
}

/** The DOA version of the sheets as an engine snapshot (status PUBLISHED, no end date), for the seed and its tests. */
export function doaSnapshot(doa: DoaInput, id: string): DoaVersionSnapshot {
  const rules: DoaRuleSnapshot[] = doa.rules
    .filter((r) => r.version === doa.policy.version)
    .map((r) => ({
      code: r.ruleCode,
      documentType: r.documentType,
      priority: 100,
      when: r.gt === null && r.lte === null ? {} : { amount: { ...(r.gt !== null ? { gt: r.gt } : {}), ...(r.lte !== null ? { lte: r.lte } : {}) } },
      steps: [
        {
          approver: r.approverKind === 'MEMBER' ? { kind: 'MEMBER', memberId: r.approverMember! } : { kind: r.approverKind, position: r.approverPosition! },
          slaBusinessMinutes: r.slaBusinessHours * 60,
          mode: 'SEQUENTIAL',
        },
      ],
      ...(r.descriptionTh ? { descriptionTh: r.descriptionTh } : {}),
    }))
  return {
    id,
    code: doa.policy.code,
    versionNo: doa.policy.version,
    status: 'PUBLISHED',
    effectiveFrom: new Date(doa.policy.effectiveFrom.length === 10 ? `${doa.policy.effectiveFrom}T00:00:00+07:00` : doa.policy.effectiveFrom),
    effectiveTo: null,
    amountBasis: doa.policy.amountBasis,
    selfApprovalPolicy: doa.policy.selfApprovalPolicy,
    collapseDuplicateApprovers: doa.policy.collapseDuplicateApprovers,
    rules,
  }
}

export function parseRequestTypes(workbook: InputWorkbook): z.infer<typeof RequestTypeRow>[] {
  const types = rows(workbook, 'RequestTypes', RequestTypeRow)
  if (new Set(types.map((t) => t.code)).size !== types.length) throw new Error('RequestTypes: duplicate code')
  return types
}

export function parseHolidays(workbook: InputWorkbook): z.infer<typeof HolidayRow>[] {
  const holidays = rows(workbook, 'Holidays', HolidayRow)
  if (new Set(holidays.map((h) => h.date)).size !== holidays.length) throw new Error('Holidays: duplicate date')
  return holidays
}

const BudgetRow = z.object({
  fiscalYear: z.string().regex(/^FY\d{4}$/),
  code: z.string().regex(/^[A-Z0-9_-]{2,50}$/),
  nameTh: text,
  department: z.string().regex(/^[A-Z0-9_]{2,20}$/),
  costCenter: z.string().regex(/^[A-Z0-9_-]{2,50}$/),
  accountCode: z.string().nullable(),
  planned: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
})

/** Sheet Budget (S3-04): one budget line per row with its planned amount; usedDemo is reached by the demo history (D-01) */
export function parseBudget(workbook: InputWorkbook): z.infer<typeof BudgetRow>[] {
  const lines = rows(workbook, 'Budget', BudgetRow)
  if (new Set(lines.map((l) => `${l.fiscalYear}|${l.code}`)).size !== lines.length) throw new Error('Budget: duplicate code in a fiscal year')
  return lines
}

const SupplierRow = z.object({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/),
  nameTh: text,
  taxId: z.string().regex(/^\d{13}$/).refine(isValidThaiTaxId, 'tax id fails the mod-11 check (BR-TAXID-01)'),
  branchCode: z.string().regex(/^\d{5}$/),
  vatRegistered: yesNo,
  email: z.email().nullable(),
  phone: z.string().nullable(),
  category: z.string().nullable(),
  expressVendorCode: z.string().nullable(),
})
const SiteRow = z.object({ code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/), nameTh: text, address: z.string().nullable() })

/** Sheet Suppliers (S4-02): one supplier per row; tax ids pass mod-11 and (tax id, branch) is unique */
export function parseSuppliers(workbook: InputWorkbook): z.infer<typeof SupplierRow>[] {
  const suppliers = rows(workbook, 'Suppliers', SupplierRow)
  if (new Set(suppliers.map((s) => s.code)).size !== suppliers.length) throw new Error('Suppliers: duplicate code')
  if (new Set(suppliers.map((s) => `${s.taxId}|${s.branchCode}`)).size !== suppliers.length) throw new Error('Suppliers: duplicate tax id and branch')
  return suppliers
}

/** Sheet Sites (S4-02): the delivery sites consolidation groups by (BR-CONS-01) */
export function parseSites(workbook: InputWorkbook): z.infer<typeof SiteRow>[] {
  const sites = rows(workbook, 'Sites', SiteRow)
  if (new Set(sites.map((s) => s.code)).size !== sites.length) throw new Error('Sites: duplicate code')
  return sites
}

const HistoryRow = z.object({
  ref: z.string().regex(/^H\d{2}$/),
  daysAgo: z.coerce.number().int().min(0).max(366),
  requester: z.string().regex(/^[a-z0-9_]{2,40}$/),
  chargedDept: z.string().regex(/^[A-Z0-9_]{2,20}$/),
  requestType: z.string().regex(/^[A-Z_]{2,30}$/),
  title: text,
  site: z.string().nullable(),
  supplier: z.string().nullable(),
  budgetLine: z.string().regex(/^[A-Z0-9_-]{2,50}$/),
  /** Whole baht before VAT; VAT, gross and what counts against the budget are formulas the services compute again */
  net: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  status: z.enum(['COMPLETED', 'ORDERED', 'APPROVED', 'PENDING_APPROVAL', 'RETURNED', 'REJECTED', 'CANCELLED']),
  expectedRule: z.string().nullable(),
  expectedApprover: z.string().nullable(),
  escalated: yesNo,
  /** Business hours to the decision, or — still pending — waited by the time of the seed */
  hours: z.coerce.number().int().min(0).max(200),
  channel: z.enum(['LINE_CHAT', 'LIFF', 'WEB']).nullable(),
  note: z.string().nullable(),
})
export type DemoHistoryRow = z.infer<typeof HistoryRow>

/** Sheet Demo_History (D-01): requests of the past, created by the seed through the services with the clock set back */
export function parseDemoHistory(workbook: InputWorkbook): DemoHistoryRow[] {
  const history = rows(workbook, 'Demo_History', HistoryRow)
  if (new Set(history.map((h) => h.ref)).size !== history.length) throw new Error('Demo_History: duplicate ref')
  for (const h of history) {
    // Only a decision has a channel: a request still waiting or taken back by its requester has none
    const decided = h.status !== 'PENDING_APPROVAL' && h.status !== 'CANCELLED'
    if (decided !== (h.channel !== null)) throw new Error(`Demo_History ${h.ref}: a decided request needs its channel, a pending or cancelled one has none`)
    // §9.3: the chat button only approves; a rejection or a return is decided in LIFF or on the web with its reason
    if (h.channel === 'LINE_CHAT' && (h.status === 'REJECTED' || h.status === 'RETURNED')) throw new Error(`Demo_History ${h.ref}: a ${h.status.toLowerCase()} request is decided in LIFF or on the web, not in the chat`)
    if (!h.expectedRule || !h.expectedApprover) throw new Error(`Demo_History ${h.ref}: the expected rule and approver are needed`)
  }
  return history
}

import { normalizeTaxId } from '@/core/thai/taxid'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'

// Read models of the supplier register (S4-02, spec §6.2 Supplier, FR-SUP-001). Queries never check permissions (they
// cannot import authz): src/server/services/suppliers/view.ts checks supplier.view, and decides which of these fields a
// reader may see (§2.4: every member the name and basic details, PROCUREMENT FINANCE AUDITOR everything), before
// anything reaches a screen.

export type SupplierStatusDto = 'ACTIVE' | 'INACTIVE'
export type RegistrySourceDto = 'RD' | 'DBD' | 'MANUAL' | 'STUB'

export interface SupplierRecordDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  /** 13 digits; null only for a foreign supplier */
  readonly taxId: string | null
  /** "00000" = head office */
  readonly branchCode: string
  readonly isVatRegistered: boolean
  readonly isForeign: boolean
  /** Where purchase orders are e-mailed */
  readonly email: string | null
  readonly phone: string | null
  readonly address: string | null
  readonly category: string | null
  readonly status: SupplierStatusDto
  /** The AP code of the supplier in Express; the export leaves out suppliers without one (BR-EXP-04) */
  readonly expressVendorCode: string | null
  readonly registrySource: RegistrySourceDto | null
  /** The juristic status the registry reported (BR-SUP-04) */
  readonly registryStatus: string | null
  readonly registryCheckedAt: Date | null
  /** §6.1: edits name the version they were based on */
  readonly version: number
}

const RECORD_SELECT = {
  id: true,
  code: true,
  nameTh: true,
  nameEn: true,
  taxId: true,
  branchCode: true,
  isVatRegistered: true,
  isForeign: true,
  email: true,
  phone: true,
  address: true,
  category: true,
  status: true,
  expressVendorCode: true,
  registrySource: true,
  registryStatus: true,
  registryCheckedAt: true,
  version: true,
} as const

/**
 * How the search matches tax ids, for a reader who may see them: ANY_PART — digits anywhere in any number;
 * WHOLE_FOR_INDIVIDUALS — BR-AUTH-04, for a reader who sees an individual's number (their national id number) masked:
 * digits anywhere in a juristic person's or a foreign supplier's number, but an individual's number only when all 13
 * digits are typed, so its hidden digits cannot be found out by searching
 */
export type TaxIdMatch = 'ANY_PART' | 'WHOLE_FOR_INDIVIDUALS'

export interface SupplierSearch {
  /** Part of the name (Thai or English) or the code; with `taxIdMatch`, digits of the tax id as well */
  readonly q?: string
  readonly status?: SupplierStatusDto | null
  /** Only suppliers without an Express vendor code (BR-EXP-04) */
  readonly missingExpressCode?: boolean
  /** Match the tax id too: only for readers who may see it */
  readonly taxIdMatch?: TaxIdMatch | null
  readonly limit?: number
}

/** The register lists at most this many suppliers at once; the search reaches the rest */
export const SUPPLIER_LIST_LIMIT = 200
/** Longest search text taken */
export const SUPPLIER_SEARCH_MAX = 60
const DIGITS = /^\d{1,13}$/
const WHOLE_TAX_ID = /^\d{13}$/
/** BR-SUP-02: a Thai juristic person's tax id starts with 0 (isJuristicTaxId of src/integrations/registry) */
const JURISTIC_PREFIX = '0'

function taxIdClauses(match: TaxIdMatch | null | undefined, digits: string) {
  if (!match || !DIGITS.test(digits)) return []
  if (match === 'ANY_PART') return [{ taxId: { contains: digits } }]
  return [
    { isForeign: true, taxId: { contains: digits } },
    { isForeign: false, taxId: { startsWith: JURISTIC_PREFIX, contains: digits } },
    ...(WHOLE_TAX_ID.test(digits) ? [{ taxId: digits }] : []),
  ]
}

export async function searchSuppliers(ctx: Ctx, search: SupplierSearch): Promise<{ rows: SupplierRecordDto[]; total: number; matched: number }> {
  const db = forTenant(ctx.organizationId)
  const q = (search.q ?? '').trim().slice(0, SUPPLIER_SEARCH_MAX)
  // A tax id is written with or without dashes and spaces (BR-TAXID-01)
  const digits = normalizeTaxId(q)
  const text = q
    ? [
        {
          OR: [
            { nameTh: { contains: q, mode: 'insensitive' as const } },
            { nameEn: { contains: q, mode: 'insensitive' as const } },
            { code: { contains: q, mode: 'insensitive' as const } },
            ...taxIdClauses(search.taxIdMatch, digits),
          ],
        },
      ]
    : []
  const where = {
    AND: [
      ...text,
      ...(search.status ? [{ status: search.status }] : []),
      ...(search.missingExpressCode ? [{ OR: [{ expressVendorCode: null }, { expressVendorCode: '' }] }] : []),
    ],
  }
  const [total, matched, rows] = await Promise.all([
    db.supplier.count(),
    db.supplier.count({ where }),
    db.supplier.findMany({ where, select: RECORD_SELECT, orderBy: [{ status: 'asc' }, { code: 'asc' }], take: Math.min(search.limit ?? SUPPLIER_LIST_LIMIT, SUPPLIER_LIST_LIMIT) }),
  ])
  return { rows, total, matched }
}

export interface SupplierProofDto {
  readonly fileId: string
  readonly fileName: string
  readonly sizeBytes: number
}

export interface SupplierFullRecordDto extends SupplierRecordDto {
  /** What the registries said when the supplier was saved, kept to compare (BR-SUP-01): { mode, rd, dbd } */
  readonly registryData: unknown
  /** Company certificates or ภ.พ.20 attached when a person confirmed the supplier (BR-SUP-03) */
  readonly proofs: readonly SupplierProofDto[]
}

export async function getSupplierRecord(ctx: Ctx, supplierId: string): Promise<SupplierFullRecordDto | null> {
  const db = forTenant(ctx.organizationId)
  const row = await db.supplier.findUnique({ where: { id: supplierId }, select: { ...RECORD_SELECT, registryData: true } })
  if (!row) return null
  const links = await db.fileLink.findMany({
    where: { subjectType: 'Supplier', subjectId: row.id, kind: 'REGISTRY_PROOF' },
    select: { file: { select: { id: true, fileName: true, sizeBytes: true, status: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return { ...row, proofs: links.filter((l) => l.file.status === 'AVAILABLE').map((l) => ({ fileId: l.file.id, fileName: l.file.fileName, sizeBytes: l.file.sizeBytes })) }
}

/** The supplier that already has this tax id and branch, if any ((tax id, branch) is unique, §6.2) */
export async function findSupplierByTaxId(ctx: Ctx, taxId: string, branchCode: string): Promise<{ id: string; code: string; nameTh: string } | null> {
  return forTenant(ctx.organizationId).supplier.findFirst({ where: { taxId, branchCode }, select: { id: true, code: true, nameTh: true } })
}

/** Every supplier code of the organization, to suggest the next one */
export async function listSupplierCodes(ctx: Ctx): Promise<string[]> {
  return (await forTenant(ctx.organizationId).supplier.findMany({ select: { code: true } })).map((s) => s.code)
}

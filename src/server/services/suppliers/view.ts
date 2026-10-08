import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { authorize, loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { describeError } from '@/server/errors/describe'
import {
  findSupplierByTaxId,
  getSupplierRecord,
  listSupplierCodes,
  searchSuppliers,
  SUPPLIER_LIST_LIMIT,
  type RegistrySourceDto,
  type SupplierProofDto,
  type SupplierRecordDto,
  type SupplierStatusDto,
  type TaxIdMatch,
} from '@/server/queries/suppliers'
import { isIndividualTaxId, supplierAccess, visibleTaxId, type SupplierAccess } from './access'
import { suggestSupplierCode } from './codes'
import './file-policy'
import { lookupRegistry, type RegistryProposal } from './index'

// The supplier register as its screens show it (S4-02, FR-SUP-001, §9.1 /suppliers): supplier.view is checked here, on
// every read, and decides which fields leave the server (§2.4: every member the name and basic details; PROCUREMENT,
// FINANCE and AUDITOR everything; BR-AUTH-04 masks an individual's tax id for a reader who sees it only as AUDITOR, and
// that reader's search does not find it by its hidden digits).
// Read only: adding, editing and deactivating go through the commands of ./index.ts (supplier.manage).

export type RegistryAnswerStatus = 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE' | 'SKIPPED'

/** Basic details: what every member may see (§2.4 supplier.view BASIC_FIELDS_ONLY) */
export interface SupplierBasicDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly branchCode: string
  readonly category: string | null
  readonly status: SupplierStatusDto
  readonly isVatRegistered: boolean
  readonly isForeign: boolean
}

export interface SupplierListRowDto extends SupplierBasicDto {
  /** Readers who see the register in full only */
  readonly full: {
    readonly taxId: string | null
    /** BR-AUTH-04: shown with all but the last four digits replaced */
    readonly taxIdMasked: boolean
    readonly expressVendorCode: string | null
    readonly registrySource: RegistrySourceDto | null
  } | null
}

export interface SupplierListDto {
  readonly level: SupplierAccess['level']
  readonly canManage: boolean
  /** How the search matches tax ids for this reader; null: not at all (BASIC) */
  readonly taxIdMatch: TaxIdMatch | null
  readonly rows: readonly SupplierListRowDto[]
  /** All suppliers of the organization, so the screen can tell "none yet" from "none match" */
  readonly total: number
  readonly matched: number
  /** The list stops at SUPPLIER_LIST_LIMIT; the search reaches the rest */
  readonly limit: number
}

/** What the registries said when the supplier was saved (Supplier.registryData, BR-SUP-01) */
export interface RegistryRecordedDto {
  readonly mode: 'stub' | 'live' | null
  readonly rd: RegistryAnswerStatus
  readonly dbd: RegistryAnswerStatus
  readonly nameTh: string | null
  readonly address: string | null
  readonly vatRegistered: boolean | null
  readonly juristicStatus: string | null
}

export interface SupplierDetailDto {
  readonly level: SupplierAccess['level']
  readonly canManage: boolean
  readonly supplier: SupplierBasicDto & { readonly version: number }
  readonly full: {
    readonly taxId: string | null
    readonly taxIdMasked: boolean
    /** BR-SUP-02: a Thai individual, checked at the Revenue Department only */
    readonly individual: boolean
    readonly address: string | null
    readonly email: string | null
    readonly phone: string | null
    readonly expressVendorCode: string | null
    readonly registry: {
      readonly source: RegistrySourceDto | null
      /** ISO 8601 UTC */
      readonly checkedAt: string | null
      readonly juristicStatus: string | null
      readonly recorded: RegistryRecordedDto | null
    }
    /** BR-SUP-03 proofs; none for a reader who sees the tax id masked (the proof carries it) */
    readonly proofs: readonly SupplierProofDto[]
  } | null
}

const STATUSES: readonly SupplierStatusDto[] = ['ACTIVE', 'INACTIVE']

async function accessOf(ctx: Ctx): Promise<SupplierAccess | null> {
  const principal = await forTenant(ctx.organizationId).$transaction((tx) => loadPrincipal(tx, ctx))
  return supplierAccess(principal)
}

const forbidden = () => err('FORBIDDEN', 'missing capability supplier.view', { capability: 'supplier.view' })

function basicOf(s: SupplierRecordDto): SupplierBasicDto {
  return { id: s.id, code: s.code, nameTh: s.nameTh, nameEn: s.nameEn, branchCode: s.branchCode, category: s.category, status: s.status, isVatRegistered: s.isVatRegistered, isForeign: s.isForeign }
}

const byStatusThenName = (a: SupplierBasicDto, b: SupplierBasicDto) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.nameTh.localeCompare(b.nameTh, 'th') || a.code.localeCompare(b.code)

/**
 * How a reader's search matches tax ids: never for a reader who may not see them; a reader who sees individuals' numbers
 * masked (BR-AUTH-04) finds an individual only by the whole number, so the hidden digits cannot be searched out
 */
export const taxIdMatchOf = (access: SupplierAccess): TaxIdMatch | null => (access.level !== 'FULL' ? null : access.maskIndividualTaxIds ? 'WHOLE_FOR_INDIVIDUALS' : 'ANY_PART')

/** /suppliers: search by name or code, and by tax id for those who may see it; filter by status and a missing Express code */
export async function listSuppliersForScreen(ctx: Ctx, filter: { q?: string; status?: string; missingExpressCode?: boolean }): Promise<Result<SupplierListDto>> {
  const access = await accessOf(ctx)
  if (!access) return forbidden()
  const full = access.level === 'FULL'
  const taxIdMatch = taxIdMatchOf(access)
  const status = STATUSES.find((s) => s === filter.status) ?? null
  const found = await searchSuppliers(ctx, { q: filter.q, status, missingExpressCode: full && filter.missingExpressCode === true, taxIdMatch })
  const rows = found.rows.map((s): SupplierListRowDto => {
    const taxId = visibleTaxId(access, s)
    return { ...basicOf(s), full: taxId ? { taxId: taxId.taxId, taxIdMasked: taxId.masked, expressVendorCode: s.expressVendorCode, registrySource: s.registrySource } : null }
  })
  return ok({ level: access.level, canManage: access.canManage, taxIdMatch, rows: rows.sort(byStatusThenName), total: found.total, matched: found.matched, limit: SUPPLIER_LIST_LIMIT })
}

const RegistryRecord = z.object({
  nameTh: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  vatRegistered: z.boolean().optional(),
  juristicStatus: z.string().optional(),
})
const Answer = z.union([
  z.object({ status: z.literal('FOUND'), record: RegistryRecord }),
  z.object({ status: z.enum(['NOT_FOUND', 'UNAVAILABLE', 'SKIPPED']) }),
])
const RegistryData = z.object({ mode: z.enum(['stub', 'live']).optional(), rd: Answer, dbd: Answer })

/** The registry answers kept with the supplier, as the screen compares them; null when none were kept */
export function recordedRegistry(data: unknown): RegistryRecordedDto | null {
  const parsed = RegistryData.safeParse(data)
  if (!parsed.success) return null
  const { rd, dbd, mode } = parsed.data
  const rdRecord = rd.status === 'FOUND' ? rd.record : null
  const dbdRecord = dbd.status === 'FOUND' ? dbd.record : null
  return {
    mode: mode ?? null,
    rd: rd.status,
    dbd: dbd.status,
    nameTh: rdRecord?.nameTh ?? dbdRecord?.nameTh ?? null,
    address: rdRecord?.address ?? dbdRecord?.address ?? null,
    vatRegistered: rdRecord?.vatRegistered ?? null,
    juristicStatus: dbdRecord?.juristicStatus ?? null,
  }
}

const UUID = z.uuid()

/** /suppliers/[id]: NOT_FOUND for an id that is not a supplier of the organization */
export async function getSupplierForScreen(ctx: Ctx, supplierId: string): Promise<Result<SupplierDetailDto>> {
  const access = await accessOf(ctx)
  if (!access) return forbidden()
  if (!UUID.safeParse(supplierId).success) return err('NOT_FOUND', 'supplier not found')
  const s = await getSupplierRecord(ctx, supplierId)
  if (!s) return err('NOT_FOUND', 'supplier not found')
  const taxId = visibleTaxId(access, s)
  return ok({
    level: access.level,
    canManage: access.canManage,
    supplier: { ...basicOf(s), version: s.version },
    full: taxId
      ? {
          taxId: taxId.taxId,
          taxIdMasked: taxId.masked,
          individual: isIndividualTaxId(s.taxId, s.isForeign),
          address: s.address,
          email: s.email,
          phone: s.phone,
          expressVendorCode: s.expressVendorCode,
          registry: { source: s.registrySource, checkedAt: s.registryCheckedAt?.toISOString() ?? null, juristicStatus: s.registryStatus, recorded: recordedRegistry(s.registryData) },
          proofs: taxId.masked ? [] : s.proofs,
        }
      : null,
  })
}

export interface NewSupplierContextDto {
  /** A code to start from (suggestSupplierCode) */
  readonly suggestedCode: string | null
  /** BR-SUP-05: stub answers from fixtures (locally, in tests and in the demo); live calls the real services */
  readonly registryMode: 'stub' | 'live'
}

/** /suppliers/new: PROCUREMENT only (§2.4 supplier.manage) */
export async function getNewSupplierContext(ctx: Ctx): Promise<Result<NewSupplierContextDto>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'supplier.manage'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  return ok({ suggestedCode: suggestSupplierCode(await listSupplierCodes(ctx)), registryMode: getEnv().REGISTRY_MODE === 'live' ? 'live' : 'stub' })
}

export interface NewSupplierCheckDto {
  readonly proposal: RegistryProposal
  /** The supplier that already has this tax id and branch: saving another would be refused (SUPPLIER_EXISTS) */
  readonly existing: { readonly id: string; readonly code: string; readonly nameTh: string } | null
}

/**
 * FR-SUP-001 AC1 on the screen: what the registries say about a tax id and branch (lookupRegistry, PROCUREMENT only, the
 * checksum checked again here), and whether the register has that supplier already. Nothing is written; the save checks
 * the registries again on the server (createSupplier). Registries that cannot be reached answer UNAVAILABLE, so the user
 * confirms with proof (BR-SUP-03); any other failure is ours: the caller gets a reference, the log the error's codes and
 * stack frames, never its text (FR-PLT-008 AC3).
 */
export async function checkNewSupplier(ctx: Ctx, input: { taxId: string; branchCode?: string }): Promise<Result<NewSupplierCheckDto>> {
  try {
    const looked = await lookupRegistry(ctx, input)
    if (!looked.ok) return looked
    return ok({ proposal: looked.data, existing: await findSupplierByTaxId(ctx, looked.data.taxId, looked.data.branchCode) })
  } catch (error) {
    logger.child({ requestId: ctx.requestId, organizationId: ctx.organizationId, view: 'supplier.check' }).error({ error: describeError(error) }, 'the new-supplier check failed unexpectedly')
    return err('INTERNAL', 'unexpected error', { requestId: ctx.requestId })
  }
}

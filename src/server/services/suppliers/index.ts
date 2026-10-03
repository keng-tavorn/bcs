import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { isValidThaiTaxId, normalizeTaxId } from '@/core/thai/taxid'
import { getRegistryProvider, isJuristicTaxId, type RegistryAnswer } from '@/integrations/registry'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// The supplier register, tier 1 (spec §6.2 Supplier, §2.4 supplier.manage = PROCUREMENT): a Thai supplier's tax id
// passes mod-11 (BR-TAXID-01, written with or without dashes and spaces) and (tax id, branch) is unique; a foreign
// supplier may have no Thai tax id. The Express vendor code is kept for the AP file (BR-EXP-04). Changes are checked
// against the version the user saw (§6.1 optimistic lock).

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT_VERSION'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const Code = z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/)
const Name = z.string().trim().min(1).max(200)
const Optional = (max: number) => z.string().trim().min(1).max(max).nullable()
const Fields = {
  nameTh: Name,
  nameEn: Optional(200),
  branchCode: z.string().regex(/^\d{5}$/),
  isVatRegistered: z.boolean(),
  email: z.email().max(200).nullable(),
  phone: Optional(50),
  address: Optional(500),
  category: Optional(200),
  expressVendorCode: Optional(50),
  status: z.enum(['ACTIVE', 'INACTIVE']),
}

/** BR-TAXID-01: a Thai supplier needs a valid 13-digit tax id; a foreign one may have none (or its own) */
function checkTaxId(taxId: string | null | undefined, isForeign: boolean): { ok: true; taxId: string | null } | ReturnType<typeof fail> {
  if (isForeign) return { ok: true, taxId: taxId?.trim() || null }
  const normalized = normalizeTaxId(taxId ?? '')
  if (!isValidThaiTaxId(normalized)) return fail('VALIDATION_FAILED', 'the tax id is not a valid Thai tax id', { field: 'taxId', reason: 'TAX_ID_INVALID' })
  return { ok: true, taxId: normalized }
}

async function duplicateOf(tx: TenantTx, taxId: string | null, branchCode: string, exceptId?: string) {
  if (!taxId) return null
  return tx.supplier.findFirst({ where: { taxId, branchCode, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, code: true } })
}

// ---------- registry (§7.15, FR-SUP-001 AC1–AC3) ----------

export interface RegistryProposal {
  readonly taxId: string
  readonly branchCode: string
  /** FOUND: filled from a registry; NOT_FOUND or UNAVAILABLE: a person confirms with proof (BR-SUP-03) */
  readonly outcome: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE'
  readonly sources: ReadonlyArray<'RD' | 'DBD' | 'STUB'>
  readonly nameTh: string | null
  readonly address: string | null
  readonly isVatRegistered: boolean | null
  readonly juristicStatus: string | null
  /** BR-SUP-02: an individual is checked at RD only */
  readonly individual: boolean
}

/** What the registries say about a tax id and branch, read by the server (never taken from the browser) */
async function checkRegistry(taxId: string, branchCode: string): Promise<{ proposal: RegistryProposal; data: Record<string, unknown> }> {
  const provider = getRegistryProvider()
  const { rd, dbd } = await provider.lookup({ taxId, branchCode })
  const found = [rd, dbd].filter((a): a is Extract<RegistryAnswer, { status: 'FOUND' }> => a.status === 'FOUND')
  const outcome = found.length ? 'FOUND' : [rd, dbd].some((a) => a.status === 'UNAVAILABLE') ? 'UNAVAILABLE' : 'NOT_FOUND'
  const sourceOf = (which: 'RD' | 'DBD'): 'RD' | 'DBD' | 'STUB' => (provider.mode === 'stub' ? 'STUB' : which)
  const sources = [...new Set([...(rd.status === 'FOUND' ? [sourceOf('RD')] : []), ...(dbd.status === 'FOUND' ? [sourceOf('DBD')] : [])])]
  const first = found[0]?.record
  return {
    proposal: {
      taxId,
      branchCode,
      outcome,
      sources,
      nameTh: first?.nameTh ?? null,
      address: first?.address ?? null,
      isVatRegistered: rd.status === 'FOUND' ? (rd.record.vatRegistered ?? null) : null,
      juristicStatus: dbd.status === 'FOUND' ? (dbd.record.juristicStatus ?? null) : null,
      individual: !isJuristicTaxId(taxId),
    },
    data: { mode: provider.mode, rd, dbd },
  }
}

/** FR-SUP-001 AC1: type a tax id and get the registry's values to confirm; PROCUREMENT only */
export async function lookupRegistry(ctx: Ctx, input: { taxId: string; branchCode?: string }): Promise<Result<RegistryProposal>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'supplier.manage'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const taxId = normalizeTaxId(input.taxId)
  if (!isValidThaiTaxId(taxId)) return err('VALIDATION_FAILED', 'the tax id is not a valid Thai tax id', { field: 'taxId', reason: 'TAX_ID_INVALID' })
  const branchCode = input.branchCode ?? '00000'
  if (!/^\d{5}$/.test(branchCode)) return err('VALIDATION_FAILED', 'the branch is five digits', { field: 'branchCode', reason: 'BRANCH' })
  return ok((await checkRegistry(taxId, branchCode)).proposal)
}

// ---------- create ----------

const CreateSupplierInput = z.strictObject({
  code: Code,
  nameTh: Fields.nameTh,
  nameEn: Fields.nameEn.optional(),
  taxId: z.string().max(40).nullable().optional(),
  branchCode: Fields.branchCode.default('00000'),
  isVatRegistered: Fields.isVatRegistered.default(true),
  isForeign: z.boolean().default(false),
  email: Fields.email.optional(),
  phone: Fields.phone.optional(),
  address: Fields.address.optional(),
  category: Fields.category.optional(),
  expressVendorCode: Fields.expressVendorCode.optional(),
  /**
   * BR-SUP-01 to BR-SUP-03: LOOKUP checks the registries again on the server and keeps what they said; MANUAL is for
   * when they cannot confirm the supplier and needs a proof file (FileLink REGISTRY_PROOF). A foreign supplier skips it.
   */
  registry: z.discriminatedUnion('check', [z.strictObject({ check: z.literal('LOOKUP') }), z.strictObject({ check: z.literal('MANUAL'), proofFileId: z.uuid() })]).optional(),
})

export const createSupplierCommand = defineCommand({
  name: 'supplier.create',
  capability: 'supplier.manage',
  input: CreateSupplierInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ supplierId: string }>> {
    const ok = await authorize(tx, ctx, 'supplier.manage')
    if (!ok.ok) return { ok: false, error: ok.error }
    const taxId = checkTaxId(input.taxId, input.isForeign)
    if (!taxId.ok) return taxId
    if (await tx.supplier.findFirst({ where: { code: input.code }, select: { id: true } })) return fail('VALIDATION_FAILED', 'the code is in use', { field: 'code', reason: 'CODE_EXISTS' })
    const same = await duplicateOf(tx, taxId.taxId, input.branchCode)
    if (same) return fail('VALIDATION_FAILED', 'a supplier with this tax id and branch exists', { field: 'taxId', reason: 'SUPPLIER_EXISTS', supplierId: same.id, code: same.code })
    // §7.15: a Thai supplier is checked against the registries, or confirmed by a person with proof
    let registry: { source: 'RD' | 'DBD' | 'MANUAL' | 'STUB'; status: string | null; data: Record<string, unknown>; outcome: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE'; sources: Array<'RD' | 'DBD' | 'MANUAL' | 'STUB'>; proofFileId: string | null } | null = null
    if (!input.isForeign && taxId.taxId) {
      if (!input.registry) return fail('VALIDATION_FAILED', 'check the registries or confirm with proof', { field: 'registry', reason: 'REGISTRY_CHECK_REQUIRED' })
      const checked = await checkRegistry(taxId.taxId, input.branchCode)
      if (input.registry.check === 'LOOKUP') {
        if (checked.proposal.outcome !== 'FOUND') return fail('VALIDATION_FAILED', 'the registries could not confirm the supplier: attach proof', { field: 'registry', reason: 'REGISTRY_PROOF_REQUIRED', outcome: checked.proposal.outcome })
        registry = { source: checked.proposal.sources[0] as 'RD' | 'DBD' | 'STUB', status: checked.proposal.juristicStatus, data: checked.data, outcome: 'FOUND', sources: [...checked.proposal.sources], proofFileId: null }
      } else {
        const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
        const own = await tx.fileObject.count({ where: { id: input.registry.proofFileId, uploadedById: actor ?? undefined, status: 'AVAILABLE' } })
        if (own !== 1) return fail('VALIDATION_FAILED', 'the proof must be a file you uploaded', { field: 'registry.proofFileId', reason: 'FILE' })
        registry = { source: 'MANUAL', status: checked.proposal.juristicStatus, data: checked.data, outcome: checked.proposal.outcome, sources: ['MANUAL'], proofFileId: input.registry.proofFileId }
      }
    }
    const row = await tx.supplier.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        nameTh: input.nameTh,
        nameEn: input.nameEn ?? null,
        taxId: taxId.taxId,
        branchCode: input.branchCode,
        isVatRegistered: input.isVatRegistered,
        isForeign: input.isForeign,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        category: input.category ?? null,
        expressVendorCode: input.expressVendorCode ?? null,
        createdById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
        ...(registry ? { registrySource: registry.source, registryStatus: registry.status, registryCheckedAt: ctx.now, registryData: registry.data as object } : {}),
      },
      select: { id: true },
    })
    if (registry?.proofFileId) await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: registry.proofFileId, subjectType: 'Supplier', subjectId: row.id, kind: 'REGISTRY_PROOF' } })
    const events: EventDraft[] = [
      {
        type: 'supplier.created',
        aggregateType: 'Supplier',
        aggregateId: row.id,
        data: { code: input.code, taxId: taxId.taxId, branchCode: input.branchCode, isForeign: input.isForeign, registrySource: registry?.source ?? null, via: 'PROCUREMENT' },
      },
    ]
    if (registry) events.push({ type: 'supplier.registry_checked', aggregateType: 'Supplier', aggregateId: row.id, data: { taxId: taxId.taxId!, branchCode: input.branchCode, sources: registry.sources, outcome: registry.outcome } })
    return { ok: true, result: { supplierId: row.id }, events }
  },
})

export function createSupplier(ctx: Ctx, input: z.input<typeof CreateSupplierInput>, options: RunOptions) {
  return runCommand(ctx, createSupplierCommand, input, options)
}

// ---------- update ----------

const UpdateSupplierInput = z.strictObject({
  supplierId: z.uuid(),
  /** The version the user saw (§6.1) */
  expectedVersion: z.number().int().min(0),
  nameTh: Fields.nameTh.optional(),
  nameEn: Fields.nameEn.optional(),
  taxId: z.string().max(40).nullable().optional(),
  branchCode: Fields.branchCode.optional(),
  isVatRegistered: Fields.isVatRegistered.optional(),
  email: Fields.email.optional(),
  phone: Fields.phone.optional(),
  address: Fields.address.optional(),
  category: Fields.category.optional(),
  expressVendorCode: Fields.expressVendorCode.optional(),
  status: Fields.status.optional(),
})

const EDITABLE = ['nameTh', 'nameEn', 'taxId', 'branchCode', 'isVatRegistered', 'email', 'phone', 'address', 'category', 'expressVendorCode', 'status'] as const

export const updateSupplierCommand = defineCommand({
  name: 'supplier.update',
  capability: 'supplier.manage',
  input: UpdateSupplierInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ supplierId: string; version: number }>> {
    const ok = await authorize(tx, ctx, 'supplier.manage')
    if (!ok.ok) return { ok: false, error: ok.error }
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId } })
    if (!supplier) return fail('NOT_FOUND', 'supplier not found')
    if (supplier.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the supplier changed since it was opened', { currentVersion: supplier.version })
    const next: Record<string, unknown> = {}
    if (input.taxId !== undefined) {
      const taxId = checkTaxId(input.taxId, supplier.isForeign)
      if (!taxId.ok) return taxId
      next.taxId = taxId.taxId
    }
    for (const key of EDITABLE) if (key !== 'taxId' && input[key] !== undefined) next[key] = input[key]
    const changed = EDITABLE.filter((key) => key in next && next[key] !== supplier[key])
    if (changed.length === 0) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NO_CHANGE' })
    if (changed.includes('taxId') || changed.includes('branchCode')) {
      const same = await duplicateOf(tx, (next.taxId as string | null | undefined) ?? supplier.taxId, (next.branchCode as string | undefined) ?? supplier.branchCode, supplier.id)
      if (same) return fail('VALIDATION_FAILED', 'a supplier with this tax id and branch exists', { field: 'taxId', reason: 'SUPPLIER_EXISTS', supplierId: same.id, code: same.code })
    }
    const data = Object.fromEntries(changed.map((key) => [key, next[key]]))
    // The version moves only if nobody saved in between (the row is not locked while the user edits)
    const saved = await tx.supplier.updateMany({ where: { id: supplier.id, version: supplier.version }, data: { ...data, version: { increment: 1 } } })
    if (saved.count !== 1) return fail('CONFLICT_VERSION', 'the supplier changed since it was opened')
    return {
      ok: true,
      result: { supplierId: supplier.id, version: supplier.version + 1 },
      events: [{ type: 'supplier.updated', aggregateType: 'Supplier', aggregateId: supplier.id, data: { code: supplier.code, changed: [...changed] } }],
    }
  },
})

export function updateSupplier(ctx: Ctx, input: z.input<typeof UpdateSupplierInput>, options: RunOptions) {
  return runCommand(ctx, updateSupplierCommand, input, options)
}

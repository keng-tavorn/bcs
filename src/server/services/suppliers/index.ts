import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { isValidThaiTaxId, normalizeTaxId } from '@/core/thai/taxid'
import { getRegistryProvider, isJuristicTaxId, type RegistryAnswer, type RegistryProvider } from '@/integrations/registry'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { describeError } from '@/server/errors/describe'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// The supplier register, tier 1 (spec §6.2 Supplier, §2.4 supplier.manage = PROCUREMENT): a Thai supplier's tax id
// passes mod-11 (BR-TAXID-01, written with or without dashes and spaces) and (tax id, branch) is unique; a foreign
// supplier may have no Thai tax id. A Thai supplier's identity — its tax id and branch — is checked against the
// registries, or confirmed by a person with proof, when it is added and again whenever it changes (BR-SUP-01 to
// BR-SUP-03). The Express vendor code is kept for the AP file (BR-EXP-04). Changes are checked against the version the
// user saw (§6.1 optimistic lock).

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

/**
 * What the registries say about a tax id and branch, read by the server (never taken from the browser). Registries that
 * cannot be reached — the service is down, or REGISTRY_MODE=live before S4-16 builds it (OQ-37) — answer UNAVAILABLE:
 * BR-SUP-03 does not block, a person confirms the supplier with proof. The failure is logged without the number (an
 * individual's tax id is their national id number, NFR-SEC-09) and without the error's text (FR-PLT-008 AC3).
 */
async function checkRegistry(taxId: string, branchCode: string): Promise<{ proposal: RegistryProposal; data: Record<string, unknown> }> {
  let mode: RegistryProvider['mode'] = getEnv().REGISTRY_MODE
  let answers: { readonly rd: RegistryAnswer; readonly dbd: RegistryAnswer }
  try {
    const provider = getRegistryProvider()
    mode = provider.mode
    answers = await provider.lookup({ taxId, branchCode })
  } catch (error) {
    logger.warn({ registryMode: mode, error: describeError(error) }, 'the supplier registries could not be reached: a person confirms the supplier with proof (BR-SUP-03)')
    // BR-SUP-02: DBD is not asked about an individual
    answers = { rd: { status: 'UNAVAILABLE' }, dbd: isJuristicTaxId(taxId) ? { status: 'UNAVAILABLE' } : { status: 'SKIPPED' } }
  }
  const { rd, dbd } = answers
  const found = [rd, dbd].filter((a): a is Extract<RegistryAnswer, { status: 'FOUND' }> => a.status === 'FOUND')
  const outcome = found.length ? 'FOUND' : [rd, dbd].some((a) => a.status === 'UNAVAILABLE') ? 'UNAVAILABLE' : 'NOT_FOUND'
  const sourceOf = (which: 'RD' | 'DBD'): 'RD' | 'DBD' | 'STUB' => (mode === 'stub' ? 'STUB' : which)
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
    data: { mode, rd, dbd },
  }
}

/** BR-SUP-01 to BR-SUP-03: LOOKUP — the server asks the registries again; MANUAL — they could not confirm, a person does with proof */
const RegistryCheck = z.discriminatedUnion('check', [z.strictObject({ check: z.literal('LOOKUP') }), z.strictObject({ check: z.literal('MANUAL'), proofFileId: z.uuid() })])

/** How a Thai supplier's identity was confirmed, as the register keeps it */
interface ConfirmedIdentity {
  readonly source: 'RD' | 'DBD' | 'MANUAL' | 'STUB'
  readonly status: string | null
  readonly data: Record<string, unknown>
  readonly outcome: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE'
  readonly sources: ReadonlyArray<'RD' | 'DBD' | 'MANUAL' | 'STUB'>
  readonly proofFileId: string | null
}

/**
 * §7.15 for a Thai supplier's tax id and branch, when it is added and whenever they change: LOOKUP needs the registries,
 * asked again here, to find it (BR-SUP-01); MANUAL is for when they cannot, with a proof file the user uploaded
 * (BR-SUP-03, FileLink REGISTRY_PROOF). Nothing is written here.
 */
async function confirmIdentity(
  tx: TenantTx,
  ctx: Ctx,
  identity: { taxId: string; branchCode: string },
  check: z.infer<typeof RegistryCheck> | undefined,
): Promise<{ readonly ok: true; readonly identity: ConfirmedIdentity } | ReturnType<typeof fail>> {
  if (!check) return fail('VALIDATION_FAILED', 'check the registries or confirm with proof', { field: 'registry', reason: 'REGISTRY_CHECK_REQUIRED' })
  const checked = await checkRegistry(identity.taxId, identity.branchCode)
  if (check.check === 'LOOKUP') {
    if (checked.proposal.outcome !== 'FOUND') return fail('VALIDATION_FAILED', 'the registries could not confirm the supplier: attach proof', { field: 'registry', reason: 'REGISTRY_PROOF_REQUIRED', outcome: checked.proposal.outcome })
    return {
      ok: true,
      identity: { source: checked.proposal.sources[0] as 'RD' | 'DBD' | 'STUB', status: checked.proposal.juristicStatus, data: checked.data, outcome: 'FOUND', sources: [...checked.proposal.sources], proofFileId: null },
    }
  }
  const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  const own = actor ? await tx.fileObject.count({ where: { id: check.proofFileId, uploadedById: actor, status: 'AVAILABLE' } }) : 0
  if (own !== 1) return fail('VALIDATION_FAILED', 'the proof must be a file you uploaded', { field: 'registry.proofFileId', reason: 'FILE' })
  return { ok: true, identity: { source: 'MANUAL', status: checked.proposal.juristicStatus, data: checked.data, outcome: checked.proposal.outcome, sources: ['MANUAL'], proofFileId: check.proofFileId } }
}

/** Supplier columns that keep the confirmed identity (§6.2) */
const identityColumns = (identity: ConfirmedIdentity, now: Date) => ({ registrySource: identity.source, registryStatus: identity.status, registryCheckedAt: now, registryData: identity.data as object })

/** The proof a person confirmed the supplier with, linked to it (BR-SUP-03) */
async function linkProof(tx: TenantTx, ctx: Ctx, supplierId: string, identity: ConfirmedIdentity) {
  if (identity.proofFileId) await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: identity.proofFileId, subjectType: 'Supplier', subjectId: supplierId, kind: 'REGISTRY_PROOF' } })
}

const registryChecked = (supplierId: string, taxId: string, branchCode: string, identity: ConfirmedIdentity): EventDraft => ({
  type: 'supplier.registry_checked',
  aggregateType: 'Supplier',
  aggregateId: supplierId,
  data: { taxId, branchCode, sources: [...identity.sources], outcome: identity.outcome },
})

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
  registry: RegistryCheck.optional(),
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
    let registry: ConfirmedIdentity | null = null
    if (!input.isForeign && taxId.taxId) {
      const confirmed = await confirmIdentity(tx, ctx, { taxId: taxId.taxId, branchCode: input.branchCode }, input.registry)
      if (!confirmed.ok) return confirmed
      registry = confirmed.identity
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
        ...(registry ? identityColumns(registry, ctx.now) : {}),
      },
      select: { id: true },
    })
    if (registry) await linkProof(tx, ctx, row.id, registry)
    const events: EventDraft[] = [
      {
        type: 'supplier.created',
        aggregateType: 'Supplier',
        aggregateId: row.id,
        data: { code: input.code, taxId: taxId.taxId, branchCode: input.branchCode, isForeign: input.isForeign, registrySource: registry?.source ?? null, via: 'PROCUREMENT' },
      },
    ]
    if (registry && taxId.taxId) events.push(registryChecked(row.id, taxId.taxId, input.branchCode, registry))
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
  /** Needed when a Thai supplier's tax id or branch changes (BR-SUP-01 to BR-SUP-03), refused otherwise */
  registry: RegistryCheck.optional(),
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
    // A new tax id or branch is a new identity: unique, and for a Thai supplier checked against the registries or
    // confirmed with proof, as when it was added (BR-SUP-01 to BR-SUP-03)
    let identity: { taxId: string; branchCode: string; confirmed: ConfirmedIdentity } | null = null
    if (changed.includes('taxId') || changed.includes('branchCode')) {
      const taxId = (changed.includes('taxId') ? next.taxId : supplier.taxId) as string | null
      const branchCode = (changed.includes('branchCode') ? next.branchCode : supplier.branchCode) as string
      const same = await duplicateOf(tx, taxId, branchCode, supplier.id)
      if (same) return fail('VALIDATION_FAILED', 'a supplier with this tax id and branch exists', { field: 'taxId', reason: 'SUPPLIER_EXISTS', supplierId: same.id, code: same.code })
      if (!supplier.isForeign && taxId) {
        const confirmed = await confirmIdentity(tx, ctx, { taxId, branchCode }, input.registry)
        if (!confirmed.ok) return confirmed
        identity = { taxId, branchCode, confirmed: confirmed.identity }
      }
    }
    // A check or proof belongs to a new identity of a Thai supplier; sent with anything else it would be dropped unseen
    if (input.registry && !identity) return fail('VALIDATION_FAILED', 'a registry check goes with a new tax id or branch of a Thai supplier', { field: 'registry', reason: 'REGISTRY_NOT_NEEDED' })
    const data = Object.fromEntries(changed.map((key) => [key, next[key]]))
    // The version moves only if nobody saved in between (the row is not locked while the user edits)
    const saved = await tx.supplier.updateMany({
      where: { id: supplier.id, version: supplier.version },
      data: { ...data, ...(identity ? identityColumns(identity.confirmed, ctx.now) : {}), version: { increment: 1 } },
    })
    if (saved.count !== 1) return fail('CONFLICT_VERSION', 'the supplier changed since it was opened')
    if (identity) await linkProof(tx, ctx, supplier.id, identity.confirmed)
    const events: EventDraft[] = [{ type: 'supplier.updated', aggregateType: 'Supplier', aggregateId: supplier.id, data: { code: supplier.code, changed: [...changed] } }]
    if (identity) events.push(registryChecked(supplier.id, identity.taxId, identity.branchCode, identity.confirmed))
    return { ok: true, result: { supplierId: supplier.id, version: supplier.version + 1 }, events }
  },
})

export function updateSupplier(ctx: Ctx, input: z.input<typeof UpdateSupplierInput>, options: RunOptions) {
  return runCommand(ctx, updateSupplierCommand, input, options)
}

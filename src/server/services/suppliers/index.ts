import { z } from 'zod'
import { isValidThaiTaxId, normalizeTaxId } from '@/core/thai/taxid'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
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
      },
      select: { id: true },
    })
    return {
      ok: true,
      result: { supplierId: row.id },
      events: [
        {
          type: 'supplier.created',
          aggregateType: 'Supplier',
          aggregateId: row.id,
          data: { code: input.code, taxId: taxId.taxId, branchCode: input.branchCode, isForeign: input.isForeign, registrySource: null, via: 'PROCUREMENT' },
        },
      ],
    }
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

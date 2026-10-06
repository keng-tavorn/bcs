import { z } from 'zod'
import type { Ctx } from '@/server/context'
import { createSupplier, updateSupplier } from '@/server/services/suppliers'
import { checkNewSupplier } from '@/server/services/suppliers/view'
import { toSupplierFailure, type SupplierFailure, type SupplierOutcome } from '@/ui/suppliers/outcome'
import type { NewSupplierInput, RegistryCheckView, SupplierEditInput } from '@/ui/suppliers/types'

// The commands behind the buttons of the supplier screens (S4-02, FR-SUP-001), apart from the session and the page
// cache so tests run them with a context. Server actions are public endpoints (BR-AUTH-05): every argument is parsed
// before it is read, so a malformed call gets VALIDATION_FAILED and never a crash; then the service checks
// supplier.manage (PROCUREMENT) and every rule again. An edit carries only what /suppliers/[id] edits — the supplier's
// details, codes, contacts and status. Its tax id and branch were checked against the registries (BR-SUP-01 to
// BR-SUP-03) and never change from these screens: a wrong one is corrected by deactivating the supplier and adding it
// again, which checks the registries anew.

const Key = z.uuid()
const invalid = (field: string): SupplierFailure => ({ ok: false, code: 'VALIDATION_FAILED', field })
const BAD_KEY = invalid('idempotencyKey')

const CheckInput = z.object({ taxId: z.string().max(40), branchCode: z.string().max(10).optional() })

/** What the edit forms of /suppliers/[id] send (src/ui/suppliers/manage.tsx); any other key is refused, not dropped */
const EditInput = z.strictObject({
  supplierId: z.string(),
  expectedVersion: z.number(),
  nameTh: z.string().optional(),
  nameEn: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  isVatRegistered: z.boolean().optional(),
  category: z.string().nullable().optional(),
  expressVendorCode: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
}) satisfies z.ZodType<SupplierEditInput>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The field a refused edit names: a key the screens never send, or the first value that is not what they send */
function editFailure(issues: readonly z.core.$ZodIssue[]): SupplierFailure {
  const first = issues[0]
  if (first?.code === 'unrecognized_keys') return invalid(first.keys[0] ?? '(input)')
  return invalid(typeof first?.path[0] === 'string' ? first.path[0] : '(input)')
}

/** FR-SUP-001 AC1: what the Revenue Department and DBD say about a tax id and branch (stub mode locally and in the demo) */
export async function checkSupplier(ctx: Ctx, input: unknown): Promise<SupplierOutcome<{ check: RegistryCheckView }>> {
  const parsed = CheckInput.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues[0]?.path[0] === 'branchCode' ? 'branchCode' : 'taxId')
  const result = await checkNewSupplier(ctx, parsed.data)
  return result.ok ? { ok: true, check: result.data } : toSupplierFailure(result.error)
}

/** "บันทึกผู้ขาย": the service's schema checks every value, and the registries again (createSupplier) */
export async function createSupplierFromScreen(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<SupplierOutcome<{ supplierId: string }>> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  if (!isRecord(input)) return invalid('(input)')
  // The form sends "no check" as null (NewSupplierInput); the service takes it as absent
  const { registry, ...rest } = input as Partial<Record<keyof NewSupplierInput, unknown>>
  const result = await createSupplier(ctx, { ...rest, ...(registry === null || registry === undefined ? {} : { registry }) } as Parameters<typeof createSupplier>[1], { idempotencyKey: String(idempotencyKey) })
  return result.ok ? { ok: true, supplierId: result.data.supplierId } : toSupplierFailure(result.error)
}

/** One edit form of /suppliers/[id], or deactivating and activating again (status), against the version seen */
export async function updateSupplierFromScreen(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<SupplierOutcome<{ supplierId: string; version: number }>> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = EditInput.safeParse(input)
  if (!parsed.success) return editFailure(parsed.error.issues)
  const result = await updateSupplier(ctx, parsed.data, { idempotencyKey: String(idempotencyKey) })
  return result.ok ? { ok: true, supplierId: result.data.supplierId, version: result.data.version } : toSupplierFailure(result.error)
}

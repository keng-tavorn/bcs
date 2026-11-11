import { createHash } from 'node:crypto'
import type { Result } from '@/core/result'
import { deleteObject, putObject } from '@/integrations/storage'
import { MS_PER_HOUR, SUPPLIER_DOC_MAX_BYTES } from '@/lib/constants'
import { PORTAL_UPLOADS_PER_HOUR } from '@/lib/portal-limits'
import { countPortalScopeHit } from '@/server/db/portal'
import { newId } from '@/lib/ids'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import type { RunOptions } from '../_pipeline'
import { createBankAccountChange } from '../bank-accounts'
import { sniffSupplierFile } from './documents'

// The supplier's own bank account, proposed on the portal (S7-10 · FR-SUP-103 AC1 · ADR-190 · INV-SUP ข้อ 04): the one
// way S7 reaches bank accounts — through S9's bankAccountChange.create, never a BankAccount written here. The paper
// (a passbook page or a bank letter: PDF, JPEG or PNG by its bytes, at most 20 MB) is stored in the private bucket
// first, then the command records the request with it; an object of a refused request is deleted.

const PROOF_MIMES = ['application/pdf', 'image/jpeg', 'image/png'] as const
type ProofMime = (typeof PROOF_MIMES)[number]
const EXTENSION: Record<ProofMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }

export interface PortalBankProposal {
  readonly bankCode: string
  readonly accountNo: string
  readonly accountName: string
  readonly branchName: string | null
  readonly reason: string
  readonly fileName: string
  readonly bytes: Uint8Array
}

export async function proposeBankAccountChange(ctx: Ctx, input: PortalBankProposal, options: RunOptions): Promise<Result<{ changeId: string; warnings: string[] }>> {
  if (ctx.actor.type !== 'SUPPLIER' || !ctx.actor.supplierId) return { ok: false, error: { code: 'FORBIDDEN', message: 'a contact of a registered supplier proposes its account', details: { action: 'portal.bankAccount.propose' } } }
  if (input.bytes.byteLength === 0) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the file is empty', details: { field: 'file', reason: 'EMPTY' } } }
  if (input.bytes.byteLength > SUPPLIER_DOC_MAX_BYTES) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the file is larger than 20 MB', details: { field: 'file', reason: 'TOO_LARGE' } } }
  const sniffed = sniffSupplierFile(input.bytes)
  const mime = (PROOF_MIMES as readonly string[]).includes(sniffed ?? '') ? (sniffed as ProofMime) : null
  if (!mime) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'only PDF, JPEG or PNG', details: { field: 'file', reason: 'TYPE_NOT_ALLOWED' } } }
  const supplierId = ctx.actor.supplierId
  // BR-PORTAL ข้อ 04: the uploads of a supplier in its hour, the same count as its documents'
  const windowStart = new Date(Math.floor(ctx.now.getTime() / MS_PER_HOUR) * MS_PER_HOUR)
  if ((await countPortalScopeHit(ctx.organizationId, { kind: 'SUPPLIER', key: supplierId }, 'UPLOAD', windowStart)) > PORTAL_UPLOADS_PER_HOUR) return { ok: false, error: { code: 'RATE_LIMITED', message: 'too many files this hour' } }
  // the account in force, if any, is the one replaced
  const active = await forTenant(ctx.organizationId).bankAccount.findFirst({ where: { supplierId, status: 'ACTIVE' }, select: { id: true } })
  const storageKey = `${ctx.organizationId}/bank-proofs/${newId()}.${EXTENSION[mime]}`
  await putObject(storageKey, input.bytes, mime)
  const r = await createBankAccountChange(
    ctx,
    {
      kind: active ? 'REPLACE' : 'ADD',
      ownerKind: 'SUPPLIER',
      supplierId,
      ...(active ? { targetBankAccountId: active.id } : {}),
      bankCode: input.bankCode,
      accountNo: input.accountNo,
      accountName: input.accountName,
      branchName: input.branchName,
      reason: input.reason,
      proofFile: { storageKey, fileName: input.fileName.slice(0, 200) || 'proof', mimeType: mime, sizeBytes: input.bytes.byteLength, sha256: createHash('sha256').update(input.bytes).digest('hex') },
    },
    options,
  )
  if (!r.ok) await deleteObject(storageKey).catch(() => undefined)
  return r
}

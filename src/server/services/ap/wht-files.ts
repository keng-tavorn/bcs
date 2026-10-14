import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { isAllowed, loadPrincipal, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { recordSensitiveAccess } from '../audit/sensitive-access'
import { registerFileSubjectPolicy } from '../files/policies'
import { maskTaxId } from '../suppliers/access'

// Who sees an individual payee's national id whole (BR-WHT-09, OQ-123, NFR-PRIV-03): wht.view (FINANCE, AUDITOR) reads
// 50 ทวิ and the monthly summaries with the number masked; only wht.revealTaxId (FINANCE) opens it whole — on the
// screen, in the PDF of a 50 ทวิ (which prints it whole), or in a summary file made with it whole — and every such
// opening is a SensitiveAccessLog row written in the same transaction that hands the value out. A juristic payee's
// tax id is not a national id and is never masked. The value never reaches a log, an event, LINE or an e-mail.

type Payee = { readonly name: string; readonly taxId: string; readonly branch: string; readonly address: string; readonly payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN' }

/** A 50 ทวิ's payee as `principal` may read it: null without wht.view; the id masked unless revealed */
export function payeeAsSeen(payee: Payee, revealed: boolean): Payee {
  return payee.payeeType === 'INDIVIDUAL' && !revealed ? { ...payee, taxId: maskTaxId(payee.taxId) } : payee
}

async function certificatePayee(tx: TenantTx, certificateId: string): Promise<Payee | null> {
  const c = await tx.whtCertificate.findFirst({ where: { id: certificateId }, select: { payeeSnapshot: true } })
  return c ? (c.payeeSnapshot as Payee) : null
}

// The PDF of a 50 ทวิ prints the id whole: an individual's needs wht.revealTaxId and is logged at each download
registerFileSubjectPolicy('WhtCertificate', async (tx, ctx, principal, certificateId) => {
  if (!isAllowed(principal, 'wht.view')) return false
  const payee = await certificatePayee(tx, certificateId)
  if (!payee) return false
  if (payee.payeeType !== 'INDIVIDUAL') return true
  if (!isAllowed(principal, 'wht.revealTaxId')) return false
  await recordSensitiveAccess(tx, ctx, { subjectType: 'WhtCertificate', subjectId: certificateId, fields: ['payeeSnapshot.taxId'], purpose: 'download' })
  return true
})

/** A monthly summary (ExportJob WHT_RETURN): wht.view; one made with ids whole needs wht.revealTaxId and is logged */
export async function whtReturnFileReadable(tx: TenantTx, ctx: Ctx, principal: Principal, exportJobId: string, params: unknown): Promise<boolean> {
  if (!isAllowed(principal, 'wht.view') && !isAllowed(principal, 'wht.export')) return false
  const revealed = z.object({ revealTaxId: z.boolean() }).safeParse(params)
  if (!revealed.success || !revealed.data.revealTaxId) return true
  if (!isAllowed(principal, 'wht.revealTaxId')) return false
  await recordSensitiveAccess(tx, ctx, { subjectType: 'ExportJob', subjectId: exportJobId, fields: ['payeeSnapshot.taxId'], purpose: 'download' })
  return true
}

/** FINANCE opens an individual payee's national id on a 50 ทวิ (wht.revealTaxId): the value, with its log row */
export async function revealWhtPayeeTaxId(ctx: Ctx, input: { readonly certificateId: string }): Promise<Result<{ taxId: string }>> {
  if (!z.uuid().safeParse(input.certificateId).success) return err('NOT_FOUND', 'certificate not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member' || !isAllowed(principal, 'wht.revealTaxId')) return err('FORBIDDEN', 'you may not open a national id', { capability: 'wht.revealTaxId' })
    const payee = await certificatePayee(tx, input.certificateId)
    if (!payee) return err('NOT_FOUND', 'certificate not found')
    if (payee.payeeType === 'INDIVIDUAL') await recordSensitiveAccess(tx, ctx, { subjectType: 'WhtCertificate', subjectId: input.certificateId, fields: ['payeeSnapshot.taxId'], purpose: 'wht.revealTaxId' })
    return ok({ taxId: payee.taxId })
  })
}

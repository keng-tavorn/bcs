import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// Who opened a personal value in full (spec §6.2 SensitiveAccessLog, NFR-PRIV-03): the full national id of an
// individual payee on 50 ทวิ (BR-WHT-09, S8) and a supplier's bank account number (S9). The row is written inside the
// transaction that reads the value, so a reveal is never shown without its log; the table is insert-only for the app
// role (migration s8_invoices). The value itself is never written here, only which fields were opened.

export interface SensitiveAccess {
  /** The model the value belongs to, e.g. "WhtCertificate" */
  readonly subjectType: string
  readonly subjectId: string
  /** Field names, never the values */
  readonly fields: readonly string[]
  /** Why it was opened, e.g. "wht.revealTaxId" or "download" */
  readonly purpose: string
}

/** Records one reveal by the member of `ctx` at ctx.now. Only a member reveals: any other actor is refused. */
export async function recordSensitiveAccess(tx: TenantTx, ctx: Ctx, access: SensitiveAccess): Promise<void> {
  if (ctx.actor.type !== 'USER') throw new Error('only a member opens a personal value in full')
  if (access.fields.length === 0) throw new Error('name the fields that were opened')
  await tx.sensitiveAccessLog.create({
    data: {
      organizationId: ctx.organizationId,
      memberId: ctx.actor.memberId,
      subjectType: access.subjectType,
      subjectId: access.subjectId,
      fields: [...access.fields],
      purpose: access.purpose,
      at: ctx.now,
    },
  })
}

import { forTenant } from '@/server/db/tenant'
import type { parseGlAccounts } from './sheets'

// The account codes of the organization (S8-04, sheet GL_Accounts): a list of codes an invoice line is coded with, not
// a general ledger (P-4). A second run adds only codes that are not there yet.

export async function seedAccountCodes(organizationId: string, accounts: ReturnType<typeof parseGlAccounts>): Promise<{ created: number }> {
  if (accounts.length === 0) return { created: 0 }
  const r = await forTenant(organizationId).accountCode.createMany({
    data: accounts.map((a) => ({ organizationId, code: a.code, nameTh: a.nameTh, type: a.type })),
    skipDuplicates: true,
  })
  return { created: r.count }
}

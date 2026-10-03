import { isAllowed, memberPrincipal, scopesFor } from '@/server/authz'
import type { StoredRole } from '@/server/authz/permissions'
import type { LinkRights } from '@/ui/insight/links'

// What the reader of the board, the audit trail or a KPI list may open (spec §2.4), so a document they may not open
// stays text instead of a link that ends in a refusal. The pages behind the links check again (BR-AUTH-05).
export function linkRights(memberId: string, roles: Iterable<StoredRole>): LinkRights {
  const principal = memberPrincipal(memberId, roles)
  return {
    requests: true,
    purchaseOrders: scopesFor(principal, 'po.view').has('ORG'),
    doaVersions: isAllowed(principal, 'admin.doa.draft'),
    orgAuthorityChanges: isAllowed(principal, 'admin.orgAuthority.propose'),
  }
}

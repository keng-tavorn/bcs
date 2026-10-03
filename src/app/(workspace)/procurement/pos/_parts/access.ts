import { isAllowed, matchingGrants, scopesFor, type Principal } from '@/server/authz'
import type { PoAccessDto, PoViewDto } from '@/server/queries/purchase-orders'
import { canViewRequest } from '../../../_tracking/access'
import type { PoReader } from './po-body'

// Read permissions of the purchase-order pages (spec §2.4, BR-AUTH-05). Queries cannot import authz, so each page asks
// these before it reads a PO; the services check again on every action, so hiding a button is never the guard.

/**
 * po.view: PROCUREMENT, FINANCE, EXECUTIVE and AUDITOR (ORG), who sent it and the requesters of its PRs (OWN), its
 * approvers (ASSIGNED) — the same facts the PDF route checks (services/documents/pdf.ts).
 */
export function canViewPo(principal: Principal, access: PoAccessDto): boolean {
  return isAllowed(principal, 'po.view', {
    ownerMemberIds: [...(access.createdById ? [access.createdById] : []), ...access.requesterMemberIds],
    assigneeMemberIds: access.approverMemberIds,
  })
}

/**
 * The prices paid before for the same items (FR-P2P-003 AC1) come from other POs: shown to those who may see every PO
 * (po.view ORG), to procurement who prices the draft, and to the PO's approvers, who decide on it (FR-DOA-004). A
 * requester who sees only their own PO does not get other POs' prices.
 */
export function canSeePoPrices(principal: Principal, access: PoAccessDto): boolean {
  // isAllowed without a resource answers 'somewhere': the organization-wide grant is asked for by its scope
  if (scopesFor(principal, 'po.view').has('ORG') || isAllowed(principal, 'po.edit')) return true
  return principal.kind === 'member' && access.approverMemberIds.includes(principal.memberId)
}

/**
 * The supplier's e-mail address — and so the address a PO went to — is a field of the full supplier register
 * (§2.4 supplier.view: every member sees the name and basic details only, PROCUREMENT FINANCE and AUDITOR everything),
 * and it may be a person's own address. Shown to whoever sees the register in full, and to whoever sends POs (po.send).
 */
export function canSeeSupplierContact(principal: Principal): boolean {
  return matchingGrants(principal, 'supplier.view').some((g) => g.condition === undefined) || isAllowed(principal, 'po.send')
}

/** What the reader of a PO may see beside it: other POs' prices, the supplier's address, and which source requests open */
export function poReader(principal: Principal, access: PoAccessDto | null, po: PoViewDto, options: { readonly prices?: boolean } = {}): PoReader {
  return {
    prices: options.prices ?? (access !== null && canSeePoPrices(principal, access)),
    supplierContact: canSeeSupplierContact(principal),
    requests: new Set(po.requests.filter((r) => canViewRequest(principal, r.access)).map((r) => r.id)),
  }
}

/** What the viewer may do to POs at all (§2.4: PROCUREMENT); the page offers an action only when the PO allows it too */
export function poRights(principal: Principal) {
  return {
    edit: isAllowed(principal, 'po.edit'),
    submit: isAllowed(principal, 'po.submit'),
    send: isAllowed(principal, 'po.send'),
    cancel: isAllowed(principal, 'po.cancel'),
    close: isAllowed(principal, 'po.close'),
  }
}

/** /procurement/pos lists every PO of the organization for PROCUREMENT (menu: po.create) */
export function canListPos(principal: Principal): boolean {
  return isAllowed(principal, 'po.create')
}

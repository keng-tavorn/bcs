import { err, ok, type Result } from '@/core/result'
import { API_RATE_LIMIT_PER_WINDOW, API_RATE_LIMIT_WINDOW_MS } from '@/lib/constants'
import { loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { countRateLimited } from '@/server/db/sql/rate-limit'
import { forTenant } from '@/server/db/tenant'
import { recentInScope, searchInScope, searchText, type SearchDocumentDto, type SearchResultDto, type SearchScope } from '@/server/queries/search'
import { supplierAccess } from '../suppliers/access'
import { taxIdMatchOf } from '../suppliers/view'

// The ⌘K search of the workspace (spec FR-PLT-014, §9.10): who the member is and what they may find are decided here,
// from their grants of §2.4 (request.view, po.view, supplier.view), every time; src/server/queries/search.ts reads only
// inside that scope. GET /api/search counts each call first (NFR-SEC-05: 60 a minute per member). Read only: no
// command, no Event (FR-PLT-014 AC5).

export interface SearchAnswerDto extends SearchResultDto {
  /** Before two characters are typed: the documents the member acted on last (§9.10 "ล่าสุด") */
  readonly recent: readonly SearchDocumentDto[]
}

/** What this principal may find; null when nothing (an inactive member, the platform, the system) */
export function searchScopeOf(principal: Principal): SearchScope | null {
  if (principal.kind !== 'member') return null
  const requests = scopesFor(principal, 'request.view')
  const pos = scopesFor(principal, 'po.view')
  const suppliers = supplierAccess(principal)
  return {
    memberId: principal.memberId,
    requests: requests.size ? { all: requests.has('ORG'), headedDepartmentIds: requests.has('DEPT') ? [...principal.headOfDepartmentIds] : [] } : null,
    purchaseOrders: pos.size ? { all: pos.has('ORG') } : null,
    suppliers: suppliers ? { taxIdMatch: taxIdMatchOf(suppliers) } : null,
  }
}

/** The member's scope from their roles and the departments they head now (loadPrincipal) */
async function scopeFor(ctx: Ctx): Promise<SearchScope | null> {
  if (ctx.actor.type !== 'USER') return null
  const principal = await forTenant(ctx.organizationId).$transaction((tx) => loadPrincipal(tx, ctx))
  return searchScopeOf(principal)
}

/** FR-PLT-014: what `q` finds for this member — or, under two characters, their recent documents */
export async function searchForMember(ctx: Ctx, q: string | null | undefined): Promise<Result<SearchAnswerDto>> {
  const scope = await scopeFor(ctx)
  if (!scope) return err('FORBIDDEN', 'only an active member searches')
  if (!searchText(q)) return ok({ documents: [], suppliers: [], recent: await recentInScope(ctx, scope) })
  return ok({ ...(await searchInScope(ctx, scope, q ?? '')), recent: [] })
}

/** NFR-SEC-05: one more search by this member; RATE_LIMITED past API_RATE_LIMIT_PER_WINDOW within the window */
export async function countSearch(ctx: Ctx): Promise<Result<null>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only an active member searches')
  const count = await countRateLimited(`bcs:search:${ctx.organizationId}:${ctx.actor.memberId}`, API_RATE_LIMIT_WINDOW_MS, API_RATE_LIMIT_PER_WINDOW, ctx.now)
  return count.allowed ? ok(null) : err('RATE_LIMITED', 'too many searches; try again later', { reason: 'SEARCH', time: count.resetAt.toISOString() })
}

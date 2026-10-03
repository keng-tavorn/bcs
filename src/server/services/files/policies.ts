import type { Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// Who may download a file attached to a document (FR-PLT-004 AC2): whoever may view that document. Each document
// type registers its check when it exists (S2-11 requests, S4 POs and receipts). A type without a registered
// check gives no access — deny by default (BR-AUTH-01).

export type FileSubjectPolicy = (tx: TenantTx, ctx: Ctx, principal: Principal, subjectId: string) => Promise<boolean>

const policies = new Map<string, FileSubjectPolicy>()

export function registerFileSubjectPolicy(subjectType: string, policy: FileSubjectPolicy): void {
  policies.set(subjectType, policy)
}

export function fileSubjectPolicy(subjectType: string): FileSubjectPolicy | undefined {
  return policies.get(subjectType)
}

/** Test seam */
export function clearFileSubjectPolicies(): void {
  policies.clear()
}

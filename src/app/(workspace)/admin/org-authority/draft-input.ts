import type { proposeOrgChange } from '@/server/services/org-authority'
import type { OrgChangeDraft } from '@/ui/admin-org/org-change-form'
import type { ActionFailure } from '@/ui/admin-org/outcome'
import { thaiLocalToIso } from '@/ui/admin-org/thai-time'

// What the proposal form filled in (FR-DOA-010 AC1) as the input of the authority-change service: times typed as Thai
// local time become instants; "effective on approval" becomes the sending time (the approval then applies it at once);
// an amount may carry thousands separators. A time that cannot be read is answered at its field, as the service would.
// The service checks every value again (BR-AUTH-05).

export type OrgChangeServiceInput = Parameters<typeof proposeOrgChange>[1]

type DocumentType = 'PURCHASE_REQUEST' | 'PURCHASE_ORDER' | 'GR_VARIANCE' | 'DOA_CHANGE' | 'ORG_AUTHORITY_CHANGE'

export function orgChangeInput(draft: OrgChangeDraft, now: Date, acknowledgedWarnings: readonly string[]): { readonly ok: true; readonly input: OrgChangeServiceInput } | ActionFailure {
  const reason = draft.reason
  const acknowledged = [...acknowledgedWarnings]
  let effectiveFrom = now.toISOString()
  if (draft.effectiveMode === 'AT' && draft.kind !== 'IDENTITY_RESET' && draft.kind !== 'DELEGATION_ON_BEHALF') {
    const at = thaiLocalToIso(draft.effectiveAt)
    if (!at) return { ok: false, code: 'VALIDATION_FAILED', field: 'effectiveFrom' }
    effectiveFrom = at
  }
  switch (draft.kind) {
    case 'POSITION_ASSIGN':
      return { ok: true, input: { kind: draft.kind, payload: { positionCode: draft.positionCode, departmentId: draft.departmentId, memberId: draft.memberId }, effectiveFrom, reason, acknowledgedWarnings: acknowledged } }
    case 'POSITION_END':
      return {
        ok: true,
        input: {
          kind: draft.kind,
          payload: { positionCode: draft.positionCode, departmentId: draft.departmentId, ...(draft.replacementMemberId ? { replacementMemberId: draft.replacementMemberId } : {}) },
          effectiveFrom,
          reason,
          acknowledgedWarnings: acknowledged,
        },
      }
    case 'DEPARTMENT_REPARENT':
      return { ok: true, input: { kind: draft.kind, payload: { departmentId: draft.departmentId, newParentId: draft.newParentId }, effectiveFrom, reason, acknowledgedWarnings: acknowledged } }
    case 'DELEGATION_ON_BEHALF': {
      // The delegation's own start governs: the change is recorded when it is approved (effectiveFrom = sending time)
      const startsAt = thaiLocalToIso(draft.startsAt)
      const endsAt = thaiLocalToIso(draft.endsAt)
      if (!startsAt || !endsAt) return { ok: false, code: 'VALIDATION_FAILED', field: 'payload', reason: 'INVALID_PERIOD' }
      const maxAmount = draft.maxAmount.replaceAll(',', '').trim()
      return {
        ok: true,
        input: {
          kind: draft.kind,
          payload: {
            delegatorMemberId: draft.delegatorMemberId,
            delegateMemberId: draft.delegateMemberId,
            startsAt,
            endsAt,
            // Passed as sent: an unknown type is refused by the service, never dropped (an empty list means every type)
            documentTypes: [...draft.documentTypes] as DocumentType[],
            ...(maxAmount ? { maxAmount } : {}),
          },
          effectiveFrom,
          reason,
          acknowledgedWarnings: acknowledged,
        },
      }
    }
    case 'IDENTITY_RESET':
      return { ok: true, input: { kind: draft.kind, payload: { memberId: draft.memberId }, reason, acknowledgedWarnings: acknowledged } }
  }
}

import { err, ok, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'

// What a contact may do in the portal (docs/sub-specs/S7.md "การกระทำของผู้ติดต่อ"): a supplier contact is not a member
// and has no capability of §2.4; portalAuthorize reads the actor of the portal context against PORTAL_ACTIONS. The map is
// a registry: S10 S11 append their actions (one line each) without changing the ones above. The facts a rule needs
// beyond the actor (the application's status, the supplier's status, PAY) are passed in by the command that asks.

type SupplierActor = Extract<Ctx['actor'], { type: 'SUPPLIER' }>

export interface PortalFacts {
  readonly applicationStatus?: string | null
  readonly supplierStatus?: string | null
  readonly isPrimary?: boolean
  readonly payModule?: boolean
  readonly portalInvoice?: boolean
  /** S11: the status of the risk assessment the contact acts on */
  readonly riskAssessmentStatus?: string | null
}

export type PortalRule = (actor: SupplierActor, facts: PortalFacts) => boolean

const EDITABLE_APPLICATION = new Set(['INVITED', 'DRAFT', 'RETURNED'])
const EDITABLE_RISK_ASSESSMENT = new Set(['DRAFT', 'RETURNED'])
const activeSupplier = (a: SupplierActor, f: PortalFacts) => Boolean(a.supplierId) && f.supplierStatus === 'ACTIVE'

export const PORTAL_ACTIONS = new Map<string, PortalRule>([
  // S7
  ['portal.application.edit', (a, f) => Boolean(a.applicationId) && EDITABLE_APPLICATION.has(f.applicationStatus ?? '')],
  ['portal.application.submit', (a, f) => Boolean(a.applicationId) && EDITABLE_APPLICATION.has(f.applicationStatus ?? '')],
  ['portal.document.upload', (a) => Boolean(a.supplierId || a.applicationId)],
  ['portal.document.view', (a) => Boolean(a.supplierId || a.applicationId)],
  ['portal.bankAccount.propose', (a, f) => activeSupplier(a, f) && f.isPrimary === true],
  ['portal.po.acknowledge', activeSupplier],
  ['portal.invoice.submit', (a, f) => activeSupplier(a, f) && f.payModule === true && f.portalInvoice === true],
  ['portal.invoice.view', (a, f) => activeSupplier(a, f) && f.payModule === true && f.portalInvoice === true],
  // S7-08: the language of one's own account, or closing it (/portal/<org>/profile)
  ['portal.contact.self', (a) => Boolean(a.supplierContactId)],
  // S11-05 (BR-RSK-17): the supplier's own assessments; answered, sent and given files while DRAFT or RETURNED only
  ['portal.risk.view', activeSupplier],
  ['portal.risk.answer', (a, f) => activeSupplier(a, f) && EDITABLE_RISK_ASSESSMENT.has(f.riskAssessmentStatus ?? '')],
  ['portal.risk.submit', (a, f) => activeSupplier(a, f) && EDITABLE_RISK_ASSESSMENT.has(f.riskAssessmentStatus ?? '')],
  ['portal.risk.evidence.upload', (a, f) => activeSupplier(a, f) && EDITABLE_RISK_ASSESSMENT.has(f.riskAssessmentStatus ?? '')],
])

/** FORBIDDEN unless the action is known and its rule allows the contact (an unknown action is never allowed) */
export function portalAuthorize(ctx: Ctx, action: string, facts: PortalFacts = {}): Result<true> {
  if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL') return err('FORBIDDEN', 'not a portal request', { action })
  const rule = PORTAL_ACTIONS.get(action)
  return rule && rule(ctx.actor, facts) ? ok(true) : err('FORBIDDEN', `the contact may not ${action}`, { action })
}

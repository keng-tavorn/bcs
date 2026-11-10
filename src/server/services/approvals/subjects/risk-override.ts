import { documentTypeOfSubject } from '@/core/doa'
import type { SubjectFacts } from '../../sla/subject'
import { decideRiskOverride, overrideConflicts } from '../../risk/overrides'
import { riskPolicyInEffect } from '../../risk/tiers'
import type { SubjectAdapter } from './index'

// The RISK_OVERRIDE approval subject (S11-08 · BR-DOA-28 · BR-RSK-10 BR-RSK-11 · BR-SOD-15 · ADR-226 · OQ-224 OQ-225): an
// override of the risk gate sent under DOA RISK_OVERRIDE with its cumulative cap with VAT as the amount, in its
// requester's department. Kept off its route and refused at deciding (BR-SOD-15, through checkSod): who asked, who made
// the PO it names and whoever filled in the supplier's assessment for it. Approved, the gate may let POs out under it;
// rejected it ends; returned, its requester edits and sends it again on a new route. Questions go back as a return
// (allowsRequestInfo false). Step-up by the cap against the DOA version's stepUpThreshold like any type (not always ·
// BR-RSK-11). No chat button unless the confirmed RiskPolicy.overrideChatButton says so (OQ-225: off), never an e-mail
// link: the approver opens LIFF or the web. A card shows the number and the supplier's code (its name only for a company)
// — no answer of the assessment and no amount per line (BR-NOTI-01).
//
// channels.chatButton gets the facts alone, so the policy's switch is read with the facts and kept beside that object
// (as payment-run.ts does).

const chatButtonOf = new WeakMap<SubjectFacts, boolean>()

export const riskOverrideSubject: SubjectAdapter = {
  async facts(tx, id) {
    const row = await tx.riskOverride.findFirst({
      where: { id },
      select: { number: true, requestedById: true, poId: true, assessmentId: true, supplierId: true, supplier: { select: { code: true, nameTh: true, payeeType: true } }, requestedBy: { select: { primaryDepartmentId: true } } },
    })
    // the policy in effect only: a change waiting for its second person turns nothing on (BR-RSK-02)
    const policy = row ? await riskPolicyInEffect(tx) : null
    const facts: SubjectFacts = {
      type: 'RISK_OVERRIDE',
      id,
      documentType: documentTypeOfSubject('RISK_OVERRIDE'),
      number: row?.number ?? null,
      // a sole proprietor is named by code only (BR-NOTI-10)
      title: row ? (row.supplier.payeeType === 'INDIVIDUAL' ? row.supplier.code : `${row.supplier.code} ${row.supplier.nameTh}`) : null,
      changeKind: null,
      poId: row?.poId ?? null,
      ownerMemberId: row?.requestedById ?? null,
      conflictMemberIds: row ? await overrideConflicts(tx, row) : [],
      chargedDepartmentId: row?.requestedBy.primaryDepartmentId ?? null,
    }
    chatButtonOf.set(facts, policy?.ok === true && policy.data.overrideChatButton)
    return facts
  },
  labels: (facts) => ({ label: facts.number ?? facts.title ?? facts.documentType, title: facts.title }),
  href: (facts) => `/risk/overrides/${facts.id}`,
  decide: (tx, ctx, task, decision) => decideRiskOverride(tx, ctx, task.step.route.subjectId, task.step.route.id, decision.outcome, decision.reasonCommentId),
  allowsRequestInfo: false,
  // OQ-225: the chat button only when the confirmed policy turns it on; never by e-mail (the step-up of the cap is the
  // central files' check · stepUpNeeded)
  channels: { chatButton: (facts) => chatButtonOf.get(facts) === true, emailLink: false, liff: true },
  // BR-SOD-15: the requester, the PO's creator and the assessment's filler-in, one list
  sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
}

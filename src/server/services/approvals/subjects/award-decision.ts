import { documentTypeOfSubject } from '@/core/doa'
import { awardDecisionSodExtra } from '@/core/sod'
import type { SubjectFacts } from '../../sla/subject'
import { decideAward } from '../../sourcing/award-decide'
import { awardPeople, conflictsOf, type AwardPeople } from '../../sourcing/awards'
import type { SubjectAdapter } from './index'

// The AWARD_DECISION approval subject (S10-10 · BR-DOA-27 · BR-RFX-12 BR-RFX-13 · BR-SOD-13 · ADR-202 ADR-068): the award
// of an RFx sent under DOA RFX_AWARD with its amount { net, vat } in the RFx's requesting department. Kept off its route
// and refused at deciding: its submitter (BR-SOD-01 through checkSod) and the people of awardDecisionSodExtra — the RFx's
// creator and opener, every evaluator (also one who stepped aside), the requesters of its source lines and whoever
// recorded a bid on a supplier's behalf (BR-SOD-13). The last approval applies the award in the decision's transaction
// (decideAward → applyAward). No question to the submitter (allowsRequestInfo: false — the approver returns it
// instead). Every channel is open like a PO change: the step-up at the version's stepUpThreshold is the central files'
// (stepUpNeeded · BR-TOK-05), so the adapter holds no logic of amounts. The card names the award's number only (BR-NOTI-01).
//
// sodContext and href get the facts alone, so what they need beyond SubjectFacts is read with the facts and kept beside
// that very object (the shared decide flow passes it back unchanged).

interface AwardExtra {
  readonly rfxEventId: string
  readonly submitter: string | null
  readonly people: AwardPeople
}

const extraOf = new WeakMap<SubjectFacts, AwardExtra>()

export const awardDecisionSubject: SubjectAdapter = {
  async facts(tx, id) {
    const award = await tx.awardDecision.findFirst({ where: { id }, select: { number: true, rfxEventId: true, createdById: true, submittedById: true, rfxEvent: { select: { number: true, requestingDepartmentId: true } } } })
    const people = award ? await awardPeople(tx, award.rfxEventId) : null
    const owner = award ? (award.submittedById ?? award.createdById) : null
    const facts: SubjectFacts = {
      type: 'AWARD_DECISION',
      id,
      documentType: documentTypeOfSubject('AWARD_DECISION'),
      number: award?.number ?? null,
      title: award ? `ผลการจัดหา ${award.rfxEvent.number ?? ''}`.trim() : null,
      changeKind: null,
      poId: null,
      ownerMemberId: owner,
      // BR-DOA-06 for a later step: everyone who may not approve it
      conflictMemberIds: award && people && owner ? conflictsOf(owner, people) : [],
      chargedDepartmentId: award?.rfxEvent.requestingDepartmentId ?? null,
    }
    if (award && people) extraOf.set(facts, { rfxEventId: award.rfxEventId, submitter: award.submittedById, people })
    return facts
  },
  labels: (facts) => ({ label: facts.number ?? facts.title ?? facts.documentType, title: facts.title }),
  href: (facts) => {
    const extra = extraOf.get(facts)
    return extra ? `/sourcing/${extra.rfxEventId}/award` : '/tasks'
  },
  decide: (tx, ctx, task, decision) => decideAward(tx, ctx, task.step.route.subjectId, decision),
  allowsRequestInfo: false,
  channels: { chatButton: () => true, emailLink: true, liff: true },
  sodContext: (facts) => {
    const extra = extraOf.get(facts)
    return {
      requesterMemberIds: extra?.submitter ? [extra.submitter] : facts.ownerMemberId ? [facts.ownerMemberId] : [],
      ...(extra ? { extra: awardDecisionSodExtra(extra.people) } : {}),
    }
  },
}

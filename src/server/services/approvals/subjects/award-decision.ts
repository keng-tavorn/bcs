import { emptyAdapter } from './empty'

// The AWARD_DECISION approval subject (BR-DOA-27 · ADR-202): the award of an RFx sent under DOA RFX_AWARD. S10-02
// registers the subject with the empty adapter (deciding refused VALIDATION_FAILED reason SUBJECT, the task stays open);
// S10-10 writes the real one (facts of BR-RFX-12, SoD of BR-SOD-13 through awardDecisionSodExtra, approval → POs).

export const awardDecisionSubject = emptyAdapter('AWARD_DECISION')

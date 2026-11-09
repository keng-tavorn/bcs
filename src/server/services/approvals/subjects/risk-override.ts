import { emptyAdapter } from './empty'

// The RISK_OVERRIDE approval subject (BR-DOA-28 · ADR-226): approval to issue POs to a supplier past its risk gate, sent
// under DOA RISK_OVERRIDE with its cap with VAT as the amount. S11-02 registers the subject with the empty adapter
// (deciding refused VALIDATION_FAILED reason SUBJECT, the task stays open, no chat button · OQ-225); S11-08 writes the
// real one (facts of FR-RSK-203 AC2, SoD of BR-SOD-15, approval → the override APPROVED).

export const riskOverrideSubject = emptyAdapter('RISK_OVERRIDE')

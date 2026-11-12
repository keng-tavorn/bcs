'use server'

import { cancelRiskAssessment, fillRiskAssessmentOnBehalf, requestRiskEvidenceDocumentDownload, requestRiskEvidenceDownload, submitRiskAssessment } from '@/server/services/risk'
import { openRiskFile, runRiskCommand } from '../../_outcome'

// Browser-facing adapters of /risk/assessments/[id] (S11-05 · FR-RSK-201 AC5): the session, then the service, which
// checks the RISK module and risk.assessment.manage every time (BR-AUTH-05).

const page = (id: string) => `/risk/assessments/${id}`

/** S11-13 (BR-AI-33): with the Risk Agent's draft, the answers it proposed that procurement confirmed one by one */
export async function fillOnBehalfAction(
  assessmentId: string,
  answers: { questionCode: string; optionCode: string }[],
  expectedVersion: number,
  key: string,
  aiAssist?: { agentActionId: string; confirmedPaths: string[] },
) {
  return runRiskCommand(key, (ctx) => fillRiskAssessmentOnBehalf(ctx, { assessmentId, expectedVersion, answers, ...(aiAssist ? { aiAssist } : {}) }, { idempotencyKey: key }), page(assessmentId))
}

export async function submitAssessmentAction(assessmentId: string, expectedVersion: number, key: string) {
  return runRiskCommand(key, (ctx) => submitRiskAssessment(ctx, { assessmentId, expectedVersion }, { idempotencyKey: key }), page(assessmentId))
}

/** An evidence file behind an answer (risk.evidence.view, CLEAN only) */
export async function openEvidenceFileAction(assessmentId: string, fileId: string, key: string) {
  return openRiskFile(key, (ctx) => requestRiskEvidenceDownload(ctx, { assessmentId, fileId }, { idempotencyKey: key }))
}

/** The supplier's certificate an answer rests on (risk.evidence.view, then S7's own check and log) */
export async function openEvidenceDocumentAction(assessmentId: string, documentId: string, key: string) {
  return openRiskFile(key, (ctx) => requestRiskEvidenceDocumentDownload(ctx, { assessmentId, documentId }, { idempotencyKey: key }))
}

export async function cancelAssessmentAction(assessmentId: string, reason: string, expectedVersion: number, key: string) {
  return runRiskCommand(key, (ctx) => cancelRiskAssessment(ctx, { assessmentId, expectedVersion, reason }, { idempotencyKey: key }), page(assessmentId))
}

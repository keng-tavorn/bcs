'use server'

import { cancelRiskAssessment, fillRiskAssessmentOnBehalf, submitRiskAssessment } from '@/server/services/risk'
import { runRiskCommand } from '../../_outcome'

// Browser-facing adapters of /risk/assessments/[id] (S11-05 · FR-RSK-201 AC5): the session, then the service, which
// checks the RISK module and risk.assessment.manage every time (BR-AUTH-05).

const page = (id: string) => `/risk/assessments/${id}`

export async function fillOnBehalfAction(assessmentId: string, answers: { questionCode: string; optionCode: string }[], expectedVersion: number, key: string) {
  return runRiskCommand(key, (ctx) => fillRiskAssessmentOnBehalf(ctx, { assessmentId, expectedVersion, answers }, { idempotencyKey: key }), page(assessmentId))
}

export async function submitAssessmentAction(assessmentId: string, expectedVersion: number, key: string) {
  return runRiskCommand(key, (ctx) => submitRiskAssessment(ctx, { assessmentId, expectedVersion }, { idempotencyKey: key }), page(assessmentId))
}

export async function cancelAssessmentAction(assessmentId: string, reason: string, expectedVersion: number, key: string) {
  return runRiskCommand(key, (ctx) => cancelRiskAssessment(ctx, { assessmentId, expectedVersion, reason }, { idempotencyKey: key }), page(assessmentId))
}

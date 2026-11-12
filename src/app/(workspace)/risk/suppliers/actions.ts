'use server'

import { exportSupplierRiskFile, openRiskAssessment } from '@/server/services/risk'
import { openRiskFile, runRiskCommand } from '../_outcome'

// Browser-facing adapters of the supplier's risk file (S11-10 · FR-RSK-204 AC3 · FR-RSK-201): the session, then the
// service, which checks the RISK module and the right every time (BR-AUTH-05). The Excel copy is a POST that records
// export.generated and file.downloaded and answers a five-minute link.

/** "ส่งออก Excel" (risk.exportSupplierFile · risk.assessment.view) */
export async function exportRiskFileAction(supplierId: string, key: string) {
  return openRiskFile(key, (ctx) => exportSupplierRiskFile(ctx, { supplierId }, { idempotencyKey: key }))
}

/** "เปิดแบบประเมิน" from the supplier (riskAssessment.open · risk.assessment.manage); the new assessment's id comes back */
export async function openAssessmentAction(
  supplierId: string,
  input: { screening: { processesPersonalData: 'Y' | 'N'; accessesSystems: 'Y' | 'N'; accessesPremises: 'Y' | 'N' }; categoryCodes: string[]; workScopes: string[] },
  key: string,
) {
  return runRiskCommand(key, (ctx) => openRiskAssessment(ctx, { supplierId, screening: input.screening, categoryCodes: input.categoryCodes, workScopes: input.workScopes }, { idempotencyKey: key }), `/risk/suppliers/${supplierId}`, (d) => d.assessmentId)
}

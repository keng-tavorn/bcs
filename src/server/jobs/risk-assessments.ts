import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { remindRiskAssessment, riskEvidenceScanned, riskReminderDue } from '@/server/services/risk'

// The jobs of S11-05 (docs/sub-specs/S11.md "job Inngest ใหม่"):
// - risk-assessment-sla: from every activity on an open assessment (opened, answered, returned) it sleeps until the
//   supplier's reminder is due and reminds once by e-mail with a new link; a newer activity starts its own run, and a
//   send or a cancel ends it (BR-RSK-17 · SEAM-S7xS11-X-16)
// - risk-evidence-scanned: S11's listener of S7's file.scanned for RISK_EVIDENCE: an infected file loses its link and the
//   supplier is told (BR-RSK-18)

const Assessment = z.object({ organizationId: z.uuid(), aggregateId: z.uuid() })
const SAME = 'async.data.aggregateId == event.data.aggregateId'

export const riskAssessmentSla = inngest.createFunction(
  {
    id: 'risk-assessment-sla',
    triggers: [{ event: 'bcs/risk_assessment.opened' }, { event: 'bcs/risk_assessment.answered' }, { event: 'bcs/risk_assessment.returned' }],
    cancelOn: [
      { event: 'bcs/risk_assessment.submitted', if: SAME },
      { event: 'bcs/risk_assessment.cancelled', if: SAME },
      { event: 'bcs/risk_assessment.answered', if: SAME },
    ],
  },
  async ({ event, step }) => {
    const payload = Assessment.safeParse(event.data)
    if (!payload.success) return 'IGNORED'
    const { organizationId, aggregateId } = payload.data
    const plan = await step.run('plan', () => riskReminderDue(organizationId, aggregateId))
    if (!plan) return 'CLOSED'
    await step.sleepUntil('until-remind', plan.at)
    return step.run('remind', () => remindRiskAssessment(organizationId, aggregateId, plan.lastActivityAt, systemClock.now()))
  },
)

const Scanned = z.object({ organizationId: z.uuid(), aggregateId: z.uuid(), data: z.object({ result: z.enum(['CLEAN', 'INFECTED']), linkKinds: z.array(z.string()) }).loose() })

export const riskEvidenceScannedJob = inngest.createFunction({ id: 'risk-evidence-scanned', triggers: [{ event: 'bcs/file.scanned' }] }, async ({ event, step }) => {
  const payload = Scanned.safeParse(event.data)
  if (!payload.success || !payload.data.data.linkKinds.includes('RISK_EVIDENCE')) return 'IGNORED'
  return step.run('mark', () => riskEvidenceScanned(payload.data.organizationId, payload.data.aggregateId, payload.data.data.result, systemClock.now()))
})

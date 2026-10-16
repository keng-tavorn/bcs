import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { activateWorkflowVersion } from '@/server/services/workflow'

// Job `workflow-version-activate` (spec §4.6, BR-WF-12, S6-04): a workflow version published for a later date waits
// until it takes effect, then the version it replaces becomes SUPERSEDED (routing never waits: it picks versions by date).
export const workflowVersionActivate = inngest.createFunction(
  { id: 'workflow-version-activate', triggers: [{ event: 'bcs/workflow_version.published' }] },
  async ({ event, step }) => {
    const payload = event.data as { organizationId: string; aggregateId: string; data: { effectiveFrom: string } }
    await step.sleepUntil('until-effective', payload.data.effectiveFrom)
    return step.run('activate', async () => {
      const result = await activateWorkflowVersion(payload.organizationId, payload.aggregateId, systemClock.now())
      return result.ok ? { superseded: result.data.superseded } : { superseded: 0, reason: result.error.code }
    })
  },
)

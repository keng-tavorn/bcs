import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { applyScheduledChange } from '@/server/services/org-authority'

// Job `org-authority-apply` (spec §4.6, FR-DOA-010 AC4, BR-DOA-16/17): an approved authority change waits until its
// effective time, then is applied by the same service the tests call — holders change, open tasks move, people are
// told — without a deploy (EG-8). A change approved for now was applied with its approval; the job then has nothing to do.
export const orgAuthorityApply = inngest.createFunction(
  { id: 'org-authority-apply', triggers: [{ event: 'bcs/org_authority_change.approved' }] },
  async ({ event, step }) => {
    const payload = event.data as { organizationId: string; aggregateId: string; data: { status: string; effectiveFrom: string } }
    if (payload.data.status !== 'SCHEDULED') return { applied: false, reason: 'applied with the approval' }
    await step.sleepUntil('until-effective', payload.data.effectiveFrom)
    return step.run('apply', async () => {
      const result = await applyScheduledChange(payload.organizationId, payload.aggregateId, systemClock.now())
      return result.ok ? { applied: true } : { applied: false, reason: result.error.code }
    })
  },
)

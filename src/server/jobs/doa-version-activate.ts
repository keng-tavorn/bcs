import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { activateDoaVersion } from '@/server/services/doa'

// Job `doa-version-activate` (spec §4.6, BR-DOA-16, NEW-13): a version published for a later date waits until it takes
// effect, then the version it replaces becomes SUPERSEDED and the organization admins are told.
export const doaVersionActivate = inngest.createFunction(
  { id: 'doa-version-activate', triggers: [{ event: 'bcs/doa_version.published' }] },
  async ({ event, step }) => {
    const payload = event.data as { organizationId: string; aggregateId: string; data: { effectiveFrom: string } }
    await step.sleepUntil('until-effective', payload.data.effectiveFrom)
    return step.run('activate', async () => {
      const result = await activateDoaVersion(payload.organizationId, payload.aggregateId, systemClock.now())
      return result.ok ? { superseded: result.data.superseded } : { superseded: 0, reason: result.error.code }
    })
  },
)

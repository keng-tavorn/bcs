import { serve } from 'inngest/next'
import { inngest } from '@/server/inngest'
import { functions } from '@/server/jobs'

// Inngest calls this endpoint to run jobs (GET is introspection only and changes nothing).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Seconds one invocation may run: an outbox-sweeper run uses up to OUTBOX_SWEEP_BUDGET_MS (40 s) plus one last
// send of OUTBOX_SWEEP_SEND_TIMEOUT_MS (10 s). Next.js reads this as a literal, so it cannot be computed.
export const maxDuration = 60

export const { GET, POST, PUT } = serve({ client: inngest, functions })

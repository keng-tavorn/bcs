import { serve } from 'inngest/next'
import { inngest } from '@/server/inngest'
import { functions } from '@/server/jobs'

// Inngest calls this endpoint to run jobs (GET is introspection only and changes nothing).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Seconds one invocation may run: an outbox-sweeper run uses up to OUTBOX_SWEEP_BUDGET_MS (40 s) plus one last
// send of OUTBOX_SWEEP_SEND_TIMEOUT_MS (10 s), and a step of staging-first-seed (ADR-055) runs the demo history, some
// 7,000 statements, in one call. 300 s is the most Vercel allows on every plan. Next.js reads this as a literal, so it
// cannot be computed.
export const maxDuration = 300

export const { GET, POST, PUT } = serve({ client: inngest, functions })

import { serve } from 'inngest/next'
import { inngest } from '@/server/inngest'
import { functions } from '@/server/jobs'

// Inngest calls this endpoint to run jobs (GET is introspection only and changes nothing).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET, POST, PUT } = serve({ client: inngest, functions })

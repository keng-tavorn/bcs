import type { Ctx } from '@/server/context'
import { isAgentAvailable } from '@/server/services/ai'
import type { AiReadActions } from '@/ui/ai/types'
import { aiResultAction, readDocumentAction } from './ai-actions'
import { downloadUrlAction } from './file-actions'

/**
 * The Document Agent's actions for a page, only when it is available to this member now (BR-AI-11, FR-AI-303 AC8): with
 * AI switched off for the system, the organization or the agent, the page shows no AI button and the form is filled by
 * hand as before (EG-1). The calls check the gates again.
 */
export async function documentAiFor(ctx: Ctx): Promise<AiReadActions | undefined> {
  const availability = await isAgentAvailable(ctx, 'DOCUMENT')
  return availability.available ? { start: readDocumentAction, result: aiResultAction, fileUrl: downloadUrlAction } : undefined
}

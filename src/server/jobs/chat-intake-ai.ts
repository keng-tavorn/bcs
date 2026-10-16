import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { linkChatIntakeAgentAction, readChatIntakeWithAi, type ChatAiRead } from '@/server/services/chat-intake'

// Job `chat-intake-ai` (S17-08 · BR-LINE-13 · FR-LINE-301 AC5 · ADR-162): after the messages and photos of a chat draft
// settle (a debounce per draft), the Intake Agent of S13 reads it in one step (src/server/services/chat-intake/ai.ts) and
// its AgentAction is linked to the draft in another, so a retry of the link never calls the model again. Not the webhook:
// the chat answers at once, whatever the AI does. Nothing is sent in the chat when the reading ends.
export const CHAT_INTAKE_AI_EVENTS = ['chat_intake.opened', 'chat_intake.message_added', 'chat_intake.image_fetched'] as const
export const CHAT_INTAKE_AI_RETRIES = 3
/** How long the draft must stay quiet before it is read: messages typed one after another are read together */
export const CHAT_INTAKE_AI_DEBOUNCE = '20s'

const Payload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid() })

export interface ChatIntakeAiStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

/** One run, called directly by tests with their own step */
export async function chatIntakeAiRun(event: { data: unknown }, step: ChatIntakeAiStep): Promise<ChatAiRead | { readonly status: 'LINKED' | 'NOT_LINKED'; readonly agentActionId: string } | { readonly ignored: 'NOT_A_DRAFT_EVENT' }> {
  const payload = Payload.safeParse(event.data)
  if (!payload.success) return { ignored: 'NOT_A_DRAFT_EVENT' }
  const { organizationId, aggregateId } = payload.data
  const read = await step.run('read', () => readChatIntakeWithAi(organizationId, aggregateId, systemClock.now()))
  if (read.status !== 'READ') return read
  const linked = await step.run('link', () => linkChatIntakeAgentAction(organizationId, aggregateId, read.agentActionId, systemClock.now()))
  return { status: linked === 'LINKED' ? 'LINKED' : 'NOT_LINKED', agentActionId: read.agentActionId }
}

export const chatIntakeAi = inngest.createFunction(
  {
    id: 'chat-intake-ai',
    retries: CHAT_INTAKE_AI_RETRIES,
    debounce: { key: 'event.data.aggregateId', period: CHAT_INTAKE_AI_DEBOUNCE },
    concurrency: { limit: 1, key: 'event.data.aggregateId' },
    triggers: CHAT_INTAKE_AI_EVENTS.map((e) => ({ event: `bcs/${e}` as const })),
  },
  async ({ event, step }) => chatIntakeAiRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)

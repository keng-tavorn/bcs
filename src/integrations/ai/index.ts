// The AI adapter (P-3): only src/server/services/ai/agents, src/server/jobs/ai-* and scripts/ai-eval* import it
// (eslint.config.mjs, INV-AI-05)
export * from './client'
export { PROMPTS, type PromptText } from './prompts'
export { answerStreamResponse } from './stream'

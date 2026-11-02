import { z } from 'zod'
import { SUGGESTION_KEY_MAX, SUGGESTION_KINDS } from '@/lib/assistant-suggestions'
import { defineEvents } from '../registry'

// A member set a suggestion of the home card "ผู้ช่วยเจอให้คุณ" aside (NEW-121 · ADR-078). The aggregate is the member's
// own list of suggestions, keyed by their member id; the key names the situation (kind, document and its state).

defineEvents('Assistant', {
  'assistant.suggestion_dismissed': { schema: z.object({ kind: z.enum(SUGGESTION_KINDS), key: z.string().min(1).max(SUGGESTION_KEY_MAX) }) },
})

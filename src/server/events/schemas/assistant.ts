import { z } from 'zod'
import { SUGGESTION_KEY_MAX, SUGGESTION_KINDS } from '@/lib/assistant-suggestions'
import { defineEvents } from '../registry'

// A member set a suggestion of the home card "ผู้ช่วยเจอให้คุณ" aside (NEW-121 · ADR-078). The aggregate is the member's
// own list of suggestions, keyed by their member id; the key names the situation (kind, document and its state).

defineEvents('Assistant', {
  'assistant.suggestion_dismissed': { schema: z.object({ kind: z.enum(SUGGESTION_KINDS), key: z.string().min(1).max(SUGGESTION_KEY_MAX) }) },
})

// NEW-125 (ADR-083): an ORG_ADMIN switched a thing an assistant learned off or on again, or made it forget what was
// confirmed so far. The aggregate is the AssistantLearning row; data names the supplier by id (never its tax id, which
// is a person's id for a natural person) and the code the assistant offered at that moment.
const learning = {
  kind: z.enum(['ACCOUNT_CODE']),
  supplierId: z.uuid(),
  categoryCode: z.string().max(100).nullable(),
  accountCode: z.string().min(1).nullable(),
  uses: z.number().int().nonnegative(),
}
defineEvents('AssistantLearning', {
  'assistant_learning.disabled': { schema: z.object(learning) },
  'assistant_learning.enabled': { schema: z.object(learning) },
  'assistant_learning.forgotten': { schema: z.object({ ...learning, forgottenAt: z.iso.datetime({ offset: true }) }) },
})

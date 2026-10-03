import { z } from 'zod'
import { defineEvents } from '../registry'

// Security events of the business flows (spec §10.2 "ความปลอดภัย"). Sign-in events are in auth.ts.

defineEvents('Security', {
  // A decision or action refused by separation of duties (BR-SOD-01..08); kept even though the command is refused
  'security.sod_blocked': {
    schema: z.object({ rule: z.string().min(1), action: z.string().min(1), subjectType: z.string().min(1), subjectId: z.uuid(), actorMemberId: z.uuid() }),
  },
  // BR-TOK-02, BR-TOK-03: a LINE button or e-mail link used by someone it was not sent to; kept although refused
  'security.token_misuse': { schema: z.object({ tokenId: z.uuid(), channel: z.enum(['LINE', 'EMAIL']), taskId: z.uuid(), actorMemberId: z.uuid().nullable() }) },
})

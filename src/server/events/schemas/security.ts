import { z } from 'zod'
import { defineEvents } from '../registry'

// Security events of the business flows (spec §10.2 "ความปลอดภัย"). Sign-in events are in auth.ts.

defineEvents('Security', {
  // A decision or action refused by separation of duties (BR-SOD-01..08); kept even though the command is refused
  // S10-06 (BR-RFX-06): a member asked for the prices of a sealed RFx before its close and was refused
  'security.sealed_bid_denied': { schema: z.object({ rfxEventId: z.uuid(), bidId: z.uuid(), actorMemberId: z.uuid().nullable() }) },
  'security.sod_blocked': {
    schema: z.object({ rule: z.string().min(1), action: z.string().min(1), subjectType: z.string().min(1), subjectId: z.uuid(), actorMemberId: z.uuid() }),
  },
  // BR-TOK-02, BR-TOK-03: a LINE button or e-mail link used by someone it was not sent to; kept although refused
  // S7-04 (BR-PORTAL ข้อ 04): a portal request over its rate limit; the scope by kind only, never an IP or an e-mail
  'security.rate_limited': { schema: z.object({ scopeKind: z.enum(['IP', 'CONTACT', 'SUPPLIER', 'APPLICATION']), bucket: z.enum(['LINK', 'OTP', 'UPLOAD', 'INVOICE']), contactId: z.uuid().nullable() }) },
  'security.token_misuse': { schema: z.object({ tokenId: z.uuid(), channel: z.enum(['LINE', 'EMAIL']), taskId: z.uuid(), actorMemberId: z.uuid().nullable() }) },
})

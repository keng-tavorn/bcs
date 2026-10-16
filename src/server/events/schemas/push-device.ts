import { z } from 'zod'
import { defineEvents } from '../registry'

// Devices of the BCS Go app that receive push (spec §10.2 push_device, S17-10, BR-AUTH-12, BR-NOTI-07). Codes and
// numbers only: never the push token, a device label or anything else typed on the phone (NFR-SEC-09).

defineEvents('PushDevice', {
  'push_device.registered': { schema: z.strictObject({ platform: z.enum(['ANDROID', 'IOS']), appVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/) }) },
  // USER and LOGOUT by the owner; DEACTIVATED with member.deactivated; UNREGISTERED by delivery when FCM no longer knows
  // the device; REPLACED when the token moved to another member or organization, or a sixth device came in use
  'push_device.revoked': { schema: z.strictObject({ reason: z.enum(['USER', 'LOGOUT', 'DEACTIVATED', 'UNREGISTERED', 'REPLACED']) }) },
})

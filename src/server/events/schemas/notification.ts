import { z } from 'zod'
import { defineEvents } from '../registry'

// Notifications read by their recipient (FR-NOTI-001 AC1, NEW-16). The aggregate is the recipient's notification box,
// keyed by their member id; one event per action, with how many were marked.

defineEvents('Notification', {
  'notification.read': { schema: z.object({ count: z.number().int().positive(), all: z.boolean() }) },
})

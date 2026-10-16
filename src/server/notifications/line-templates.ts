// The §10.1 rows that go by LINE (and, with the BCS Go app, by push first: BR-NOTI-05, S17-10). A file of its own,
// without the database, so the golden runner of notification-route and the push titles' test read the same list as
// deliverNotification (./deliver.ts).

/**
 * §10.1 rows whose channel is "LINE → อีเมล" (or LINE beside in-app): only these go to LINE. The rest — security notices,
 * administrators' notices that name members, reports — go by e-mail only.
 */
export const LINE_TEMPLATES: ReadonlySet<string> = new Set([
  'task.assigned',
  'task.review_assigned',
  'task.reminder',
  'task.overdue',
  'task.escalated',
  'request.approved',
  'request.decided',
  'request.info_requested',
  'request.info_provided',
  'request.follower_added',
  'po.approved',
  'po.send_bounced',
  'delegation.window',
  'doa.authority_changed',
  'digest.daily',
  // S8: differences of an invoice and the decision on its price variance (§10.1, BR-AP-09)
  'invoice.exception',
  'invoice.variance_decided',
])

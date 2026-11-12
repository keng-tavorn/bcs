// The §10.1 rows that go by LINE (and, with the BCS Go app, by push first: BR-NOTI-05, S17-10). A file of its own,
// without the database, so the golden runner of notification-route and the push titles' test read the same list as
// deliverNotification (./deliver.ts). S9's templates live in lane 2's own file (ADR-135).

import { PAYMENT_LINE_TEMPLATES } from './templates/payments'
import { SUPPLIER_LINE_TEMPLATES } from './templates/suppliers'

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
  // S17-05 (FR-LINE-303 AC5): the RECEIVER of a PO that went out, at once
  'po.sent_receiver',
  'delegation.window',
  'doa.authority_changed',
  'digest.daily',
  // S8: differences of an invoice and the decision on its price variance (§10.1, BR-AP-09)
  'invoice.exception',
  'invoice.variance_decided',
  // NEW-126: a question from the helper of a difference, with the numbers only (BR-NOTI-01)
  'invoice.question',
  // NEW-124: a nudge sent "ทาง LINE" from the follow-up assistant, the document's number only; task.follow_up_email,
  // sent "ทางอีเมล", is not here and goes by e-mail alone
  'task.follow_up',
  // S9, in lane 2's own file (ADR-135)
  ...PAYMENT_LINE_TEMPLATES,
  // S11-06 (BR-NOTI-12 · the notices table of docs/sub-specs/S11.md): a reviewer's task of a supplier risk assessment —
  // the card with "ผ่าน" and "ตีกลับ" to the slot's holder, and its reminder and overdue notice "LINE → อีเมล"
  'risk.review_assigned',
  'risk.review_reminder',
  'risk.review_overdue',
  // and the fallback's acknowledgement at escalateAt ("LINE → อีเมล" of the same row)
  'risk.review_escalated',
  // S11-09: a supplier's registry flag, to PROCUREMENT at once ("LINE → อีเมล" · REASSESS_REQUIRED); its OVERDUE notice
  // goes in the day's digest
  'risk.status_changed',
  // S7-07: an application overdue, to its inviter and PROCUREMENT at once
  ...SUPPLIER_LINE_TEMPLATES,
])

// The idempotencyKeys of the LIFF request pages (spec §4.3; FR-PLT-012 AC2): the services, the server actions and the
// autosave route take a uuid only (z.uuid()). They are the keys of every LIFF page — a uuid on every WebView of the LINE
// app, crypto.randomUUID or not — made in one place, ../submission-key.ts; the request pages keep importing these names.

export {
  /** A random version-4 uuid, with or without crypto.randomUUID */
  newLiffKey as newUuid,
  /** The key of one submission: the same while it is sent again after no answer came back, a new one after next() */
  useLiffSubmissionKey as useRequestKey,
} from '../submission-key'

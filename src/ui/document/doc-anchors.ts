// Not in the 'use client' header parts (doc-header-parts.tsx): a server module reads it too, and a value of a 'use client' module reaches a server module as a client reference,
// not the value (tests/unit/client-boundary.test.ts · S7-18)

/** Where a cancel form waits on the page: the menu opens it and moves there */
export const CANCEL_ANCHOR = 'cancel-document'

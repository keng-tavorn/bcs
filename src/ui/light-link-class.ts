// Not in the 'use client' light link (light-link.tsx): a server module reads it too, and a value of a 'use client' module reaches a server module as a client reference,
// not the value (tests/unit/client-boundary.test.ts · S7-18)

/** Looks like a text link, at least 44 px high (NFR-A11Y-02) */
export const LIGHT_LINK_CLASS = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

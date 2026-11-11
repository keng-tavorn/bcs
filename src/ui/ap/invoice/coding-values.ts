// Not in the 'use client' coding form (coding-form.tsx): a server module reads it too, and a value of a 'use client' module reaches a server module as a client reference,
// not the value (tests/unit/client-boundary.test.ts · S7-18)

/** The value of "no withholding" in the list of income types: never a code (codes are A-Z, 0-9 and _) */
export const NO_WITHHOLDING = '-'

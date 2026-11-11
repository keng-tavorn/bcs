// The steps of PROCUREMENT's on-behalf form (S7-09 · /suppliers/applications/[id]/edit): in a module of its own, not in
// the 'use client' form, because the server page reads the list too — a value of a client module reaches a server
// module as a client reference, not the array (S7-18 found the page failing with "includes is not a function")
export const ON_BEHALF_STEPS = ['company', 'tax', 'bank', 'send'] as const
export type OnBehalfStep = (typeof ON_BEHALF_STEPS)[number]

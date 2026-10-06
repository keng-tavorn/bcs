import { BYTES_PER_MIB } from '@/lib/constants'

// The largest e-Tax file the invoice page sends (S4-17, BR-IVC-05). The file travels in the request body to the
// server, which reads it, and the staging host refuses a request body above 4.5 MB on its own (Vercel, spec §5.1,
// ADR-032) — with an answer the page cannot read. 4 MiB stays clear of that, so the page refuses a larger file itself,
// in words, before sending it; the route refuses it too. An e-Tax PDF/A-3 with its fonts is usually a few hundred KB.

export const ETAX_MAX_MIB = 4
export const ETAX_MAX_BYTES = ETAX_MAX_MIB * BYTES_PER_MIB

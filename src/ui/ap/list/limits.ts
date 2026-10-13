import { ETAX_MAX_BYTES, ETAX_MAX_MIB } from '../../finance/limits'

// The largest invoice file /finance/invoices/new sends (S8-13, FR-AP-101 AC1): the file travels in the request body and
// the staging host refuses a body above 4.5 MB on its own, with an answer the page cannot read — the same limit as the
// tier-1 e-Tax reader (../../finance/limits.ts). The page refuses a larger file itself, in words, before sending it; the
// route refuses it too, and the service keeps its own MAX_UPLOAD_BYTES.

export const AP_FILE_MAX_MIB = ETAX_MAX_MIB
export const AP_FILE_MAX_BYTES = ETAX_MAX_BYTES
/** What the file input offers to choose; the server decides by the file's bytes */
export const AP_FILE_ACCEPT = '.pdf,.xml,.jpg,.jpeg,.png,application/pdf,application/xml,text/xml,image/jpeg,image/png'

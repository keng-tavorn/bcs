import { MS_PER_MINUTE } from './constants'

// Rate limits and fixed times of the supplier portal (BR-PORTAL ข้อ 03 ข้อ 04 · NFR-SEC-05): rules of the platform's
// security, the same for every organization, so constants with their tests rather than settings.

/** One window of the link and code limits */
export const PORTAL_RATE_WINDOW_MS = 15 * MS_PER_MINUTE
/** Per IP (its hash) in a window: e-mailed links asked for, and codes asked for or tried */
export const PORTAL_IP_LIMITS = { LINK: 10, OTP: 20 } as const
/** Per contact in a window: links and codes asked for, together */
export const PORTAL_CONTACT_LIMIT = 3
/** Per supplier or application: files uploaded an hour, invoice drafts a day (S7-06 · S7-12) */
export const PORTAL_UPLOADS_PER_HOUR = 30
export const PORTAL_INVOICE_DRAFTS_PER_DAY = 20
/** lastSeenAt of a session moves at most once a minute */
export const PORTAL_SESSION_TOUCH_MS = MS_PER_MINUTE
/** A device not seen this many days signing in is a new device (BR-PORTAL ข้อ 02: supplier.new_device) */
export const PORTAL_NEW_DEVICE_DAYS = 90
/** How long the browser keeps the code it is asked for (the page between the link and the code) */
export const PORTAL_PENDING_COOKIE_MS = 15 * MS_PER_MINUTE

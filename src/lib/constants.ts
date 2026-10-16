// Technical (non-money) constants ≥ 1000 live here — the only src/lib file exempt from bcs/no-money-literal.
// Never put approval limits, budget amounts or any other money value in this file (spec P-2).

export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND

/** Outbox rows older than this are re-sent by the outbox-sweeper job (spec §4.3 step 5). */
export const OUTBOX_SWEEP_AFTER_MS = 30 * MS_PER_SECOND

/** Interactive transaction limits for runCommand (Prisma). */
export const COMMAND_TX_MAX_WAIT_MS = 10 * MS_PER_SECOND
export const COMMAND_TX_TIMEOUT_MS = 20 * MS_PER_SECOND
/** SMTP waits, kept well inside COMMAND_TX_TIMEOUT_MS because a PO is e-mailed inside its command (FR-P2P-005) */
export const EMAIL_CONNECT_TIMEOUT_MS = 5 * MS_PER_SECOND
export const EMAIL_SOCKET_TIMEOUT_MS = 10 * MS_PER_SECOND

/** Transaction errors that are safe to retry (spec §4.3 step 6): Prisma write conflict, Postgres
 *  serialization_failure and deadlock_detected. */
export const RETRYABLE_TX_ERROR_CODES: ReadonlySet<string> = new Set(['P2034', '40001', '40P01'])

// ---------- Authentication (FR-AUTH-001..003, NFR-SEC-03..05) ----------
export const MS_PER_HOUR = 60 * MS_PER_MINUTE
export const MS_PER_DAY = 24 * MS_PER_HOUR
export const PASSWORD_MIN_LENGTH = 12
/** Longest password Better Auth takes (src/server/auth/auth.ts); the new-password form says it before sending */
export const PASSWORD_MAX_LENGTH = 128
/** Web session: absolute lifetime 12 h, idle 30 min; LIFF: idle 15 min (FR-AUTH-003 AC1) */
export const SESSION_ABSOLUTE_MS = 12 * MS_PER_HOUR
export const SESSION_IDLE_WEB_MS = 30 * MS_PER_MINUTE
export const SESSION_IDLE_LIFF_MS = 15 * MS_PER_MINUTE
/** Only touch Session.lastActiveAt when it is older than this (limits writes) */
export const SESSION_TOUCH_AFTER_MS = MS_PER_MINUTE
/** Lockout: 5 failed sign-ins within 15 minutes per account or per IP (FR-AUTH-001 AC3, NFR-SEC-05) */
export const LOGIN_FAILURE_LIMIT = 5
export const LOGIN_FAILURE_WINDOW_MS = 15 * MS_PER_MINUTE
/** NFR-SEC-05: API calls per member per window (the ⌘K search, FR-PLT-014 AC5) */
export const API_RATE_LIMIT_PER_WINDOW = 60
export const API_RATE_LIMIT_WINDOW_MS = MS_PER_MINUTE
/** The ⌘K search (FR-PLT-014 AC3): fewest characters that start a search, and results per group (shared by server and screen) */
export const SEARCH_MIN_LENGTH = 2
export const SEARCH_GROUP_LIMIT = 5
/**
 * Better Auth's own lock of the second sign-in step (its two-factor plugin's accountLockout, on by default): this many
 * wrong codes in a row, across sign-ins and backup codes, pause the account's second step for TWO_FACTOR_LOCK_MS — even
 * for the right code. Named here (Better Auth's defaults) so the sign-in pages can say this lock in its own words
 * (src/ui/auth/lock-message.ts), apart from ours above.
 */
export const TWO_FACTOR_LOCK_LIMIT = 10
export const TWO_FACTOR_LOCK_MS = 15 * MS_PER_MINUTE
/** A step-up (the second factor again for one sensitive approval) is good for 5 minutes and one use (NFR-SEC-04) */
export const STEP_UP_TTL_MS = 5 * MS_PER_MINUTE
/** TOTP codes of the step before and after are accepted too, for clocks that drift (RFC 6238 §5.2) */
export const TOTP_ACCEPTED_DRIFT_STEPS = 1
/** Rows one budget import may hold (FR-BUD-001) */
export const BUDGET_IMPORT_MAX_ROWS = 1000
/** Invitation links are single-use and valid for 72 hours (FR-AUTH-001 AC1) */
export const INVITATION_TTL_MS = 72 * MS_PER_HOUR
/** An ActionToken lives 72 hours or until its task closes, whichever comes first (BR-TOK-01) */
export const ACTION_TOKEN_TTL_MS = 72 * MS_PER_HOUR
/** Password reset links */
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60

/** Longest free-text reason accepted by admin commands (stored in Comment) */
export const REASON_MAX_LENGTH = 1000
/** A share as tenths of a percent: 13 of 17 → 765 → "76.5" (KPI reports, §11.4) */
export const PERCENT_TENTHS_SCALE = 1000n
/** Events on one page of the audit search (FR-VIS-004 AC1) */
export const AUDIT_PAGE_MAX = 100
/** Events one audit export file takes: a wider search is narrowed first (FR-VIS-004 AC2) */
export const AUDIT_EXPORT_MAX_ROWS = 50_000
/** Most invoices one Express file takes when exporting again by hand (BR-EXP-02) */
export const EXPORT_MAX_INVOICES = 5000
/** Longest note to a supplier on a PO (FR-P2P-003 AC2) */
export const PO_NOTE_MAX_LENGTH = 2000
/** Longest payment term a PO takes, in days */
export const PAYMENT_TERM_MAX_DAYS = 3650
/** The language cookie is remembered for a year (FR-PLT-002 AC2) */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
/** A LINE ID token is a JWT of a few hundred bytes; anything far longer is refused before it is sent to LINE */
export const LIFF_ID_TOKEN_MAX_LENGTH = 8192

// ---------- Upload sizes (FR-PLT-004 AC1, FR-ADM-001 AC3) ----------
export const BYTES_PER_KIB = 1024
export const BYTES_PER_MIB = 1024 * BYTES_PER_KIB
/** Attachments: at most 20 MB (NFR-SEC-08) */
export const MAX_UPLOAD_BYTES = 20 * BYTES_PER_MIB
/** The member import file goes through a server action, and Next.js refuses action bodies above 1 MB; 500 rows of the
 *  template (IMPORT_MAX_ROWS) are far below this. Checked in the browser and again on the server. */
export const MEMBER_IMPORT_MAX_BYTES = 900 * BYTES_PER_KIB
/** Largest DOA YAML file the import reads (FR-DOA-001 AC2); a DOA of any real organization is a few kilobytes */
export const DOA_YAML_MAX_CHARS = 500_000
/** Largest file read out of a PDF (an e-Tax invoice's XML, BR-IVC-05, is tens of kilobytes); a stream that inflates
 *  past this is skipped, so a small hostile PDF cannot fill the server's memory */
export const MAX_EMBEDDED_FILE_BYTES = 5 * BYTES_PER_MIB
/** react-pdf minPresenceAhead (points) larger than any page: the last line row always moves with the totals block */
export const PDF_KEEP_WITH_TOTALS_PT = 2000
/** Longest file name accepted from the browser before it is cleaned (cleanFileName shortens what is stored) */
export const FILE_NAME_INPUT_MAX = 1000
/** Photos are scaled so the long side is at most this many pixels before upload (FR-PLT-004 AC3) */
export const MAX_IMAGE_SIDE_PX = 2000

// ---------- Command pipeline and outbox relay (spec §4.3–4.4, FR-PLT-012, NFR-OBS-02) ----------
/** pg pool size per server process. The pooled DATABASE_URL (Neon, transaction mode) multiplexes these. */
export const DB_POOL_MAX = 10
/** How long a query waits for a free pooled connection before failing */
export const DB_POOL_ACQUIRE_TIMEOUT_MS = 10 * MS_PER_SECOND
/** SET LOCAL lock_timeout of every command transaction: a duplicate delivery or a contended row waits at most this long */
export const COMMAND_LOCK_TIMEOUT_MS = 3 * MS_PER_SECOND
/** SET LOCAL statement_timeout, below COMMAND_TX_TIMEOUT_MS so Postgres stops a stuck statement first */
export const COMMAND_STATEMENT_TIMEOUT_MS = 15 * MS_PER_SECOND
/** lock_not_available, query_canceled and Prisma's "timed out fetching a connection from the pool": the item or the
 *  database is busy. The whole command is retried COMMAND_BUSY_RETRIES times, then answered RATE_LIMITED. Waiting
 *  for a pooled connection (DB_POOL_ACQUIRE_TIMEOUT_MS, or the transaction's maxWait) is matched by message too. */
export const COMMAND_BUSY_ERROR_CODES: ReadonlySet<string> = new Set(['55P03', '57014', 'P2024'])
export const COMMAND_BUSY_RETRIES = 1
/** The post-commit send holds a response at most this long (send + bookkeeping); the sweeper is the backup */
export const OUTBOX_DISPATCH_TIMEOUT_MS = 2 * MS_PER_SECOND
/** ...of which the send itself (one request, never retried on the request path) may take this long */
export const OUTBOX_DISPATCH_SEND_TIMEOUT_MS = 1.5 * MS_PER_SECOND
/** outbox-sweeper: rows claimed per batch, time limit of one send, and time budget of one run (cron every minute).
 *  The Inngest route's maxDuration must cover the budget plus one last send. */
export const OUTBOX_SWEEP_BATCH_SIZE = 100
export const OUTBOX_SWEEP_SEND_TIMEOUT_MS = 10 * MS_PER_SECOND
export const OUTBOX_SWEEP_BUDGET_MS = 40 * MS_PER_SECOND
/** A claimed row is hidden from other sweeper runs this long, so a crashed run's rows come back by themselves */
export const OUTBOX_CLAIM_LEASE_MS = 2 * MS_PER_MINUTE
/** Retry delay after Inngest refused a message: base × 2^attempts, capped at OUTBOX_RETRY_MAX_MS. */
export const OUTBOX_RETRY_BASE_MS = 30 * MS_PER_SECOND
export const OUTBOX_RETRY_MAX_MS = 30 * MS_PER_MINUTE
/** A send that failed without proving the message at fault (Inngest unavailable, no answer, the request path) is due
 *  again after this long and counts no attempt. Under a minute, so the backlog goes out at the first sweep after
 *  Inngest returns (FR-PLT-012 AC3: within 2 minutes); a full minute would race the cron and miss a run. */
export const OUTBOX_UNAVAILABLE_RETRY_MS = 30 * MS_PER_SECOND
/** Refusals of a message (Inngest refused it when sent alone) after which it is dead (deadAt + alert). Only refusals
 *  count (Outbox.attempts); unavailability and sends without an answer never do, so an outage never kills a row. */
export const OUTBOX_MAX_ATTEMPTS = 10
export const OUTBOX_LAST_ERROR_MAX_LENGTH = 500
/** NFR-OBS-02: a sweeper run that could deliver nothing raises an alert once the oldest message it tried has waited
 *  this long (raised again on every such run until the backlog moves) */
export const OUTBOX_STALL_ALERT_AFTER_MS = 10 * MS_PER_MINUTE
/** /api/health: an outbox row waiting longer than this for its first delivery means events are not reaching Inngest
 *  (FR-PLT-012 AC3 expects 2 minutes). Staging adds its slower sweeper's interval (src/lib/job-cadence.ts, ADR-054). */
export const OUTBOX_STALL_HEALTH_MS = 5 * MS_PER_MINUTE

// ---------- LINE rich menus (§9.5, FR-LINE-004) ----------
/** The image of each BCS rich menu, in pixels (§9.5: 2500 × 843, LINE's large compact size); its areas share it out */
export const LINE_RICH_MENU_WIDTH_PX = 2500
export const LINE_RICH_MENU_HEIGHT_PX = 843
/** LINE takes a rich menu image of at most "1 MB", read the strict way: 1,000,000 bytes (the pictures of BCS are < 100 KB) */
export const LINE_RICH_MENU_IMAGE_MAX_BYTES = 1000 * 1000

// ---------- Workspace screens (S16) ----------
/** How long the browser remembers the menu collapsed or expanded (FR-PLT-013 AC2): the sidebar's cookie, 7 days */
export const SIDEBAR_STATE_MAX_AGE_S = (7 * MS_PER_DAY) / MS_PER_SECOND
/** The sidebar's cookie: "true" open, "false" collapsed; read by the workspace layout to draw the first page the same way */
export const SIDEBAR_STATE_COOKIE = 'sidebar_state'
/** Below this width (px) the workspace menu opens as a sheet from the left (§9.10 layout sizes) */
export const SIDEBAR_SHEET_BELOW_PX = 1024

/** Below this width the dialog that starts a new request opens as a drawer from the bottom (FR-INT-010 AC1) */
export const NEW_REQUEST_DRAWER_BELOW_PX = 768

/** More request types than this and the dialog that starts a new request offers a keyword search (FR-INT-010 AC3) */
export const NEW_REQUEST_SEARCH_OVER = 6

// ---------- S6 settings (src/lib/org-settings.ts) ----------
/** The longest window or lapse an S6 day setting takes: about ten years */
export const SETTINGS_MAX_DAYS = 3660
/** One hundred percent in basis points, and the highest budget alert threshold (ten times the current budget) */
export const BP_PER_WHOLE = 10_000
export const BUDGET_ALERT_MAX_BP = 10 * BP_PER_WHOLE
/** BR-BUD-17 default thresholds: 80 % and 100 % of the current budget */
export const BUDGET_ALERT_DEFAULT_BP: readonly number[] = [8 * (BP_PER_WHOLE / 10), BP_PER_WHOLE]
/** Basis points per 100% (700 bp = 7%): AI confidence and credit alert levels are written in bp (S13) */
export const BP_WHOLE = 10_000
/** Basis points in a whole (100 % = 10000 bp): a technical constant, not money */
export const BASIS_POINTS_WHOLE = 10_000

// ---------- S6-07 backtest (BR-WF-13, FR-DOA-103) ----------
/** The documents a backtest routes again: those sent in the last 90 days */
export const BACKTEST_WINDOW_DAYS = 90
/** FR-DOA-103 AC3: past this many documents the backtest runs as a job instead of while the page waits */
export const BACKTEST_SYNC_LIMIT = 500
/** A backtest reads only, up to BACKTEST_SYNC_LIMIT documents, in a transaction that may take longer than a command's */
export const BACKTEST_TX_TIMEOUT_MS = 120 * MS_PER_SECOND
/**
 * A report reads only, over a period of the organization's documents (collectKpis, the workflow reports of S6-20), in a
 * transaction that may take longer than Prisma's default 5 seconds: on the phase-1 workbook the workflow report alone
 * came near it
 */
export const REPORT_TX_TIMEOUT_MS = 60 * MS_PER_SECOND
/** SET LOCAL statement_timeout of a report's transaction, below REPORT_TX_TIMEOUT_MS so Postgres stops a stuck statement first */
export const REPORT_STATEMENT_TIMEOUT_MS = 50 * MS_PER_SECOND

/** S6-21 (BR-UAT-02): a configuration package is a small file — forms, rules and a catalogue; at 3 bytes a Thai character it stays under the 1 MB a server action takes */
export const CONFIG_PACKAGE_MAX_CHARS = 300_000
// S8-09 (ADR-124): a basis point per percent, the longest hold of a retention, and the lift that keeps PO line numbers
// unique while a split moves the lines after it
export const BP_PER_PERCENT = 100
export const RETENTION_HOLD_MAX_DAYS = 3_650
export const LINE_NO_SHIFT = 10_000

// S8-11 (FR-AP-108 AC4): tier-2 invoices the Express file takes, once ready for payment
export const AP_EXPORTABLE_STATUSES = ['READY_FOR_PAYMENT', 'IN_PAYMENT_RUN', 'PAID'] as const

// S17-01 (src/lib/s17-settings.ts): the highest value of the chat settings at 1000 or more. Text and images are the
// CHECKs of the S17 migration (char_length counts code points); a chat window lasts a day at most
export const CHAT_INTAKE_MAX_TEXT_CHARS = 2_000
export const CHAT_INTAKE_MAX_WINDOW_MINUTES = 1_440
export const CHAT_INTAKE_MAX_HOURLY_LIMIT = 1_000

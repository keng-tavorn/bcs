// Technical constants of src/core, kept in one place so bcs/no-money-literal can tell them from money limits (P-2: a
// limit always comes from DoaVersion or the organization's settings, never from code).

/** Basis points per 100% (700 bp = 7%) */
export const BP_PER_WHOLE = 10_000n
/** A quantity may have at most 4 decimals (§6.1 Decimal(18,4)) */
export const QUANTITY_SCALE = 10_000n
/** Decimal strings are compared exactly as integers scaled by 10^18 (no floating point) */
export const DECIMAL_COMPARE_SCALE = 10n ** 18n
/** Thai number words repeat every six digits (ล้าน) */
export const THAI_NUMBER_GROUP = 1_000_000n
export const MS_PER_MINUTE = 60_000
/** How far back a schedule looks for a round it missed: one day, so a missed round runs once (core/schedule) */
export const SCHEDULE_LOOK_BACK_MINUTES = 1_440
/** A business calendar with no working day within ten years is unusable: stop searching instead of looping forever */
export const MAX_CALENDAR_SEARCH_DAYS = 3660
/** Longest text a one-line form field takes (BR-FORM-01) */
export const FORM_TEXT_MAX_LENGTH = 2_000
/** Longest text a multi-line form field takes (BR-FORM-01) */
export const FORM_TEXTAREA_MAX_LENGTH = 10_000
/** AI credits (BR-AI-23): prices are micro-USD per million tokens and 1 credit = 1,000 micro-USD */
export const AI_PRICE_UNITS_PER_CREDIT = 1_000_000_000n
/** Minutes in a day (the age of a document in days, BR-AI-15) */
export const MINUTES_PER_DAY = 1_440

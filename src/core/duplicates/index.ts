// Duplicate requests and split purchases (spec §7.17, BR-DUP-01 to BR-DUP-05 · ADR-107 · S6-13): the line key the price
// reference shares (S6-11) and the checks of the submit. Pure.
export { lineKey, type KeyedLine } from './line-key'
export { checkDuplicates, DUPLICATE_STATUSES, type DupCandidate, type DupLine, type DupRecent, type DupSettings, type RequestFlagResult } from './check'

// The redactor of BR-AI-18: text the system puts together for the AI (Brief, Insight, Intake) and what a member typed on
// the web never carries a bank account number or the 13-digit id of a natural person. A Thai tax id that starts with 0
// is a juristic person (BR-TAXID-01) and stays: suppliers are recognised by it.

export const REDACTED = '[ปิดบัง]'

// A 13-digit id written plainly or as 1-2345-67890-12-3 (spaces or dashes), not starting with 0
const PERSON_ID = /(?<![\d-])[1-9][\s-]?\d{4}[\s-]?\d{5}[\s-]?\d{2}[\s-]?\d(?![\d-])/g
// A bank account: 10 to 12 digits in a row, or groups of digits joined by dashes (e.g. 123-4-56789-0)
const ACCOUNT_PLAIN = /(?<![\d-])\d{10,12}(?![\d-])/g
const ACCOUNT_DASHED = /(?<![\d-])\d{3}-\d{1,3}-\d{4,6}(?:-\d{1,3})?(?![\d-])/g

/** The text with every account number and personal id replaced by [ปิดบัง] */
export function redactForAi(text: string): string {
  return text.replace(PERSON_ID, REDACTED).replace(ACCOUNT_DASHED, REDACTED).replace(ACCOUNT_PLAIN, REDACTED)
}

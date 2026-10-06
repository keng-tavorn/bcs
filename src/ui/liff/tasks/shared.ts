// Small pieces both decision forms of a LIFF task page use (./decision.tsx, ./policy-decision.tsx), kept apart so a page
// loads only the form it shows (§9.4: a LIFF page's first JavaScript is at most 200 KB gzip with the LINE SDK).

/** The choice a LINE card's button opens the task's page with (§9.3: /liff/tasks/<taskId>?action=approve) */
export type LiffTaskAction = 'approve' | 'reject'

/** The ?action= of the page, when it is one a card sends; anything else opens the page as it is */
export function liffTaskAction(value: unknown): LiffTaskAction | null {
  return value === 'approve' || value === 'reject' ? value : null
}

/** A reason or a question needs this many characters, as on the web decision page; the service checks again */
export const REASON_MIN = 3

/** `length` digits, nothing else: the check made before a PIN is sent (the server checks again) */
export const pinComplete = (pin: string, length: number) => pin.length === length && /^[0-9]+$/.test(pin)

/** The focus goes back to a field the server refused (a wrong PIN): the message is read with it, and the next try starts there */
export const focusField = (id: string) => document.getElementById(id)?.focus()

/** Where a member sets their transaction PIN: a page of the web workspace, after a password sign-in (FR-AUTH-005 AC1) */
export const WEB_PIN_SETTINGS_PATH = '/settings/pin'

import { failedKey, NO_ANSWER, noAnswerKey, type ReceivingAction } from '../../receiving/failed'
import type { ReceivingErrorKey, ReceivingFailure } from '../../receiving/outcome'

// What the bar of the LIFF receiving page (./receive-flow.tsx) says of a check or a receipt that did not go through
// (§9.9 rule 7, FR-LINE-003 AC3): the refusal in the words of the workspace's receiving form (receiving.errors), picked
// by the mapping of error codes in ../../receiving/outcome.ts — fetched only when a refusal comes, so the page's first
// JavaScript does not carry it (§9.4: 200 KB gzip). A LIFF session that has ended says so and how to go on. When the
// server gave no answer (the signal dropped), or the mapping cannot be fetched either, the words come without it
// (../../receiving/failed.ts): a failed check says that nothing has been recorded yet and asks for the check again; a
// receipt with no answer that it is not certain it was recorded, and to press the same button again without changing
// anything (it is never recorded twice); a receipt the server refused, that it was not recorded.

export interface LiffFailureWords {
  /** A message of receiving.errors, with its values */
  readonly error: (key: ReceivingErrorKey, values?: Record<string, string>) => string
  /** The LIFF session has ended: nothing was sent, and how to go on */
  readonly sessionEnded: () => string
}

/** The part of ../../receiving/outcome.ts that words a refusal */
export interface FailureMapping {
  readonly receivingErrorKey: (failure: ReceivingFailure, action: ReceivingAction) => ReceivingErrorKey
  readonly receivingErrorValues: (failure: ReceivingFailure) => Record<string, string>
}

const loadMapping = (): Promise<FailureMapping> => import('../../receiving/outcome')

/** The words of a check or a receipt that the server refused or did not answer; `load` fetches the mapping */
export async function liffFailureText(failure: ReceivingFailure, action: ReceivingAction, words: LiffFailureWords, load: () => Promise<FailureMapping> = loadMapping): Promise<string> {
  if (failure.code === 'UNAUTHENTICATED') return words.sessionEnded()
  // No answer: there is nothing to look up, and without a signal the mapping could not be fetched either
  if (failure.code === NO_ANSWER.code) return words.error(noAnswerKey(action))
  try {
    const { receivingErrorKey, receivingErrorValues } = await load()
    return words.error(receivingErrorKey(failure, action), receivingErrorValues(failure))
  } catch {
    // The words could not be fetched (no connection): what happened in general, and what to do
    return words.error(failedKey(action))
  }
}

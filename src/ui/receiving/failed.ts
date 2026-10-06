import type { ReceivingFailure } from './outcome'

// What a receiving form says when its action did not go through and the screen knows no more (§9.9 rule 7: what
// happened and how to fix it): the server gave no answer — the signal dropped on site — or answered with a code the
// screen does not know. The words depend on the action. The check before recording (step 1, gr preview) writes
// nothing, so its failure says that nothing has been recorded yet and asks for the check again. Recording (the receipt,
// step 2, gr.post, and a request to close short) that the server refused says that nothing was recorded; recording that
// got no answer cannot know — the server may have recorded it before the answer was lost — so it says it is not certain,
// and to press the same button again without changing anything: the form keeps its idempotency key, so that press is
// the same submission and is never recorded twice (spec §4.3), while changing a quantity first would be refused as
// another one. Apart from ./outcome.ts and without imports of its own, so the LIFF receiving page says it without
// loading the mapping of every refusal (src/ui/liff/receiving/failure-text.ts, §9.4).

/** The receiving action that failed: the check before recording, or recording (the receipt, a request to close short) */
export type ReceivingAction = 'check' | 'record'

/** What a form holds when its server action gave no answer (the call threw: the signal dropped, no server was reached) */
export const NO_ANSWER: ReceivingFailure = { ok: false, code: 'FAILED' }

/** The receiving.errors key of an action that did not go through, when nothing more is known */
export function failedKey(action: ReceivingAction): 'CHECK_FAILED' | 'FAILED' {
  return action === 'check' ? 'CHECK_FAILED' : 'FAILED'
}

/** The receiving.errors key of an action that got no answer: recording may have gone through, so it is not said it did not */
export function noAnswerKey(action: ReceivingAction): 'CHECK_FAILED' | 'NO_ANSWER' {
  return action === 'check' ? 'CHECK_FAILED' : 'NO_ANSWER'
}

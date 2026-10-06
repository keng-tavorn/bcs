'use server'

import { linkThisLineAccount, unlinkLineInLiff, whichLineIsLinked } from '@/server/services/liff'
import type { ThisLineOutcome } from '@/ui/liff/link-refusal'
import { toActionFailure, type ActionOutcome } from '@/ui/tasks/outcome'
import { liffPage } from '../_lib/session'

// Browser-facing adapters of /liff/link (FR-LINE-001 AC2 AC3). Each reads the session of the LIFF page and hands the raw
// input to the service, which checks the member (self.lineLink), the state and LINE again: a hidden button is never the
// guard. How the member signed in (LINE or password) comes from the server's session, never from the browser. The ID
// token arrives in the action's request body only; nothing here logs or returns it.

const NO_SESSION = { ok: false, code: 'UNAUTHENTICATED' } as const

/** AC2: the member signed in inside LIFF links the LINE account the page was opened with (a code issued and spent at once) */
export async function linkThisLineAction(input: { idToken: string }): Promise<ActionOutcome> {
  const page = await liffPage()
  if (page.kind !== 'member') return NO_SESSION
  const linked = await linkThisLineAccount(page.ctx, { idToken: input?.idToken })
  return linked.ok ? { ok: true } : toActionFailure(linked.error)
}

/** A linked member's /liff/link: is the link to the LINE account this page is open in, or to another one? */
export async function checkThisLineAction(input: { idToken: string }): Promise<ThisLineOutcome> {
  const page = await liffPage()
  if (page.kind !== 'member') return NO_SESSION
  const which = await whichLineIsLinked(page.ctx, { idToken: input?.idToken })
  return which.ok ? { ok: true, link: which.data.link } : toActionFailure(which.error)
}

/** AC3: the member ends, from LINE (channel LIFF), the link the page showed: this LINE account's, or the other one's */
export async function unlinkLineAction(input: { idToken: string; which: 'this' | 'other' }, idempotencyKey: string): Promise<ActionOutcome> {
  const page = await liffPage()
  if (page.kind !== 'member') return NO_SESSION
  const ended = await unlinkLineInLiff(page.ctx, { idToken: input?.idToken, which: input?.which }, { idempotencyKey, signIn: page.session })
  return ended.ok ? { ok: true } : toActionFailure(ended.error)
}

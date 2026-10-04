'use server'

import { revalidatePath } from 'next/cache'
import { getLocale, getTranslations } from 'next-intl/server'
import { memberPrincipal } from '@/server/authz'
import { isTaskDocumentFile } from '@/server/queries/task-files'
import { getTaskAccess } from '@/server/queries/tasks'
import { getDownloadUrl } from '@/server/services/files'
import { formatDateTime } from '@/ui/format'
import type { LiffTaskResult } from '@/ui/liff/tasks/result'
import type { ActionOutcome } from '@/ui/tasks/outcome'
import type { TaskDecisionInput } from '@/ui/tasks/decision-panel'
import type { PolicyDecisionInput } from '@/ui/tasks/policy-decision'
import { taskRight } from '../../../(workspace)/_tracking/access'
import { askRequester, decidePolicy, decideRequestTask } from '../../../(workspace)/_tracking/commands'
import { localeOf, type Locale } from '../../../(workspace)/_tracking/present'
import { liffPage, type LiffPage } from '../../_lib/session'
import { liffTaskResult } from '../_lib/result'
import { liffSignedIn, type LiffSignedIn } from '../_lib/signed-in'
import { liffStepUpSession } from '../_lib/step-up'

// Browser-facing adapters of the LIFF decision page (§9.4 /liff/tasks/[id], FR-LINE-003 AC2, FR-DOA-004 AC1, BR-DOA-15,
// FR-AUTH-005 AC2, FR-PLT-004 AC2). Each reads the session of the LIFF page (liffPage: a LINE sign-in or a password one,
// channel LIFF) and hands the raw input to the same commands as the web decision page
// (src/app/(workspace)/_tracking/commands.ts), which parse it and run the services; the services check the decider
// (approval.decide), the task's state, separation of duties, the tick of a DOA version's boundary table and the step-up
// again (BR-AUTH-05), so a hidden button is never the guard. A decision that needs the PIN grants the step-up on channel
// LIFF, gives the session a new id (NFR-SEC-04, ../_lib/step-up.ts) — the session the action resolved at its start,
// with liffPage, before the PIN; an action that resolved none sends nothing on — and then decides with the context of
// channel LIFF, which the decision's Event and the timeline record. The idempotencyKey comes from the form (spec §4.3).
// The answer is in the member's words (../_lib/result.ts); the PIN goes nowhere but the check — never into a log, an
// error or the answer (NFR-SEC-09). A file of the task's document (a request's attachments and quotations, a PO's source
// requests' files, a variance's receipt photos) opens through an address valid a few minutes — only a file the task's
// page lists, for a member who may open that page, after the file service checks the document it belongs to again.

/** Home, the inbox, the request and the bell change after a decision, on the web and in LIFF */
function refreshed(outcome: ActionOutcome): ActionOutcome {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

async function answer(outcome: ActionOutcome, locale: Locale): Promise<LiffTaskResult> {
  const t = await getTranslations({ locale, namespace: 'tasks.errors' })
  return liffTaskResult(outcome, { error: (key, values) => t(key, values), time: (iso) => formatDateTime(locale, iso) })
}

const NO_SESSION: ActionOutcome = { ok: false, code: 'UNAUTHENTICATED' }

type MemberPage = Extract<LiffPage, { kind: 'member' }>

/**
 * The page's member and the session it stands on now, both read before anything is checked or decided; null when either
 * is missing — a session that ended between the two lookups too — so the action sends nothing on: no PIN is checked, no
 * try counted, no step-up granted, nothing decided
 */
async function signedIn(): Promise<{ page: MemberPage; step: LiffSignedIn } | null> {
  const page = await liffPage()
  if (page.kind !== 'member') return null
  const step = await liffSignedIn(page.member.id)
  return step ? { page, step } : null
}

/** Approve, return or reject a request, purchase-order or variance task; with the PIN when the task needs a step-up */
export async function decideLiffTaskAction(input: TaskDecisionInput, idempotencyKey: string): Promise<LiffTaskResult> {
  const [now, locale] = await Promise.all([signedIn(), getLocale().then(localeOf)])
  if (!now) return answer(NO_SESSION, locale)
  return answer(refreshed(await decideRequestTask(now.page.ctx, input, idempotencyKey, locale, liffStepUpSession(now.page.session, now.step))), locale)
}

/** Ask the requester for more information on a request task (FR-INT-009 AC3); asking needs no PIN */
export async function askLiffRequesterAction(input: { taskId: string; question: string }, idempotencyKey: string): Promise<LiffTaskResult> {
  const [page, locale] = await Promise.all([liffPage(), getLocale().then(localeOf)])
  if (page.kind !== 'member') return answer(NO_SESSION, locale)
  return answer(refreshed(await askRequester(page.ctx, input, idempotencyKey)), locale)
}

/**
 * BR-DOA-15: a DOA version or an authority change is approved or rejected with the PIN; a DOA version with a boundary
 * table is approved with the approver's tick of it and the version it compared with (FR-DOA-009 AC3, NEW-41)
 */
export async function decideLiffPolicyAction(input: PolicyDecisionInput, idempotencyKey: string): Promise<LiffTaskResult> {
  const [now, locale] = await Promise.all([signedIn(), getLocale().then(localeOf)])
  if (!now) return answer(NO_SESSION, locale)
  const principal = memberPrincipal(now.page.member.id, [])
  return answer(refreshed(await decidePolicy(now.page.ctx, principal, input, idempotencyKey, locale, liffStepUpSession(now.page.session, now.step))), locale)
}

/**
 * A file of the task's document, from its LIFF page (FR-PLT-004 AC2, §9.9 principle 5): an address valid a few minutes,
 * for a member who may open the task's page (as the page checks it) when the file is one of the files that page lists —
 * and the file service lets them see the document it belongs to. Null for anyone else, for any other file of the
 * organization, or without a session. The page binds the task's id (openLiffFileAction.bind(null, taskId)); both ids
 * come from the browser, so both are checked here.
 */
export async function openLiffFileAction(taskId: string, fileId: string): Promise<string | null> {
  const page = await liffPage()
  if (page.kind !== 'member' || typeof taskId !== 'string' || typeof fileId !== 'string') return null
  const access = await getTaskAccess(page.ctx, taskId)
  if (!access || taskRight(memberPrincipal(page.member.id, []), access) === 'NONE') return null
  if (!(await isTaskDocumentFile(page.ctx, access, fileId))) return null
  const url = await getDownloadUrl(page.ctx, { fileId })
  return url.ok ? url.data.url : null
}

'use server'

import { revalidatePath } from 'next/cache'
import { getLocale, getTranslations } from 'next-intl/server'
import { decideRiskReview } from '@/server/services/risk'
import { formatDateTime } from '@/ui/format'
import { liffPage } from '../../../_lib/session'
import { liffRiskResultOf, type LiffRiskDecisionInput, type LiffRiskResult, type LiffRiskWords } from './result'

// The browser-facing adapter of the LIFF page of a reviewer's task (S11-06 · FR-RSK-202 AC4 · BR-RSK-08 · BR-SOD-16):
// a POST server action — never a GET — that reads the LIFF page's session (liffPage: a LINE sign-in or a password one,
// channel LIFF) and hands the input to riskReview.decide, the command the workspace and the LINE button use. The command
// checks everything again: the RISK module, that the member holds the slot or acts for its holder now
// (risk.review.decide · INV-RSK-04), separation of duties (BR-SOD-16), the task's state and a return's reason, so a hidden
// button is never the guard. The idempotencyKey comes from the form (spec §4.3 · src/ui/liff/submission-key.ts). A
// reviewer needs no PIN (BR-WF-09 as S6's reviewers). The answer is in the member's words (./result.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function decideLiffRiskReviewAction(input: LiffRiskDecisionInput, idempotencyKey: string): Promise<LiffRiskResult> {
  const [page, locale] = await Promise.all([liffPage(), getLocale().then((l): 'th' | 'en' => (l === 'en' ? 'en' : 'th'))])
  const t = await getTranslations({ locale, namespace: 'liffRisk.review.errors' })
  const words: LiffRiskWords = { locale, error: (key, values) => t(key, values), time: (iso) => formatDateTime(locale, iso) }
  if (page.kind !== 'member') return { ok: false, at: 'form', text: t('signedOut'), signedOut: true }
  // Both come from the browser: anything but the shapes the form sends is refused before the command
  const shaped =
    typeof input === 'object' &&
    input !== null &&
    typeof input.taskId === 'string' &&
    (input.decision === 'PASS' || input.decision === 'RETURN') &&
    typeof idempotencyKey === 'string' &&
    UUID.test(idempotencyKey)
  if (!shaped) return { ok: false, at: 'form', text: t('other') }
  const result = await decideRiskReview(
    page.ctx,
    input.decision === 'PASS'
      ? { taskId: input.taskId, decision: 'PASS' }
      : { taskId: input.taskId, decision: 'RETURN', reason: typeof input.reason === 'string' ? input.reason : '', shareWithSupplier: input.shareWithSupplier === true },
    { idempotencyKey },
  )
  if (!result.ok) return liffRiskResultOf(result.error, words)
  // The member's reviews, the assessment and the bell change after a decision, on the web and in LIFF
  revalidatePath('/', 'layout')
  return { ok: true }
}

'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'
import { RISK_TEXT_MAX } from '@/lib/constants'
import { StatusBadge } from '../document/badges'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import { Panel } from '../page/page'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../shadcn/alert-dialog'
import { Button } from '../shadcn/button'
import { Checkbox } from '../shadcn/checkbox'
import { Label } from '../shadcn/label'
import { Textarea } from '../shadcn/textarea'
import { useBarSpace } from '../tasks/bar-space'
import { REVIEW_TASK_BADGES, reviewClosed, reviewFailureKey, type ReviewDecisionInput, type ReviewOutcome, type ReviewTaskStatus } from './model'

// The decision of a reviewer's slot of a supplier risk assessment (S11-06 · FR-RSK-202 AC3 · BR-RSK-08 · BR-WF-09):
// "ผ่าน" or "ตีกลับ", never a rejection and no PIN — a reviewer checks their own part, the money and the authority are
// not theirs. Each asks again in an Alert Dialog, since a decision cannot be changed (§9.9); a return needs its reason,
// and a tick lets those words reach the supplier (shareWithSupplier), otherwise only PROCUREMENT and the auditors read
// them. On phones the two buttons stick to the bottom of the screen (§9.9 rule 5) and the page keeps room for them
// (useBarSpace); on wide screens they head the page's right column. One try at a time, with the submission's key kept
// until an answer comes (§4.3). After a decision — or when the task turns out decided already, by whom and when — the
// page reloads and the panel shows the task as it stands: passed or returned, when, and the reason given.
// The command checks the holder, the state and separation of duties again (BR-SOD-16).

export interface ReviewDecisionProps {
  readonly status: ReviewTaskStatus
  /** The member may pass or return it now (the page's read; the command checks again) */
  readonly canDecide: boolean
  /** Open, yet not the member's to decide: why, in a word the page found */
  readonly blocked: 'NOT_DECIDER' | 'NOT_IN_REVIEW' | null
  /** The assessment's number, named in the confirmations */
  readonly number: string
  /** When the task was decided, formatted */
  readonly decidedAt: string | null
  /** The reason the slot returned it with */
  readonly myReason: string | null
  readonly decide: (input: ReviewDecisionInput, key: string) => Promise<ReviewOutcome>
}

type Failure = Extract<ReviewOutcome, { ok: false }>

function useReviewRun() {
  const router = useRouter()
  const submission = useSubmissionKey()
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  async function run(call: (key: string) => Promise<ReviewOutcome>): Promise<ReviewOutcome | null> {
    // A second press while the first is on its way is dropped: the same decision is never sent twice
    if (busy.current) return null
    busy.current = true
    setPending(true)
    let outcome: ReviewOutcome
    try {
      outcome = await call(submission.key)
      submission.next()
    } catch {
      // No answer: the key stays, so pressing again runs the same command once (INV-PLT-01)
      outcome = { ok: false, code: 'NO_ANSWER' }
    }
    busy.current = false
    setPending(false)
    if (outcome.ok || reviewClosed(outcome)) router.refresh()
    return outcome
  }
  return { pending, run }
}

export function ReviewDecision({ status, canDecide, blocked, number, decidedAt, myReason, decide }: ReviewDecisionProps) {
  const t = useTranslations('riskReview.decide')
  const tStatus = useTranslations('riskReview.taskStatus')
  const tErr = useTranslations('riskReview.errors')
  const locale = useLocale()
  const id = useId()
  const hydrated = useHydrated()
  const barRef = useBarSpace<HTMLDivElement>()
  const working = useReviewRun()
  const [reason, setReason] = useState('')
  const [share, setShare] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [closed, setClosed] = useState<string | null>(null)

  const failureText = (o: Failure): string => {
    const key = reviewFailureKey(o)
    if (key === 'DECIDED_BY') return tErr('DECIDED_BY', { name: (locale === 'en' ? o.nameEn : null) ?? o.name ?? '-', time: o.time ? formatDateTime(locale, o.time) : '-' })
    return tErr(key)
  }

  async function send(input: ReviewDecisionInput) {
    setFailure(null)
    const outcome = await working.run((key) => decide(input, key))
    if (!outcome) return
    if (outcome.ok) {
      setReason('')
      setShare(false)
      setDone(outcome.decision === 'RETURN' ? t('returned') : outcome.assessment === 'COMPLETED' ? t('passedCompleted') : t('passedOpen'))
    } else if (reviewClosed(outcome)) setClosed(failureText(outcome))
    else setFailure(outcome)
  }

  const deciding = canDecide && !done && !closed

  return (
    <Panel title={t('title')} id={`${id}-title`}>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {closed ? <Notice tone="danger">{closed}</Notice> : null}
      {status !== 'OPEN' ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge look={REVIEW_TASK_BADGES[status]} label={tStatus(status)} className="text-base md:text-sm" />
            {decidedAt ? <span className="text-ink-muted">{t('decidedAt', { time: decidedAt })}</span> : null}
          </div>
          {status === 'CANCELLED' ? <p className="text-ink-muted">{t('cancelled')}</p> : null}
          {status === 'RETURNED' && myReason ? (
            <div className="flex flex-col gap-1">
              <span className="font-medium">{t('myReason')}</span>
              <p className="border-l-4 border-line pl-3 break-words whitespace-pre-wrap">{myReason}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {status === 'OPEN' && !canDecide && blocked && !done ? <Notice tone="info">{blocked === 'NOT_IN_REVIEW' ? t('notInReview') : t('notDecider')}</Notice> : null}
      {deciding ? (
        <>
          <p className="text-ink-muted">{t('hint')}</p>
          {/* Phones: the two buttons stick to the bottom of the screen; wide screens: they stay in this card */}
          <div
            ref={barRef}
            data-decision-bar=""
            className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0"
          >
            {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
            <div className="flex flex-wrap gap-3">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button className="min-h-11 flex-1 text-base lg:min-h-10" disabled={!hydrated || working.pending}>
                    {working.pending ? t('working') : t('pass')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('passTitle', { number })}</AlertDialogTitle>
                    <AlertDialogDescription>{t('passBody')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="min-h-11 text-base">{t('keep')}</AlertDialogCancel>
                    <AlertDialogAction className="min-h-11 text-base" onClick={() => void send({ decision: 'PASS' })}>
                      {t('pass')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" className="min-h-11 flex-1 text-base lg:min-h-10" disabled={!hydrated || working.pending}>
                    {t('return')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('returnTitle', { number })}</AlertDialogTitle>
                    <AlertDialogDescription>{t('returnBody')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-reason`} className="text-base">
                      {t('reason')}
                    </Label>
                    <p id={`${id}-reason-hint`} className="text-base text-ink-muted md:text-sm">
                      {t('reasonHint')}
                    </p>
                    <Textarea
                      id={`${id}-reason`}
                      value={reason}
                      maxLength={RISK_TEXT_MAX}
                      aria-required="true"
                      aria-describedby={`${id}-reason-hint`}
                      onChange={(e) => setReason(e.target.value)}
                      className="min-h-24 bg-bg text-base md:text-base"
                    />
                  </div>
                  <label htmlFor={`${id}-share`} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
                    <Checkbox id={`${id}-share`} checked={share} onCheckedChange={(v) => setShare(v === true)} aria-describedby={`${id}-share-hint`} className="mt-1.5" />
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium text-ink">{t('share')}</span>
                      <span id={`${id}-share-hint`} className="text-base text-ink-muted md:text-sm">
                        {t('shareHint')}
                      </span>
                    </span>
                  </label>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="min-h-11 text-base">{t('keep')}</AlertDialogCancel>
                    <AlertDialogAction
                      className="min-h-11 text-base"
                      disabled={reason.trim() === ''}
                      onClick={() => void send({ decision: 'RETURN', reason: reason.trim(), shareWithSupplier: share })}
                    >
                      {t('return')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </>
      ) : null}
    </Panel>
  )
}

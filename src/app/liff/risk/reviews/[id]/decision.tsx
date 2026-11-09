'use client'

import { useRouter } from 'next/navigation'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { RISK_TEXT_MAX } from '@/lib/constants'
import { useHydrated } from '@/ui/form/hydrated'
import { LiffActionBar } from '@/ui/liff/action-bar'
import { Button } from '@/ui/liff/button'
import { LiffContent, LiffSection } from '@/ui/liff/content'
import { useLiff } from '@/ui/liff/liff-provider'
import { LiffNotice } from '@/ui/liff/notice'
import { useLiffSubmissionKey } from '@/ui/liff/submission-key'
import { LiffTextArea, LiffTick } from '@/ui/liff/tasks/fields'
import type { LiffRiskDecisionInput, LiffRiskFailure, LiffRiskResult } from './result'

// The decision of a reviewer's task of a supplier risk assessment on its LIFF page (S11-06 · FR-RSK-202 AC4 · BR-RSK-08 ·
// §9.4 · §9.9 principles 5 and 7), laid out as the LIFF decision page of an approval task (src/ui/liff/tasks/decision.tsx):
//  - the bar at the bottom of the screen holds "ผ่าน", the one filled button; it asks for a second press that names the
//    assessment, because a decision cannot be changed. Under it, the way to the return;
//  - the return lives apart, in its own section at the end of the page: a required reason, the tick
//    "ส่งข้อความนี้ถึงผู้ขายได้" (shareWithSupplier · BR-RSK-08: unticked, the supplier never reads the words) and the
//    tick that confirms an irreversible step. A reviewer never rejects (BR-WF-09);
//  - nothing is sent before the page's script runs (method="post", buttons wait for hydration), one try at a time, with
//    the LIFF session kept first (useLiff().ensureSession) and one idempotencyKey per submission, reused when no answer
//    came back (spec §4.3).
// Its words come from the server already in the member's language (props): the page's client messages stay the LIFF
// gate's (src/i18n/client-messages.ts), so this page adds nothing to another part's first load.

export interface RiskDecisionWords {
  readonly barLabel: string
  readonly pass: string
  readonly confirmText: string
  readonly confirm: string
  readonly checkFirst: string
  readonly passed: string
  readonly returnLink: string
  readonly returnTitle: string
  readonly returnHint: string
  readonly reason: string
  readonly reasonHint: string
  readonly share: string
  readonly shareHint: string
  readonly confirmReturn: string
  readonly submitReturn: string
  readonly returned: string
  readonly working: string
  readonly reasonError: string
  readonly confirmError: string
  readonly signedOut: string
  readonly failed: string
  readonly reload: string
}

export interface LiffRiskDecisionProps {
  readonly taskId: string
  /** The member may pass or return it now (the command checks again) */
  readonly open: boolean
  readonly words: RiskDecisionWords
  readonly decide: (input: LiffRiskDecisionInput, idempotencyKey: string) => Promise<LiffRiskResult>
  readonly children: ReactNode
}

/** The return's section, which the bar links to */
const RETURN_ID = 'risk-review-return'
/** A reason needs this many characters, as on the LIFF decision page of a task; the command checks again */
const REASON_MIN = 3

/** One form's sending (as useLiffSend of src/ui/liff/tasks/send.tsx, with the words handed in) */
function useSend(words: RiskDecisionWords) {
  const liff = useLiff()
  const submission = useLiffSubmissionKey()
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const send = async (run: (idempotencyKey: string) => Promise<LiffRiskResult>): Promise<LiffRiskResult | null> => {
    if (busy.current) return null
    busy.current = true
    setPending(true)
    try {
      const session = await liff.ensureSession()
      if (!session.ok && session.final) {
        if (session.reason === 'TOKEN_INVALID' && liff.reloadForNewToken()) return null
        return { ok: false, at: 'form', text: words.signedOut, signedOut: true }
      }
      try {
        const result = await run(submission.key)
        submission.next()
        return result
      } catch {
        // No answer came back (the network): the key stays, so sending again is the same submission
        return { ok: false, at: 'form', text: words.failed }
      }
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { pending, send }
}

function Refusal({ failure, reload }: { readonly failure: LiffRiskFailure; readonly reload: string }) {
  return (
    <LiffNotice tone="danger">
      <p>{failure.text}</p>
      {failure.signedOut ? (
        <div className="mt-2">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {reload}
          </Button>
        </div>
      ) : null}
    </LiffNotice>
  )
}

export function LiffRiskDecision({ taskId, open, words, decide, children }: LiffRiskDecisionProps) {
  const id = useId()
  const router = useRouter()
  const hydrated = useHydrated()
  const passing = useSend(words)
  const returning = useSend(words)
  const [done, setDone] = useState<string | null>(null)
  const [closed, setClosed] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [passFailure, setPassFailure] = useState<LiffRiskFailure | null>(null)
  const [reason, setReason] = useState('')
  const [share, setShare] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({})
  const [returnFailure, setReturnFailure] = useState<LiffRiskFailure | null>(null)

  // The action revalidates the page, which is then drawn again as the task is now (its own notice says who decided)
  const finished = (text: string) => {
    setDone(text)
    window.scrollTo({ top: 0 })
  }

  /** Decided, moved or closed meanwhile: said at the top, and the page is drawn again as the task is now */
  const closedNow = (result: LiffRiskResult): boolean => {
    if (result.ok || result.at !== 'closed') return false
    setClosed(result.text)
    router.refresh()
    window.scrollTo({ top: 0 })
    return true
  }

  async function onPass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPassFailure(null)
    const result = await passing.send((key) => decide({ taskId, decision: 'PASS' }, key))
    if (!result) return
    if (result.ok) {
      setConfirming(false)
      finished(words.passed)
      return
    }
    if (!closedNow(result)) setPassFailure(result)
  }

  async function onReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = words.reasonError
    if (!confirmed) next.confirm = words.confirmError
    setErrors(next)
    if (next.reason || next.confirm) return
    setReturnFailure(null)
    const result = await returning.send((key) => decide({ taskId, decision: 'RETURN', reason: reason.trim(), shareWithSupplier: share }, key))
    if (!result) return
    if (result.ok) {
      finished(words.returned)
      return
    }
    if (closedNow(result)) return
    if (result.at === 'reason') {
      setErrors((e) => ({ ...e, reason: result.text }))
      document.getElementById(`${id}-reason`)?.focus()
      return
    }
    setReturnFailure(result)
  }

  /** The task still waits for this member, and this visit has not decided it */
  const active = open && !closed && !done
  return (
    <>
      <LiffContent>
        {/* What this visit decided, or that the task closed meanwhile (by whom, when), until the page drawn again says it
            itself — one notice */}
        {done && open ? <LiffNotice tone="success">{done}</LiffNotice> : null}
        {closed && open ? <LiffNotice tone="danger">{closed}</LiffNotice> : null}
        {children}

        {active ? (
          <LiffSection id={RETURN_ID} title={words.returnTitle}>
            <form method="post" onSubmit={onReturn} noValidate className="flex flex-col gap-4">
              {returnFailure ? <Refusal failure={returnFailure} reload={words.reload} /> : null}
              <p className="text-ink-muted">{words.returnHint}</p>
              <LiffTextArea
                id={`${id}-reason`}
                name="reason"
                label={words.reason}
                hint={words.reasonHint}
                value={reason}
                onChange={(value) => {
                  setReason(value)
                  setErrors((e) => ({ ...e, reason: undefined }))
                }}
                error={errors.reason}
                maxLength={RISK_TEXT_MAX}
              />
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-share`} className="flex min-h-11 items-start gap-3 py-1">
                  <input
                    id={`${id}-share`}
                    type="checkbox"
                    name="shareWithSupplier"
                    checked={share}
                    onChange={(event) => setShare(event.currentTarget.checked)}
                    aria-describedby={`${id}-share-hint`}
                    className="mt-1 size-5 shrink-0"
                  />
                  <span>{words.share}</span>
                </label>
                <p id={`${id}-share-hint`} className="text-ink-muted">
                  {words.shareHint}
                </p>
              </div>
              <LiffTick
                id={`${id}-confirm`}
                label={words.confirmReturn}
                checked={confirmed}
                onChange={(checked) => {
                  setConfirmed(checked)
                  setErrors((e) => ({ ...e, confirm: undefined }))
                }}
                error={errors.confirm}
              />
              <Button type="submit" variant="secondary" disabled={returning.pending || !hydrated} aria-busy={returning.pending || undefined} className="self-start">
                {returning.pending ? words.working : words.submitReturn}
              </Button>
            </form>
          </LiffSection>
        ) : null}
      </LiffContent>

      {active ? (
        <LiffActionBar label={words.barLabel}>
          {passFailure ? <Refusal failure={passFailure} reload={words.reload} /> : null}
          {confirming ? (
            <form method="post" onSubmit={onPass} noValidate>
              <div role="group" aria-labelledby={`${id}-confirm-text`} className="flex flex-col gap-3">
                <p id={`${id}-confirm-text`} className="font-medium text-ink">
                  {words.confirmText}
                </p>
                <div className="flex gap-3">
                  <Button type="submit" disabled={passing.pending || !hydrated} aria-busy={passing.pending || undefined} className="flex-1">
                    {passing.pending ? words.working : words.confirm}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setConfirming(false)
                      setPassFailure(null)
                    }}
                    disabled={passing.pending}
                  >
                    {words.checkFirst}
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <Button
              onClick={() => {
                setPassFailure(null)
                setConfirming(true)
              }}
              disabled={!hydrated}
              className="w-full"
            >
              {words.pass}
            </Button>
          )}
          <a href={`#${RETURN_ID}`} className="inline-flex min-h-11 items-center justify-center font-medium text-primary underline underline-offset-4 hover:no-underline">
            {words.returnLink}
          </a>
        </LiffActionBar>
      ) : null}
    </>
  )
}

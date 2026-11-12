'use client'

import { useId, useState, type FormEvent } from 'react'
import { Notice } from '../form/notice'
import { useFailureText, useRun } from '../risk-admin/run'
import type { RiskAdminOutcome } from '../risk-admin/model'
import { useSay } from '../risk-admin/say'
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Label } from '../shadcn/label'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import { Textarea } from '../shadcn/textarea'

// The buttons of /risk/assessments/[id] for PROCUREMENT (S11-05 · FR-RSK-201 AC5 · BR-RSK-01): fill in for the supplier
// (a Dialog of the questions of the set, one choice each; an answer from a certificate is shown and kept), send, and
// cancel with a reason (AlertDialog). The commands check risk.assessment.manage and the state again.
// S11-13 (FR-AI-306 AC2 · BR-AI-33): an answer the Risk Agent proposed shows under its question in the Dialog — what, the
// words it read and from where, how sure, a warning when no certificate backs it — and a question not answered yet starts
// from it; procurement ticks each one to confirm it (never all at once). The draft goes with the answers as aiAssist.

export interface FillQuestion {
  readonly code: string
  readonly text: string
  readonly options: readonly { readonly code: string; readonly label: string }[]
  readonly chosen: string | null
  /** An answer from a certificate: shown, not changed here */
  readonly locked: boolean
  /** The answer the AI proposed, with its words already in the page's language */
  readonly ai?: {
    readonly optionCode: string
    readonly proposed: string
    readonly details: readonly string[]
    readonly warning: string | null
    readonly confirmed: boolean
    readonly pending: boolean
  }
}

/** The AI's draft the Dialog takes in (agentActionId), and the words of its box */
export interface FillAi {
  readonly agentActionId: string
  readonly words: { readonly title: string; readonly intro: string; readonly confirm: string; readonly confirmed: string; readonly pending: string }
}

export type FillAiAssist = { readonly agentActionId: string; readonly confirmedPaths: string[] }

export interface AssessmentActions {
  readonly fill: (answers: { questionCode: string; optionCode: string }[], expectedVersion: number, key: string, aiAssist?: FillAiAssist) => Promise<RiskAdminOutcome>
  readonly submit: (expectedVersion: number, key: string) => Promise<RiskAdminOutcome>
  readonly cancel: (reason: string, expectedVersion: number, key: string) => Promise<RiskAdminOutcome>
}

export function AssessmentButtons({ version, questions, actions, ai }: { version: number; questions: readonly FillQuestion[]; actions: AssessmentActions; ai?: FillAi | null }) {
  const t = useSay('risk.assessment')
  const failureText = useFailureText()
  const working = useRun()
  const id = useId()
  const [filling, setFilling] = useState(false)
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const missingText = (o: RiskAdminOutcome) => (!o.ok && o.code === 'RISK_ANSWERS_INCOMPLETE' && o.missing?.length ? t('missing', { codes: o.missing.join(', ') }) : failureText(o))

  async function act(call: (key: string) => Promise<RiskAdminOutcome>, done: string) {
    setMessage(null)
    const outcome = await working.run(call)
    setMessage(outcome.ok ? { tone: 'success', text: done } : { tone: 'danger', text: missingText(outcome) })
  }

  return (
    <div className="flex flex-col gap-3">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11 lg:min-h-10" onClick={() => setFilling(true)}>
          {t('fill')}
        </Button>
        <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={working.pending} onClick={() => void act((key) => actions.submit(version, key), t('submitted'))}>
          {t('submit')}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={working.pending}>
              {t('cancel')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('cancelTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('cancelBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-reason`} className="text-base">
                {t('cancelReason')}
              </Label>
              <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-20 bg-bg text-base md:text-base" />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11 text-base">{t('keep')}</AlertDialogCancel>
              <AlertDialogAction className="min-h-11 text-base" disabled={reason.trim() === ''} onClick={() => void act((key) => actions.cancel(reason, version, key), t('cancelled'))}>
                {t('cancel')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {filling ? (
        <FillDialog
          questions={questions}
          ai={ai ?? null}
          onClose={() => setFilling(false)}
          fill={(answers, key, aiAssist) => actions.fill(answers, version, key, aiAssist)}
          onSaved={() => {
            setFilling(false)
            setMessage({ tone: 'success', text: t('filled') })
          }}
        />
      ) : null}
    </div>
  )
}

/** Opens an evidence file or a certificate in a new tab: a POST that checks risk.evidence.view each time (S11-05) */
export function OpenFileButton({ label, open }: { label: string; open: (key: string) => Promise<RiskAdminOutcome> }) {
  const failureText = useFailureText()
  const working = useRun()
  const [failure, setFailure] = useState<string | null>(null)

  async function onClick() {
    setFailure(null)
    const outcome = await working.run(open)
    if (!outcome.ok) setFailure(failureText(outcome))
    else if (outcome.url) window.open(outcome.url, '_blank', 'noopener')
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button variant="link" className="h-auto min-h-11 p-0 text-base lg:min-h-0" disabled={working.pending} onClick={() => void onClick()}>
        {label}
      </Button>
      {failure ? <span className="text-danger">{failure}</span> : null}
    </span>
  )
}

function FillDialog({
  questions,
  ai,
  fill,
  onClose,
  onSaved,
}: {
  questions: readonly FillQuestion[]
  ai: FillAi | null
  fill: (answers: { questionCode: string; optionCode: string }[], key: string, aiAssist?: FillAiAssist) => Promise<RiskAdminOutcome>
  onClose: () => void
  onSaved: () => void
}) {
  const t = useSay('risk.assessment')
  const failureText = useFailureText()
  const saving = useRun()
  const id = useId()
  // a question not answered yet starts from what the AI proposed (saving it unconfirmed holds the send back · BR-AI-17)
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.flatMap((q) => (q.chosen ? [[q.code, q.chosen]] : q.ai && !q.locked ? [[q.code, q.ai.optionCode]] : []))),
  )
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    // a tick counts for an answer kept as the AI proposed it; it is sent again even when unchanged
    const confirmed = questions.filter((q) => q.ai && !q.ai.confirmed && ticked.has(q.code) && chosen[q.code] === q.ai.optionCode).map((q) => q.code)
    // only what procurement chose or changed, never the answers from a certificate
    const answers = questions.filter((q) => !q.locked && chosen[q.code] && (chosen[q.code] !== q.chosen || confirmed.includes(q.code))).map((q) => ({ questionCode: q.code, optionCode: chosen[q.code]! }))
    if (answers.length === 0) return onClose()
    const proposed = new Set(questions.filter((q) => q.ai).map((q) => q.code))
    const aiAssist = ai && answers.some((x) => proposed.has(x.questionCode)) ? { agentActionId: ai.agentActionId, confirmedPaths: confirmed.map((c) => `answers.${c}`) } : undefined
    const outcome = await saving.run((key) => fill(answers, key, aiAssist))
    if (outcome.ok) onSaved()
    else setFailure(failureText(outcome))
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('fillTitle')}</DialogTitle>
          <DialogDescription>{t('fillBody')}</DialogDescription>
          {ai && questions.some((q) => q.ai) ? <p className="text-ink-muted">{ai.words.intro}</p> : null}
        </DialogHeader>
        <form id={`${id}-form`} onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
          {questions.map((q) => (
            <fieldset key={q.code} className="flex flex-col gap-2 border-b border-line pb-3">
              <legend className="mb-1 font-medium">{`${q.code} · ${q.text}`}</legend>
              {q.locked ? <p className="text-ink-muted">{t('lockedByEvidence')}</p> : null}
              <RadioGroup value={chosen[q.code] ?? ''} onValueChange={(v) => setChosen((old) => ({ ...old, [q.code]: v }))} disabled={q.locked} aria-label={q.code}>
                {q.options.map((o) => (
                  <div key={o.code} className="flex min-h-11 items-center gap-3">
                    <RadioGroupItem id={`${id}-${q.code}-${o.code}`} value={o.code} />
                    <Label htmlFor={`${id}-${q.code}-${o.code}`} className="text-base">
                      {o.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              {q.ai && ai && !q.locked ? (
                <div role="group" aria-labelledby={`${id}-${q.code}-ai`} className="flex flex-col gap-1 border-l-4 border-info bg-surface py-2 pl-3">
                  <p id={`${id}-${q.code}-ai`} className="font-medium">
                    {ai.words.title}
                  </p>
                  <p>{q.ai.proposed}</p>
                  {q.ai.details.map((d) => (
                    <p key={d} className="break-words text-ink-muted">
                      {d}
                    </p>
                  ))}
                  {q.ai.warning ? <p className="font-medium text-warn-ink">{q.ai.warning}</p> : null}
                  {q.ai.confirmed ? (
                    <p className="text-ink-muted">{ai.words.confirmed}</p>
                  ) : (
                    <>
                      {q.ai.pending ? <p className="font-medium text-warn-ink">{ai.words.pending}</p> : null}
                      <div className="flex min-h-11 items-center gap-3">
                        <Checkbox
                          id={`${id}-${q.code}-confirm`}
                          checked={ticked.has(q.code)}
                          onCheckedChange={(v) =>
                            setTicked((old) => {
                              const next = new Set(old)
                              if (v === true) next.add(q.code)
                              else next.delete(q.code)
                              return next
                            })
                          }
                        />
                        <Label htmlFor={`${id}-${q.code}-confirm`} className="text-base">
                          {ai.words.confirm}
                        </Label>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </fieldset>
          ))}
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11 lg:min-h-10" onClick={onClose}>
            {t('close')}
          </Button>
          <Button type="submit" form={`${id}-form`} className="min-h-11 lg:min-h-10" disabled={saving.pending}>
            {saving.pending ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

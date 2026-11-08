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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../shadcn/dialog'
import { Label } from '../shadcn/label'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import { Textarea } from '../shadcn/textarea'

// The buttons of /risk/assessments/[id] for PROCUREMENT (S11-05 · FR-RSK-201 AC5 · BR-RSK-01): fill in for the supplier
// (a Dialog of the questions of the set, one choice each; an answer from a certificate is shown and kept), send, and
// cancel with a reason (AlertDialog). The commands check risk.assessment.manage and the state again.

export interface FillQuestion {
  readonly code: string
  readonly text: string
  readonly options: readonly { readonly code: string; readonly label: string }[]
  readonly chosen: string | null
  /** An answer from a certificate: shown, not changed here */
  readonly locked: boolean
}

export interface AssessmentActions {
  readonly fill: (answers: { questionCode: string; optionCode: string }[], expectedVersion: number, key: string) => Promise<RiskAdminOutcome>
  readonly submit: (expectedVersion: number, key: string) => Promise<RiskAdminOutcome>
  readonly cancel: (reason: string, expectedVersion: number, key: string) => Promise<RiskAdminOutcome>
}

export function AssessmentButtons({ version, questions, actions }: { version: number; questions: readonly FillQuestion[]; actions: AssessmentActions }) {
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
          onClose={() => setFilling(false)}
          fill={(answers, key) => actions.fill(answers, version, key)}
          onSaved={() => {
            setFilling(false)
            setMessage({ tone: 'success', text: t('filled') })
          }}
        />
      ) : null}
    </div>
  )
}

function FillDialog({ questions, fill, onClose, onSaved }: { questions: readonly FillQuestion[]; fill: (answers: { questionCode: string; optionCode: string }[], key: string) => Promise<RiskAdminOutcome>; onClose: () => void; onSaved: () => void }) {
  const t = useSay('risk.assessment')
  const failureText = useFailureText()
  const saving = useRun()
  const id = useId()
  const [chosen, setChosen] = useState<Record<string, string>>(() => Object.fromEntries(questions.filter((q) => q.chosen).map((q) => [q.code, q.chosen!])))
  const [failure, setFailure] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    // only what procurement chose or changed, never the answers from a certificate
    const answers = questions.filter((q) => !q.locked && chosen[q.code] && chosen[q.code] !== q.chosen).map((q) => ({ questionCode: q.code, optionCode: chosen[q.code]! }))
    if (answers.length === 0) return onClose()
    const outcome = await saving.run((key) => fill(answers, key))
    if (outcome.ok) onSaved()
    else setFailure(failureText(outcome))
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('fillTitle')}</DialogTitle>
          <DialogDescription>{t('fillBody')}</DialogDescription>
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

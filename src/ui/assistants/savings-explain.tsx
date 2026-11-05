'use client'

import { Sparkles } from 'lucide-react'
import { useState, useTransition } from 'react'
import { Button } from '../shadcn/button'
import { FeedbackButtons, type AiFeedback, type GiveAiFeedback } from './feedback-buttons'

// "ให้ผู้ช่วยอธิบาย" on one saving (NEW-136 · FR-VIS-008 AC3 · ADR-084): only a press asks the AI (NG-13), and every
// press uses credits, which the button's hint says. While it writes, a status line says so; what comes back is set apart
// with Sparkles and the line that an assistant wrote it (§12.5), with "ช่วยได้" "ไม่ช่วย" under it. A text the checker
// refused, or a saving that left the list, is said in the row — never in a toast alone (§9.9). The figures above stay
// whatever happens: the AI only words them.

export interface SavingsNoteView {
  readonly agentActionId: string
  readonly sentences: readonly string[]
  readonly feedback: AiFeedback | null
}

export type ExplainSaving = (key: string) => Promise<{ readonly kind: 'READY'; readonly agentActionId: string; readonly sentences: readonly string[] } | { readonly kind: 'FAILED' } | { readonly kind: 'GONE' }>

export interface SavingsExplainLabels {
  readonly button: string
  readonly again: string
  readonly pending: string
  readonly label: string
  readonly aiNote: string
  readonly failed: string
  readonly gone: string
  readonly credits: string
}

/** `canAsk`: every gate of the AI is open for the member now; an explanation written before shows without it */
export function SavingsExplain({ itemKey, initial, canAsk, labels, explain, give }: { itemKey: string; initial: SavingsNoteView | null; canAsk: boolean; labels: SavingsExplainLabels; explain: ExplainSaving; give: GiveAiFeedback }) {
  const creditsId = `savings-credits-${itemKey.replace(/[^A-Za-z0-9_-]/g, '-')}`
  const [note, setNote] = useState<SavingsNoteView | null>(initial)
  const [problem, setProblem] = useState<'FAILED' | 'GONE' | null>(null)
  const [pending, start] = useTransition()
  const ask = () =>
    start(async () => {
      setProblem(null)
      const outcome = await explain(itemKey).catch(() => ({ kind: 'FAILED' as const }))
      if (outcome.kind !== 'READY') return setProblem(outcome.kind)
      setNote({ agentActionId: outcome.agentActionId, sentences: outcome.sentences, feedback: null })
    })
  return (
    <div className="mt-2 flex flex-col gap-2">
      {note ? (
        <section aria-label={labels.label} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
          <p className="flex items-center gap-2 text-base font-medium text-ink md:text-sm">
            <Sparkles className="size-4 shrink-0 text-info" aria-hidden="true" />
            {labels.label}
          </p>
          {note.sentences.map((s, i) => (
            <p key={`${i}:${s}`} className="text-base break-words text-ink md:text-sm">
              {s}
            </p>
          ))}
          <p className="text-base text-ink-muted md:text-sm">{labels.aiNote}</p>
          <FeedbackButtons key={note.agentActionId} agentActionId={note.agentActionId} initial={note.feedback} give={give} />
        </section>
      ) : null}
      {canAsk ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" disabled={pending} aria-busy={pending || undefined} aria-describedby={creditsId} className="min-h-11 px-2 text-primary lg:min-h-9" onClick={ask}>
            <Sparkles className="size-4" aria-hidden="true" />
            {note ? labels.again : labels.button}
          </Button>
          <span id={creditsId} className="text-base text-ink-muted md:text-sm">
            {labels.credits}
          </span>
        </div>
      ) : null}
      <p role="status" className="text-base text-ink-muted empty:hidden md:text-sm">
        {pending ? labels.pending : ''}
      </p>
      {problem ? (
        <p role="alert" className="text-base text-danger-ink md:text-sm">
          {problem === 'GONE' ? labels.gone : labels.failed}
        </p>
      ) : null}
    </div>
  )
}

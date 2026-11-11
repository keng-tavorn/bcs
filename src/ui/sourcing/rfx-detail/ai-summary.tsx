'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { FeedbackButtons, type AiFeedback, type GiveAiFeedback } from '../../assistants/feedback-buttons'
import { useSubmissionKey } from '../../form/submission-key'
import { Button } from '../../shadcn/button'

// The box "สรุปโดย AI" of a closed RFx (S10-16 · FR-AI-305 AC2 AC3 · BR-AI-32), above the comparison table for a reader
// of its prices: "สรุปข้อเสนอ" and "ประเด็นเจรจา" ask the Sourcing Agent only on a press (NG-13), each press may use
// credits, which the hint says. Every value in the sentences came from code's facts (the server checked them, BR-AI-27);
// the box says an assistant wrote them and that nothing is sent to a supplier. A text the checker refused is said in the
// box, never in a toast alone (§9.9). The table, the flags and the scores above and below stay whatever happens.

export type SummaryPurpose = 'BID_SUMMARY' | 'NEGOTIATION_POINTS'

export interface RfxSummaryView {
  readonly agentActionId: string
  readonly sentences: readonly string[]
  readonly feedback: AiFeedback | null
}

export type Summarize = (purpose: SummaryPurpose, key: string) => Promise<{ readonly kind: 'READY'; readonly agentActionId: string; readonly sentences: readonly string[] } | { readonly kind: 'FAILED' }>

export function RfxAiSummary({
  canAsk,
  initial,
  summarize,
  give,
}: {
  canAsk: boolean
  initial: { readonly BID_SUMMARY: RfxSummaryView | null; readonly NEGOTIATION_POINTS: RfxSummaryView | null }
  summarize: Summarize
  give: GiveAiFeedback
}) {
  const t = useTranslations('sourcing.detail.ai')
  const submission = useSubmissionKey()
  const [texts, setTexts] = useState(initial)
  const [failed, setFailed] = useState<SummaryPurpose | null>(null)
  const [asking, setAsking] = useState<SummaryPurpose | null>(null)
  const [pending, start] = useTransition()
  const ask = (purpose: SummaryPurpose) =>
    start(async () => {
      setFailed(null)
      setAsking(purpose)
      const key = submission.key
      const outcome = await summarize(purpose, key).catch(() => ({ kind: 'FAILED' as const }))
      submission.next()
      setAsking(null)
      if (outcome.kind !== 'READY') return setFailed(purpose)
      setTexts((x) => ({ ...x, [purpose]: { agentActionId: outcome.agentActionId, sentences: outcome.sentences, feedback: null } }))
    })
  const purposes: readonly SummaryPurpose[] = ['BID_SUMMARY', 'NEGOTIATION_POINTS']
  if (!canAsk && !texts.BID_SUMMARY && !texts.NEGOTIATION_POINTS) return null
  return (
    <section aria-labelledby="rfx-ai-title" className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <h3 id="rfx-ai-title" className="flex items-center gap-2 font-semibold text-ink">
        <Sparkles className="size-4 shrink-0 text-info" aria-hidden="true" />
        {t('title')}
      </h3>
      {purposes.map((purpose) => {
        const text = texts[purpose]
        return (
          <div key={purpose} className="flex flex-col gap-2">
            <h4 className="font-medium text-ink">{t(`heading.${purpose}`)}</h4>
            {text ? (
              <>
                <ul className="flex list-disc flex-col gap-1 pl-5">
                  {text.sentences.map((s, i) => (
                    <li key={`${i}:${s}`} className="break-words text-ink">
                      {s}
                    </li>
                  ))}
                </ul>
                <FeedbackButtons key={text.agentActionId} agentActionId={text.agentActionId} initial={text.feedback} give={give} />
              </>
            ) : null}
            {canAsk ? (
              <Button type="button" variant="outline" className="min-h-11 self-start lg:min-h-10" disabled={pending} aria-busy={asking === purpose || undefined} aria-describedby="rfx-ai-hint" onClick={() => ask(purpose)}>
                <Sparkles aria-hidden="true" />
                {text ? t(`again.${purpose}`) : t(`ask.${purpose}`)}
              </Button>
            ) : null}
            {failed === purpose ? (
              <p role="alert" className="text-base text-danger-ink md:text-sm">
                {t('failed')}
              </p>
            ) : null}
          </div>
        )
      })}
      <p role="status" className="text-base text-ink-muted empty:hidden md:text-sm">
        {asking ? t('writing') : ''}
      </p>
      <p id="rfx-ai-hint" className="text-base text-ink-muted md:text-sm">
        {t('note')}
      </p>
    </section>
  )
}

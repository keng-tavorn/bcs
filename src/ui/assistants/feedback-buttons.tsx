'use client'

import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState, useTransition } from 'react'
import { Button } from '../shadcn/button'

// "ช่วยได้" and "ไม่ช่วย" under words an AI wrote (NEW-122 · ADR-079): the Approval Brief of the panel "จากผู้ช่วย" and an
// answer of "ถาม BCS AI". A press records the member's own Event (agent_action.give_feedback, POST); the pressed one
// says so by aria-pressed and the line beside it, never by colour alone (§9.9). Another press changes the answer. The
// buttons decide nothing (BR-AI-01). `onGiven` tells a parent that outlives the buttons (the chat sheet, whose content
// goes when it closes) what was said, to give it back as `initial`.

export type AiFeedback = 'HELPFUL' | 'NOT_HELPFUL'
export type GiveAiFeedback = (agentActionId: string, feedback: AiFeedback) => Promise<{ readonly ok: boolean }>

export function FeedbackButtons({ agentActionId, initial = null, give, onGiven }: { agentActionId: string; initial?: AiFeedback | null; give: GiveAiFeedback; onGiven?: (feedback: AiFeedback) => void }) {
  const t = useTranslations('aiAssist.feedback')
  const [given, setGiven] = useState<AiFeedback | null>(initial)
  const [failed, setFailed] = useState(false)
  const [pending, start] = useTransition()
  const press = (feedback: AiFeedback) =>
    start(async () => {
      setFailed(false)
      const outcome = await give(agentActionId, feedback).catch(() => ({ ok: false }))
      if (!outcome.ok) return setFailed(true)
      setGiven(feedback)
      onGiven?.(feedback)
    })
  return (
    <div role="group" aria-label={t('label')} className="flex flex-wrap items-center gap-2">
      {/* A line of its own on a phone, so the two answers stay side by side */}
      <span className="text-base text-ink-muted max-sm:basis-full md:text-sm">{t('question')}</span>
      <Button type="button" variant="outline" aria-pressed={given === 'HELPFUL'} disabled={pending} className="min-h-11 lg:min-h-9" onClick={() => press('HELPFUL')}>
        <ThumbsUp aria-hidden="true" />
        {t('helpful')}
      </Button>
      <Button type="button" variant="outline" aria-pressed={given === 'NOT_HELPFUL'} disabled={pending} className="min-h-11 lg:min-h-9" onClick={() => press('NOT_HELPFUL')}>
        <ThumbsDown aria-hidden="true" />
        {t('notHelpful')}
      </Button>
      <p role="status" className="basis-full text-base text-ink-muted empty:hidden md:text-sm">
        {given ? t(given === 'HELPFUL' ? 'savedHelpful' : 'savedNotHelpful') : ''}
      </p>
      {failed ? (
        <p role="alert" className="basis-full text-base text-danger-ink md:text-sm">
          {t('failed')}
        </p>
      ) : null}
    </div>
  )
}

'use client'

import { ChevronDown } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useState } from 'react'
import { FOLLOW_UP_MAX, FOLLOW_UP_VIAS, type FollowUpVia } from '@/lib/follow-up'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../shadcn/collapsible'
import { FieldLegend, FieldSet } from '../shadcn/field'
import { Label } from '../shadcn/label'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import { Textarea } from '../shadcn/textarea'

/** What sending a nudge answers (the screen-safe parts of a refusal, src/ui/insight/outcome.ts) */
export type FollowUpOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly reason?: string; readonly nextAt?: string; readonly requestId?: string }
export type SendFollowUp = (input: { taskId: string; via: FollowUpVia; text: string }, idempotencyKey: string) => Promise<FollowUpOutcome>

const NO_ANSWER: FollowUpOutcome = { ok: false, code: 'NO_ANSWER' }

export interface FollowUpDraftView {
  readonly taskId: string
  /** The anchor that opens the draft (the document's panel links to it) */
  readonly anchor: string
  readonly to: string
  readonly text: string
  readonly hint: string
  readonly confirmTitle: string
  readonly confirm: Readonly<Record<FollowUpVia, string>>
  readonly sent: string
}

/** The words of a refusal, by what the service said of it */
function errorKey(o: Exclude<FollowUpOutcome, { ok: true }>): 'SENT_TODAY' | 'TOLD_RECENTLY' | 'NOT_FOLLOWER' | 'OWN_TASK' | 'NOT_DUE_SOON' | 'HOLDER_INACTIVE' | 'STATE' | 'BUSY' | 'UNAUTHENTICATED' | 'NO_ANSWER' | 'FAILED' {
  switch (o.code) {
    case 'RATE_LIMITED':
      // the day's rule or the quiet time after the system's notice; any other RATE_LIMITED is a busy database
      return o.reason === 'SENT_TODAY' || o.reason === 'TOLD_RECENTLY' ? o.reason : 'BUSY'
    case 'FORBIDDEN':
      return o.reason === 'OWN_TASK' ? 'OWN_TASK' : 'NOT_FOLLOWER'
    case 'VALIDATION_FAILED':
      return o.reason === 'NOT_DUE_SOON' || o.reason === 'HOLDER_INACTIVE' ? o.reason : 'FAILED'
    case 'INVALID_STATE_TRANSITION':
    case 'NOT_FOUND':
      return 'STATE'
    case 'UNAUTHENTICATED':
    case 'NO_ANSWER':
      return o.code
    default:
      return 'FAILED'
  }
}

/**
 * The nudge of one task (NEW-124 · ADR-082), for a person to read, change and send: closed until pressed (or reached by
 * its anchor); then who it goes to, the way they are told, and the drafted words in a box. "ตรวจก่อนส่ง" opens the
 * confirmation with the whole text, who gets it and how; only "ส่งข้อความทวง" there sends, once per submission, and the
 * service checks everything again (BR-AUTH-05). While a nudge may not go, the reason and when it may stand in its place.
 */
export function FollowUpDraft({ view, hold, send }: { view: FollowUpDraftView; hold: string | null; send: SendFollowUp }) {
  const t = useTranslations('followUp')
  const locale = useLocale()
  const action = useOutcomeAction<FollowUpOutcome>(NO_ANSWER)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [via, setVia] = useState<FollowUpVia>('LINE')
  const [text, setText] = useState(view.text)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [sent, setSent] = useState(false)

  // A link to the draft opens it, and so does pressing that link again once the hash already names it
  useEffect(() => {
    const reach = () => {
      if (window.location.hash === `#${view.anchor}`) setOpen(true)
    }
    const pressed = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(`a[href$="#${view.anchor}"]`)) setOpen(true)
    }
    reach()
    window.addEventListener('hashchange', reach)
    document.addEventListener('click', pressed)
    return () => {
      window.removeEventListener('hashchange', reach)
      document.removeEventListener('click', pressed)
    }
  }, [view.anchor])

  function review() {
    const words = text.trim()
    if (!words) return setProblem(t('draft.empty'))
    if ([...words].length > FOLLOW_UP_MAX) return setProblem(t('draft.tooLong', { max: FOLLOW_UP_MAX }))
    setProblem(null)
    action.clear()
    setConfirming(true)
  }

  async function onSend() {
    const outcome = await action.run((key) => send({ taskId: view.taskId, via, text: text.trim() }, key))
    if (outcome.ok) {
      setConfirming(false)
      setOpen(false)
      setSent(true)
    }
  }

  const failed = action.outcome && !action.outcome.ok ? action.outcome : null
  const failure = failed
    ? (() => {
        const text = t(`errors.${errorKey(failed)}`, { when: failed.nextAt ? formatDateTime(locale, failed.nextAt) : '-' })
        return failed.requestId ? `${text} (${failed.requestId})` : text
      })()
    : null
  const titleId = `${id}-title`
  const problemId = `${id}-problem`

  return (
    <section id={view.anchor} aria-labelledby={hold || sent ? undefined : titleId} className="flex scroll-mt-24 flex-col gap-2">
      {sent ? (
        <p role="status" className="font-medium text-ink">
          {view.sent}
        </p>
      ) : null}
      {hold ? (
        <p className="text-base text-ink-muted md:text-sm">{hold}</p>
      ) : (
        <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
          <h4 id={titleId} className="font-medium text-ink">
            <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-2 text-left font-medium text-primary underline underline-offset-4 hover:no-underline">
              <ChevronDown className="size-4 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
              {t('draft.toggle')}
            </CollapsibleTrigger>
          </h4>
          <CollapsibleContent className="flex flex-col gap-3">
            <p className="break-words font-medium text-ink">{view.to}</p>
            <FieldSet>
              <FieldLegend id={`${id}-via`} variant="label" className="text-base font-medium text-ink">
                {t('draft.via')}
              </FieldLegend>
              <RadioGroup value={via} onValueChange={(v) => setVia(v as FollowUpVia)} aria-labelledby={`${id}-via`} className="gap-1">
                {FOLLOW_UP_VIAS.map((v) => (
                  <label key={v} htmlFor={`${id}-${v}`} className="flex min-h-11 cursor-pointer items-center gap-3 py-1">
                    <RadioGroupItem id={`${id}-${v}`} value={v} className="size-5" />
                    <span className="break-words text-ink">{t(`draft.via${v}`)}</span>
                  </label>
                ))}
              </RadioGroup>
            </FieldSet>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-text`} className="text-base text-ink">
                {t('draft.message')}
              </Label>
              <Textarea
                id={`${id}-text`}
                value={text}
                maxLength={FOLLOW_UP_MAX}
                onChange={(e) => setText(e.target.value)}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `${problemId} ${id}-hint` : `${id}-hint`}
                className="min-h-32 text-base"
              />
              <p id={`${id}-hint`} className="text-base text-ink-muted md:text-sm">
                {view.hint}
              </p>
              {problem ? (
                <p id={problemId} className="text-base text-danger md:text-sm">
                  {problem}
                </p>
              ) : null}
            </div>
            <Button variant="secondary" className="self-start" onClick={review}>
              {t('draft.review')}
            </Button>
          </CollapsibleContent>
        </Collapsible>
      )}
      <AlertDialog open={confirming} onOpenChange={(next) => !action.pending && setConfirming(next)}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold break-words text-ink">{view.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">{view.confirm[via]}</AlertDialogDescription>
          </AlertDialogHeader>
          <blockquote className="rounded-md border border-line bg-surface p-3 text-base break-words whitespace-pre-wrap text-ink">{text.trim()}</blockquote>
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
              {t('draft.back')}
            </AlertDialogCancel>
            <Button disabled={action.pending} aria-busy={action.pending || undefined} onClick={() => void onSend()}>
              {action.pending ? t('draft.sending') : t('draft.send')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

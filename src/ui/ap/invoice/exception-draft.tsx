'use client'

import { ChevronDown } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useState } from 'react'
import { Button } from '../../form/button'
import { Notice } from '../../form/notice'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../shadcn/alert-dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../shadcn/collapsible'
import { FieldLegend, FieldSet } from '../../shadcn/field'
import { Label } from '../../shadcn/label'
import { RadioGroup, RadioGroupItem } from '../../shadcn/radio-group'
import { Textarea } from '../../shadcn/textarea'
import type { ApOutcome } from './outcome'
import { useApAction, useApErrorText } from './use-ap-action'

/** One person or the supplier a drafted message may go to, with the draft and the words that name them */
export interface DraftRecipient {
  /** A member's id, or SUPPLIER */
  readonly id: string
  readonly label: string
  readonly draft: string
  readonly confirmTitle: string
  readonly sent: string
}

export interface ExceptionDraftView {
  readonly exceptionId: string
  readonly to: 'MEMBER' | 'SUPPLIER'
  /** The anchor the helper's way "ถามผู้ตรวจรับหรือผู้ขอ" or "ขอใบลดหนี้..." points to */
  readonly anchor: string
  readonly title: string
  readonly hint: string
  /** "ส่งถึง" with a choice of people, or one line naming the supplier */
  readonly toLabel: string
  readonly recipients: readonly DraftRecipient[]
  readonly review: string
  readonly confirmHint: string
  readonly send: string
  readonly sending: string
  readonly max: number
}

/**
 * A message the helper of a difference drafted (NEW-126 · ADR-081), for a person to read, change and send: a question to
 * a receiver or requester of the line, or an e-mail to the supplier. Closed until pressed (or reached by its anchor from
 * the helper's way); then the text in a box, and "ตรวจก่อนส่ง" opens the confirmation with the whole text and who it goes
 * to. Only "ส่ง..." there sends, once per submission; the service checks everything again (BR-AUTH-05). Choosing another
 * person swaps the draft while it is untouched; what the person wrote stays theirs.
 */
export function ExceptionDraft({ view, send }: { view: ExceptionDraftView; send: (input: unknown, idempotencyKey: string) => Promise<ApOutcome> }) {
  const t = useTranslations('exceptionHelp')
  const errorText = useApErrorText()
  const action = useApAction()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [recipientId, setRecipientId] = useState(view.recipients[0]?.id ?? '')
  const recipient = view.recipients.find((r) => r.id === recipientId) ?? view.recipients[0]
  const [text, setText] = useState(recipient?.draft ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [sent, setSent] = useState<string | null>(null)

  // The helper's way links here: reaching the anchor opens the draft, and so does pressing the link again once the hash
  // already names it (closed, or sent) — that changes no hash
  useEffect(() => {
    const reach = () => {
      if (window.location.hash === `#${view.anchor}`) setOpen(true)
    }
    const pressed = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(`a[href="#${view.anchor}"]`)) setOpen(true)
    }
    reach()
    window.addEventListener('hashchange', reach)
    document.addEventListener('click', pressed)
    return () => {
      window.removeEventListener('hashchange', reach)
      document.removeEventListener('click', pressed)
    }
  }, [view.anchor])

  if (!recipient) return null

  function choose(next: string) {
    const before = view.recipients.find((r) => r.id === recipientId)
    const after = view.recipients.find((r) => r.id === next)
    if (after && before && text === before.draft) setText(after.draft)
    setRecipientId(next)
  }

  function review() {
    const words = text.trim()
    if (!words) return setProblem(t('empty'))
    if ([...words].length > view.max) return setProblem(t('tooLong', { max: view.max }))
    setProblem(null)
    action.clear()
    setConfirming(true)
  }

  async function onSend() {
    const input = { exceptionId: view.exceptionId, to: view.to, ...(view.to === 'MEMBER' ? { memberId: recipient!.id } : {}), text: text.trim() }
    const outcome = await action.run((key) => send(input, key))
    if (outcome.ok) {
      setConfirming(false)
      setOpen(false)
      setSent(recipient!.sent)
      setText(recipient!.draft)
    }
  }

  const failure = action.outcome && !action.outcome.ok ? (action.outcome.reason && t.has(`errors.${action.outcome.reason}` as 'errors.SUPPLIER_NO_EMAIL') ? t(`errors.${action.outcome.reason}` as 'errors.SUPPLIER_NO_EMAIL') : action.outcome.code === 'INVALID_STATE_TRANSITION' ? t('errors.INVALID_STATE_TRANSITION') : errorText(action.outcome)) : null
  const titleId = `${id}-title`
  const problemId = `${id}-problem`

  return (
    <section id={view.anchor} aria-labelledby={titleId} className="flex scroll-mt-24 flex-col gap-2">
      <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
        <h5 id={titleId} className="font-medium text-ink">
          <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-2 text-left font-medium text-primary underline underline-offset-4 hover:no-underline">
            <ChevronDown className="size-4 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true" />
            {view.title}
          </CollapsibleTrigger>
        </h5>
        <CollapsibleContent className="flex flex-col gap-3">
          {view.to === 'MEMBER' ? (
            <FieldSet>
              <FieldLegend id={`${id}-to`} variant="label" className="text-base font-medium text-ink">
                {view.toLabel}
              </FieldLegend>
              <RadioGroup value={recipient.id} onValueChange={choose} aria-labelledby={`${id}-to`} className="gap-1">
                {view.recipients.map((r) => (
                  <label key={r.id} htmlFor={`${id}-${r.id}`} className="flex min-h-11 cursor-pointer items-center gap-3 py-1">
                    <RadioGroupItem id={`${id}-${r.id}`} value={r.id} className="size-5" />
                    <span className="break-words text-ink">{r.label}</span>
                  </label>
                ))}
              </RadioGroup>
            </FieldSet>
          ) : (
            <p className="break-words font-medium text-ink">{view.toLabel}</p>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-text`} className="text-base text-ink">
              {t('message')}
            </Label>
            <Textarea
              id={`${id}-text`}
              value={text}
              maxLength={view.max}
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
            {view.review}
          </Button>
        </CollapsibleContent>
      </Collapsible>
      {sent ? (
        <p role="status" className="text-ink">
          {sent}
        </p>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={(next) => !action.pending && setConfirming(next)}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold break-words text-ink">{recipient.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">{view.confirmHint}</AlertDialogDescription>
          </AlertDialogHeader>
          <blockquote className="rounded-md border border-line bg-surface p-3 text-base break-words whitespace-pre-wrap text-ink">{text.trim()}</blockquote>
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
              {t('back')}
            </AlertDialogCancel>
            <Button disabled={action.pending} aria-busy={action.pending || undefined} onClick={() => void onSend()}>
              {action.pending ? view.sending : view.send}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

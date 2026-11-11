'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Notice } from '../../form/notice'
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
} from '../../shadcn/alert-dialog'
import { Button } from '../../shadcn/button'
import { Label } from '../../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../../shadcn/native-select'
import { Textarea } from '../../shadcn/textarea'
import type { RfxActionOutcome } from './model'
import { useRfxCommand } from './use-command'

// Procurement's answer to a supplier's question (S10-05 · BR-RFX-04): to every invite that has not declined or been
// removed, without naming who asked (ALL), with the question worded again when it tells too much; or to the asker alone
// (ASKER) with the reason (a trade secret of the asker). No price in a question or an answer. Sent once: confirmed.

export interface AnswerInput {
  readonly questionId: string
  readonly answer: string
  readonly visibility: 'ALL' | 'ASKER'
  readonly askerOnlyReason?: string
  readonly publishedQuestion?: string
}

export function AnswerForm({ questionId, question, answer }: { readonly questionId: string; readonly question: string; readonly answer: (input: AnswerInput, key: string) => Promise<RfxActionOutcome> }) {
  const t = useTranslations('sourcing.detail.questions.form')
  const id = useId()
  const command = useRfxCommand()
  const [published, setPublished] = useState(question)
  const [text, setText] = useState('')
  const [visibility, setVisibility] = useState<'ALL' | 'ASKER'>('ALL')
  const [reason, setReason] = useState('')
  const ready = text.trim().length > 0 && published.trim().length > 0 && (visibility === 'ALL' || reason.trim().length >= 3)

  function send() {
    const input: AnswerInput = {
      questionId,
      answer: text.trim(),
      visibility,
      ...(visibility === 'ASKER' ? { askerOnlyReason: reason.trim() } : {}),
      ...(published.trim() !== question ? { publishedQuestion: published.trim() } : {}),
    }
    void command.run((key) => answer(input, key), t('done'))
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      {command.message ? <Notice tone={command.message.tone}>{command.message.text}</Notice> : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-q`}>{t('published')}</Label>
        <Textarea id={`${id}-q`} value={published} onChange={(e) => setPublished(e.target.value)} aria-describedby={`${id}-q-hint`} disabled={command.pending} />
        <p id={`${id}-q-hint`} className="text-base text-ink-muted md:text-sm">
          {t('publishedHint')}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-a`}>{t('answer')}</Label>
        <Textarea id={`${id}-a`} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-a-hint`} disabled={command.pending} />
        <p id={`${id}-a-hint`} className="text-base text-ink-muted md:text-sm">
          {t('answerHint')}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-v`}>{t('visibility')}</Label>
        <NativeSelect id={`${id}-v`} className="min-h-11 w-full lg:min-h-10" value={visibility} onChange={(e) => setVisibility(e.target.value === 'ASKER' ? 'ASKER' : 'ALL')} disabled={command.pending}>
          <NativeSelectOption value="ALL">{t('visibilityALL')}</NativeSelectOption>
          <NativeSelectOption value="ASKER">{t('visibilityASKER')}</NativeSelectOption>
        </NativeSelect>
      </div>
      {visibility === 'ASKER' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-r`}>{t('reason')}</Label>
          <Textarea id={`${id}-r`} value={reason} onChange={(e) => setReason(e.target.value)} disabled={command.pending} />
        </div>
      ) : null}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button className="min-h-11 self-start lg:min-h-10" disabled={command.pending || !ready}>
            {visibility === 'ALL' ? t('sendAll') : t('sendAsker')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{visibility === 'ALL' ? t('confirmAll') : t('confirmAsker')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction onClick={send}>{visibility === 'ALL' ? t('sendAll') : t('sendAsker')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

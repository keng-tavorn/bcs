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
import { Input } from '../../shadcn/input'
import { Label } from '../../shadcn/label'
import { Textarea } from '../../shadcn/textarea'
import { fromBangkokInput, toBangkokInput, type RfxActionOutcome } from './model'
import { useRfxCommand } from './use-command'

// While an RFx is open (S10-04 · BR-RFX-05 BR-RFX-18): an amendment — a summary for the suppliers (Thai, and English for
// an English RFx), the title and description worded again, the close moved later — makes revision n+1, and every bid sent
// before it must be confirmed or sent again; an extension only moves the close later. Both tell every invite by e-mail,
// so each is confirmed. Only the fields that changed are sent.

export interface AmendInput {
  readonly expectedVersion: number
  readonly summary: string
  readonly summaryEn?: string
  readonly title?: string
  readonly titleEn?: string | null
  readonly description?: string
  readonly descriptionEn?: string | null
  readonly closesAt?: string
}

export interface RevisionCurrent {
  readonly version: number
  readonly title: string
  readonly titleEn: string | null
  readonly description: string
  readonly descriptionEn: string | null
  readonly closesAt: string | null
}

const field = 'flex flex-col gap-2'
const hint = 'text-base text-ink-muted md:text-sm'

export function AmendForm({ current, amend }: { readonly current: RevisionCurrent; readonly amend: (input: AmendInput, key: string) => Promise<RfxActionOutcome> }) {
  const t = useTranslations('sourcing.detail.revisions.amend')
  const id = useId()
  const command = useRfxCommand()
  const [summary, setSummary] = useState('')
  const [summaryEn, setSummaryEn] = useState('')
  const [title, setTitle] = useState(current.title)
  const [titleEn, setTitleEn] = useState(current.titleEn ?? '')
  const [description, setDescription] = useState(current.description)
  const [descriptionEn, setDescriptionEn] = useState(current.descriptionEn ?? '')
  const [closesAt, setClosesAt] = useState(toBangkokInput(current.closesAt))
  const closeIso = closesAt && closesAt !== toBangkokInput(current.closesAt) ? fromBangkokInput(closesAt) : null
  const badClose = closesAt !== '' && closesAt !== toBangkokInput(current.closesAt) && closeIso === null

  const changes: Omit<AmendInput, 'expectedVersion' | 'summary'> = {
    ...(title.trim() && title.trim() !== current.title ? { title: title.trim() } : {}),
    ...(titleEn.trim() !== (current.titleEn ?? '') ? { titleEn: titleEn.trim() || null } : {}),
    ...(description.trim() && description.trim() !== current.description ? { description: description.trim() } : {}),
    ...(descriptionEn.trim() !== (current.descriptionEn ?? '') ? { descriptionEn: descriptionEn.trim() || null } : {}),
    ...(closeIso ? { closesAt: closeIso } : {}),
  }
  const ready = summary.trim().length >= 3 && (summaryEn.trim() === '' || summaryEn.trim().length >= 3) && Object.keys(changes).length > 0 && !badClose

  function send() {
    void command
      .run((key) => amend({ expectedVersion: current.version, summary: summary.trim(), ...(summaryEn.trim() ? { summaryEn: summaryEn.trim() } : {}), ...changes }, key), t('done'))
      .then((ok) => {
        if (ok) {
          setSummary('')
          setSummaryEn('')
        }
      })
  }

  return (
    <div className="flex flex-col gap-4">
      {command.message ? <Notice tone={command.message.tone}>{command.message.text}</Notice> : null}
      <div className={field}>
        <Label htmlFor={`${id}-s`}>{t('summary')}</Label>
        <Textarea id={`${id}-s`} value={summary} onChange={(e) => setSummary(e.target.value)} aria-describedby={`${id}-s-hint`} disabled={command.pending} />
        <p id={`${id}-s-hint`} className={hint}>
          {t('summaryHint')}
        </p>
      </div>
      <div className={field}>
        <Label htmlFor={`${id}-se`}>{t('summaryEn')}</Label>
        <Textarea id={`${id}-se`} value={summaryEn} onChange={(e) => setSummaryEn(e.target.value)} disabled={command.pending} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className={field}>
          <Label htmlFor={`${id}-t`}>{t('title')}</Label>
          <Input id={`${id}-t`} className="min-h-11 lg:min-h-10" value={title} onChange={(e) => setTitle(e.target.value)} disabled={command.pending} />
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-te`}>{t('titleEn')}</Label>
          <Input id={`${id}-te`} className="min-h-11 lg:min-h-10" value={titleEn} onChange={(e) => setTitleEn(e.target.value)} disabled={command.pending} />
        </div>
      </div>
      <div className={field}>
        <Label htmlFor={`${id}-d`}>{t('description')}</Label>
        <Textarea id={`${id}-d`} value={description} onChange={(e) => setDescription(e.target.value)} disabled={command.pending} />
      </div>
      <div className={field}>
        <Label htmlFor={`${id}-de`}>{t('descriptionEn')}</Label>
        <Textarea id={`${id}-de`} value={descriptionEn} onChange={(e) => setDescriptionEn(e.target.value)} disabled={command.pending} />
      </div>
      <div className={field}>
        <Label htmlFor={`${id}-c`}>{t('closesAt')}</Label>
        <Input
          id={`${id}-c`}
          type="datetime-local"
          className="min-h-11 lg:min-h-10"
          value={closesAt}
          onChange={(e) => setClosesAt(e.target.value)}
          aria-describedby={`${id}-c-hint`}
          aria-invalid={badClose || undefined}
          disabled={command.pending}
        />
        <p id={`${id}-c-hint`} className={hint}>
          {badClose ? t('closesAtInvalid') : t('closesAtHint')}
        </p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button className="min-h-11 self-start lg:min-h-10" disabled={command.pending || !ready}>
            {t('send')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction onClick={send}>{t('send')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function ExtendForm({ version, closesAt: current, extend }: { readonly version: number; readonly closesAt: string | null; readonly extend: (version: number, closesAt: string, key: string) => Promise<RfxActionOutcome> }) {
  const t = useTranslations('sourcing.detail.revisions.extend')
  const id = useId()
  const command = useRfxCommand()
  const [value, setValue] = useState(toBangkokInput(current))
  const iso = value !== toBangkokInput(current) ? fromBangkokInput(value) : null
  const bad = value !== '' && value !== toBangkokInput(current) && iso === null
  return (
    <div className="flex flex-col gap-3">
      {command.message ? <Notice tone={command.message.tone}>{command.message.text}</Notice> : null}
      <div className={field}>
        <Label htmlFor={`${id}-c`}>{t('closesAt')}</Label>
        <Input
          id={`${id}-c`}
          type="datetime-local"
          className="min-h-11 lg:min-h-10"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={`${id}-c-hint`}
          aria-invalid={bad || undefined}
          disabled={command.pending}
        />
        <p id={`${id}-c-hint`} className={hint}>
          {bad ? t('invalid') : t('hint')}
        </p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" className="min-h-11 self-start lg:min-h-10" disabled={command.pending || iso === null}>
            {t('send')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => iso && void command.run((key) => extend(version, iso, key), t('done'))}>{t('send')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

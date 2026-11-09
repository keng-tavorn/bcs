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
import { Textarea } from '../../shadcn/textarea'
import type { RfxActionOutcome } from './model'
import { useRfxCommand } from './use-command'

// The commands procurement needs while an RFx runs (S10-12 · BR-RFX-02 BR-RFX-16): close early once every invite has
// answered, cancel, and conclude an RFI — each with its reason in an AlertDialog, because none can be undone. The page
// shows each only when the state machine allows it; the service checks everything again.

export interface RfxCommandActions {
  readonly cancel: (version: number, reason: string, key: string) => Promise<RfxActionOutcome>
  readonly closeEarly: (version: number, reason: string, key: string) => Promise<RfxActionOutcome>
  readonly conclude: (version: number, note: string, key: string) => Promise<RfxActionOutcome>
}

type Which = 'closeEarly' | 'conclude' | 'cancel'
const MIN = 3

export function RfxCommands({ version, can, actions }: { readonly version: number; readonly can: Readonly<Record<Which, boolean>>; readonly actions: RfxCommandActions }) {
  const t = useTranslations('sourcing.detail.commands')
  const command = useRfxCommand()
  const shown = (['closeEarly', 'conclude', 'cancel'] as const).filter((w) => can[w])
  if (!shown.length) return null
  return (
    <div className="flex flex-col gap-3">
      {command.message ? <Notice tone={command.message.tone}>{command.message.text}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {shown.map((w) => (
          <ReasonDialog
            key={w}
            which={w}
            pending={command.pending}
            onConfirm={(text) => command.run((key) => actions[w](version, text, key), t(`${w}.done`))}
            labels={{ open: t(`${w}.open`), title: t(`${w}.title`), body: t(`${w}.body`), field: t(`${w}.field`), confirm: t(`${w}.confirm`), back: t('back'), hint: t('minLength', { min: MIN }) }}
          />
        ))}
      </div>
    </div>
  )
}

function ReasonDialog({
  which,
  pending,
  onConfirm,
  labels,
}: {
  readonly which: Which
  readonly pending: boolean
  readonly onConfirm: (text: string) => Promise<boolean>
  readonly labels: { readonly open: string; readonly title: string; readonly body: string; readonly field: string; readonly confirm: string; readonly back: string; readonly hint: string }
}) {
  const id = useId()
  const [text, setText] = useState('')
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={which === 'conclude' ? 'default' : 'outline'} className="min-h-11 lg:min-h-10" disabled={pending}>
          {labels.open}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{labels.title}</AlertDialogTitle>
          <AlertDialogDescription>{labels.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-text`}>{labels.field}</Label>
          <Textarea id={`${id}-text`} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-hint`} />
          <p id={`${id}-hint`} className="text-base text-ink-muted md:text-sm">
            {labels.hint}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{labels.back}</AlertDialogCancel>
          <AlertDialogAction
            variant={which === 'cancel' ? 'destructive' : 'default'}
            disabled={pending || text.trim().length < MIN}
            onClick={() => void onConfirm(text.trim()).then((ok) => ok && setText(''))}
          >
            {labels.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

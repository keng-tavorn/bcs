'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
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
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { NativeSelect, NativeSelectOption } from '../shadcn/native-select'
import { Textarea } from '../shadcn/textarea'
import { AWARD_ERROR_KEYS, AWARD_REASON_KEYS, keyOf, oneOf, type AwardChoice, type AwardOutcome, type AwardReasonKey, type AwardSaveInput } from './award-model'

// The form of /sourcing/[id]/award (S10-10 · FR-SRC-204 AC2 · BR-RFX-12 · OQ-204): one winner per RFx line picked from the
// bids that offer it (a split award is different lines, never a line shared), the reason and a contract reference;
// saved as the award, sent for approval (AlertDialog: the flags are read again and it goes to its approver) or
// cancelled with a reason. The commands work out the amounts and what needs a reason; the page shows them after a save.

export interface AwardFormLine {
  readonly id: string
  readonly lineNo: number
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly options: ReadonlyArray<{ readonly bidId: string; readonly supplier: string; readonly net: string; readonly lowest: boolean }>
}

export interface AwardFormActions {
  readonly save: (input: AwardSaveInput, key: string) => Promise<AwardOutcome>
  readonly submit: (awardDecisionId: string, version: number, key: string) => Promise<AwardOutcome>
  readonly cancel: (awardDecisionId: string, version: number, reason: string, key: string) => Promise<AwardOutcome>
}

const NONE = ''

export function AwardForm({
  lines,
  initial,
  editable,
  actions,
}: {
  readonly lines: readonly AwardFormLine[]
  /** The award as saved; null before the first save */
  readonly initial: { readonly awardDecisionId: string; readonly version: number; readonly choices: readonly AwardChoice[]; readonly reason: string | null; readonly contractRef: string | null } | null
  /** The award may still be changed and sent (none yet, a draft or a returned one) */
  readonly editable: boolean
  readonly actions: AwardFormActions
}) {
  const t = useTranslations('sourcing.award')
  const router = useRouter()
  const submission = useSubmissionKey()
  const id = useId()
  const saved = Object.fromEntries((initial?.choices ?? []).map((c) => [c.rfxLineId, c.bidId]))
  const [choices, setChoices] = useState<Record<string, string>>(saved)
  const [reason, setReason] = useState(initial?.reason ?? '')
  const [contractRef, setContractRef] = useState(initial?.contractRef ?? '')
  const [cancelReason, setCancelReason] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  const picked: AwardChoice[] = lines.flatMap((l) => (choices[l.id] ? [{ rfxLineId: l.id, bidId: choices[l.id]! }] : []))
  const dirty =
    !initial ||
    lines.some((l) => (choices[l.id] ?? NONE) !== (saved[l.id] ?? NONE)) ||
    reason.trim() !== (initial.reason ?? '') ||
    contractRef.trim() !== (initial.contractRef ?? '')

  function failure(o: Extract<AwardOutcome, { ok: false }>): string {
    if (o.code === 'AWARD_REASON_REQUIRED' && o.reasonCodes?.length) return `${t('errors.AWARD_REASON_REQUIRED')}: ${o.reasonCodes.filter((c): c is AwardReasonKey => oneOf(AWARD_REASON_KEYS, c)).map((c) => t(`reasonCode.${c}`)).join(' · ')}`
    if (o.reason === 'AWARD_OPEN' || o.reason === 'NOT_REVEALED' || o.reason === 'EMPTY') return t(`errors.${o.reason}`)
    return t(`errors.${keyOf(AWARD_ERROR_KEYS, o.code, 'OTHER')}`)
  }

  async function act(call: (key: string) => Promise<AwardOutcome>, done: string) {
    setMessage(null)
    setPending(true)
    let outcome: AwardOutcome
    try {
      outcome = await call(submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    setMessage(outcome.ok ? { tone: 'success', text: done } : { tone: 'danger', text: failure(outcome) })
    if (outcome.ok) router.refresh()
  }

  function save() {
    if (!picked.length) {
      setMessage({ tone: 'danger', text: t('errors.EMPTY') })
      return
    }
    void act((key) => actions.save({ ...(initial ? { awardDecisionId: initial.awardDecisionId, version: initial.version } : {}), lines: picked, reason, contractRef }, key), t('saved'))
  }

  return (
    <div className="flex flex-col gap-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <ul className="flex flex-col gap-4">
        {lines.map((l) => (
          <li key={l.id} className="flex flex-col gap-2">
            <Label htmlFor={`${id}-${l.id}`} className="break-words">
              {t('lineOf', { no: l.lineNo, description: l.description, quantity: l.quantity, uom: l.uom })}
            </Label>
            <NativeSelect
              id={`${id}-${l.id}`}
              className="min-h-11 w-full lg:min-h-10"
              disabled={!editable || pending}
              value={choices[l.id] ?? NONE}
              onChange={(e) => setChoices((c) => ({ ...c, [l.id]: e.target.value }))}
            >
              <NativeSelectOption value={NONE}>{t('noWinner')}</NativeSelectOption>
              {l.options.map((o) => (
                <NativeSelectOption key={o.bidId} value={o.bidId}>
                  {t(o.lowest ? 'optionLowest' : 'option', { supplier: o.supplier, net: o.net })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-reason`}>{t('reason')}</Label>
        <Textarea id={`${id}-reason`} disabled={!editable || pending} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={`${id}-reason-hint`} />
        <p id={`${id}-reason-hint`} className="text-base text-ink-muted md:text-sm">
          {t('reasonHint')}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-contract`}>{t('contractRef')}</Label>
        <Input id={`${id}-contract`} className="min-h-11 lg:min-h-10" disabled={!editable || pending} value={contractRef} onChange={(e) => setContractRef(e.target.value)} />
      </div>
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button className="min-h-11 lg:min-h-10" disabled={pending || dirty || !initial}>
                {t('submit')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('submitTitle')}</AlertDialogTitle>
                <AlertDialogDescription>{t('submitBody')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('back')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => initial && void act((key) => actions.submit(initial.awardDecisionId, initial.version, key), t('submitted'))}>{t('submitConfirm')}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={pending} onClick={save}>
            {t('save')}
          </Button>
        </div>
      ) : null}
      {editable && dirty && initial ? <p className="text-base text-ink-muted md:text-sm">{t('saveFirst')}</p> : null}
      {initial ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="min-h-11 self-start lg:min-h-10" disabled={pending}>
              {t('cancel')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('cancelTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('cancelBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <Label htmlFor={`${id}-cancel`}>{t('cancelReason')}</Label>
            <Textarea id={`${id}-cancel`} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            <AlertDialogFooter>
              <AlertDialogCancel>{t('back')}</AlertDialogCancel>
              <AlertDialogAction disabled={cancelReason.trim().length < 3} onClick={() => void act((key) => actions.cancel(initial.awardDecisionId, initial.version, cancelReason.trim(), key), t('cancelled'))}>
                {t('cancelConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}

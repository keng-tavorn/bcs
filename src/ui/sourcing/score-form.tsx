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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { Textarea } from '../shadcn/textarea'
import type { ScoreEntryInput, ScoreOutcome } from './score-model'

// The evaluator's sheet of /sourcing/[id]/score (S10-08 · FR-SRC-203 AC2 · BR-RFX-09): a table of the bids × the quality
// criteria, a whole score 0–100 and an optional comment in each cell (the price is computed, not typed), saved as a draft
// or sent — sending asks first (AlertDialog: sent scores never change) — and stepping aside with a reason. The commands
// check the evaluator, BR-SOD-14 and the state again; the page refreshes on success.

export interface ScoreFormBid {
  readonly id: string
  readonly supplierName: string
  readonly net: string
  readonly partial: boolean
}

export interface ScoreFormCriterion {
  readonly code: string
  readonly name: string
}

export interface ScoreFormActions {
  readonly save: (entries: ScoreEntryInput[], key: string) => Promise<ScoreOutcome>
  readonly submit: (entries: ScoreEntryInput[], key: string) => Promise<ScoreOutcome>
  readonly recuse: (reason: string, key: string) => Promise<ScoreOutcome>
}

type Cell = { score: string; comment: string }
const cellKey = (bidId: string, code: string) => `${bidId}:${code}`
const WHOLE = /^(100|[1-9]?\d)$/

export function ScoreForm({
  bids,
  criteria,
  initial,
  actions,
}: {
  readonly bids: readonly ScoreFormBid[]
  readonly criteria: readonly ScoreFormCriterion[]
  readonly initial: ReadonlyArray<{ readonly bidId: string; readonly criterionCode: string; readonly score: number; readonly comment: string | null }>
  readonly actions: ScoreFormActions
}) {
  const t = useTranslations('sourcing.score')
  const router = useRouter()
  const submission = useSubmissionKey()
  const id = useId()
  const [cells, setCells] = useState<Record<string, Cell>>(() => Object.fromEntries(initial.map((e) => [cellKey(e.bidId, e.criterionCode), { score: String(e.score), comment: e.comment ?? '' }])))
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [reason, setReason] = useState('')
  const [invalid, setInvalid] = useState(false)

  const cell = (bidId: string, code: string): Cell => cells[cellKey(bidId, code)] ?? { score: '', comment: '' }
  const put = (bidId: string, code: string, patch: Partial<Cell>) => setCells((c) => ({ ...c, [cellKey(bidId, code)]: { ...cell(bidId, code), ...patch } }))

  /** The cells typed so far; null when one is not a whole number from 0 to 100 */
  function entries(): ScoreEntryInput[] | null {
    const out: ScoreEntryInput[] = []
    for (const b of bids)
      for (const c of criteria) {
        const { score, comment } = cell(b.id, c.code)
        if (score.trim() === '') continue
        if (!WHOLE.test(score.trim())) return null
        out.push({ bidId: b.id, criterionCode: c.code, score: Number(score.trim()), ...(comment.trim() ? { comment: comment.trim() } : {}) })
      }
    return out
  }

  function failure(o: Extract<ScoreOutcome, { ok: false }>): string {
    if (o.code === 'SCORES_INCOMPLETE') return t('errors.SCORES_INCOMPLETE', { missing: o.missing ?? 0 })
    const known = ['SOD_VIOLATION', 'INVALID_STATE_TRANSITION', 'FORBIDDEN', 'VALIDATION_FAILED', 'MODULE_DISABLED'] as const
    return (known as readonly string[]).includes(o.code) ? t(`errors.${o.code as (typeof known)[number]}`) : t('errors.FAILED')
  }

  async function act(call: (key: string) => Promise<ScoreOutcome>, done: (o: Extract<ScoreOutcome, { ok: true }>) => string) {
    setMessage(null)
    setPending(true)
    let outcome: ScoreOutcome
    try {
      outcome = await call(submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    setMessage(outcome.ok ? { tone: 'success', text: done(outcome) } : { tone: 'danger', text: failure(outcome) })
    if (outcome.ok) router.refresh()
  }

  function withEntries(call: (e: ScoreEntryInput[], key: string) => Promise<ScoreOutcome>, done: (o: Extract<ScoreOutcome, { ok: true }>) => string) {
    const typed = entries()
    setInvalid(typed === null)
    if (typed === null) return
    void act((key) => call(typed, key), done)
  }

  return (
    <div className="flex flex-col gap-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {invalid ? <Notice tone="danger">{t('invalid')}</Notice> : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('bid')}</TableHead>
              {criteria.map((c) => (
                <TableHead key={c.code} scope="col">
                  {c.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {bids.map((b) => (
              <TableRow key={b.id}>
                <TableHead scope="row" className="align-top font-normal">
                  <span className="flex flex-col gap-1">
                    <span className="font-medium">{b.supplierName}</span>
                    <span className="tabular text-sm text-ink-muted">
                      {t('net')} {b.net}
                    </span>
                    {b.partial ? <span className="text-sm text-ink-muted">{t('partial')}</span> : null}
                  </span>
                </TableHead>
                {criteria.map((c) => {
                  const v = cell(b.id, c.code)
                  const base = `${id}-${b.id}-${c.code}`
                  return (
                    <TableCell key={c.code} className="min-w-44 align-top">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor={`${base}-score`} className="sr-only">
                          {t('scoreOf', { criterion: c.name, supplier: b.supplierName })}
                        </Label>
                        <Input id={`${base}-score`} inputMode="numeric" className="tabular min-h-11 w-24 lg:min-h-10" value={v.score} onChange={(e) => put(b.id, c.code, { score: e.target.value })} />
                        <Label htmlFor={`${base}-comment`} className="sr-only">
                          {t('commentOf', { criterion: c.name, supplier: b.supplierName })}
                        </Label>
                        <Textarea id={`${base}-comment`} placeholder={t('comment')} className="min-h-16" value={v.comment} onChange={(e) => put(b.id, c.code, { comment: e.target.value })} />
                      </div>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button className="min-h-11 lg:min-h-10" disabled={pending}>
              {t('submit')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('submitTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('submitBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => withEntries(actions.submit, (o) => (o.revealed ? t('revealedNow') : t('submitted')))}>{t('submitConfirm')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={pending} onClick={() => withEntries(actions.save, () => t('saved'))}>
          {t('save')}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="min-h-11 lg:min-h-10" disabled={pending}>
              {t('recuse')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('recuseTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('recuseBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <Label htmlFor={`${id}-reason`}>{t('recuseReason')}</Label>
            <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
            <AlertDialogFooter>
              <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
              <AlertDialogAction disabled={reason.trim().length < 3} onClick={() => void act((key) => actions.recuse(reason.trim(), key), () => t('recused'))}>
                {t('recuseConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}

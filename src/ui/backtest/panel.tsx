'use client'

import { ArrowDown, ArrowUp, CircleCheck, Clock, PenLine } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { failureKey, type ActionFailure } from '../admin-org/outcome'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { backtestModel, type BacktestViewDto, type SideModel } from './model'

// The 90-day backtest of a DOA or workflow version (FR-DOA-103 · BR-WF-13 · FR-WF-103 AC2 · BR-DOA-14, S6-07): one
// button routes every document sent in the last 90 days again with the real engine, by the version in effect when it
// was sent and by this version as if in effect then. The answer says the window, how many documents and how many
// change route, who would get more tasks or fewer (+n / −n, in words beside an arrow, never colour alone), and each
// document that changes — its kind and label, the rule, approvers and reviewers on both sides, an engine refusal in
// words. Nothing changes: an empty result says so. Past the page's limit the service answers PENDING and a job fills
// the run: the panel then offers to look again (no polling, nothing opens by itself); a FAILED run offers to run it
// again. Read by who may try the version and by its approver of DOA_CHANGE before deciding; anyone else is refused
// by the service, said in words (§9.9 rule 7).

export type BacktestActionResult = { readonly ok: true; readonly view: BacktestViewDto } | ActionFailure
export type RunBacktestAction = (input: { kind: 'DOA_VERSION' | 'WORKFLOW_VERSION'; versionId: string }, idempotencyKey: string) => Promise<BacktestActionResult>
export type ReadBacktestRunAction = (runId: string) => Promise<BacktestActionResult>

export interface BacktestPanelProps {
  readonly kind: 'DOA_VERSION' | 'WORKFLOW_VERSION'
  readonly versionId: string
  /** "WF-SIMEC ฉบับ 2" */
  readonly versionName: string
  /** A draft or one waiting to publish, or a version whose withdrawal is being decided */
  readonly purpose: 'draft' | 'withdrawal'
  /** An answer to show from the first paint (tests, a page that read a run already) */
  readonly initial?: BacktestViewDto | null
  readonly run: RunBacktestAction
  readonly reread: ReadBacktestRunAction
}

const ERRORS = ['RUN_GONE'] as const

export function BacktestPanel({ kind, versionId, versionName, purpose, initial = null, run, reread }: BacktestPanelProps) {
  const t = useTranslations('backtest')
  const locale = useLocale()
  const id = useId()
  const action = useAction()
  const [view, setView] = useState<BacktestViewDto | null>(initial)
  const [failure, setFailure] = useState<string | null>(null)
  const [stillPending, setStillPending] = useState(false)
  const [rereading, setRereading] = useState(false)
  const when = (iso: string) => formatDateTime(locale, iso)

  const said = (outcome: ActionFailure) => setFailure(t(`errors.${failureKey(outcome, ERRORS)}`, errorValues(outcome)))

  async function onRun() {
    setFailure(null)
    setStillPending(false)
    const outcome = await action.run((key) => run({ kind, versionId }, key))
    if (outcome.ok) return setView(outcome.view)
    said(outcome)
  }

  async function onReread(runId: string) {
    setFailure(null)
    setRereading(true)
    try {
      const outcome = await reread(runId)
      if (!outcome.ok) return said(outcome)
      setView(outcome.view)
      setStillPending(outcome.view.status === 'PENDING')
    } catch {
      setFailure(t('errors.NO_ANSWER'))
    } finally {
      setRereading(false)
    }
  }

  const sideBlock = (title: string, s: SideModel) => (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="font-medium">{title}</p>
      {s.error ? (
        <p className="break-words">{s.error.key === 'OTHER' ? t('sideErrors.OTHER', { code: s.error.code }) : t(`sideErrors.${s.error.key}`)}</p>
      ) : (
        <>
          {s.rule ? <p>{t('rule', { rule: s.rule })}</p> : null}
          <p className="break-words">{t('approvers', { names: s.approvers.join(', ') || '-' })}</p>
          <p className="break-words text-ink-muted">{s.reviewers.length ? t('reviewers', { names: s.reviewers.join(', ') }) : t('noReviewers')}</p>
        </>
      )}
    </div>
  )

  const result = () => {
    if (!view) return null
    if (view.status === 'PENDING') {
      return (
        <Notice tone="info">
          <p>{t('pending', { count: view.documentCount })}</p>
          {stillPending ? <p className="mt-1">{t('stillPending')}</p> : null}
          <Button variant="secondary" className="mt-2" disabled={rereading} aria-busy={rereading || undefined} onClick={() => void onReread(view.runId)}>
            <Clock className="size-4 shrink-0" aria-hidden="true" />
            {rereading ? t('rereading') : t('reread')}
          </Button>
        </Notice>
      )
    }
    if (view.status === 'FAILED') return <Notice tone="warning">{t('failed', { count: view.documentCount })}</Notice>
    const m = backtestModel(view, locale)
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="tabular text-ink-muted">{t('window', { from: when(m.from), to: when(m.to) })}</p>
          <p className="flex items-start gap-2 font-medium">
            {m.changed ? <PenLine className="mt-1 size-4 shrink-0" aria-hidden="true" /> : <CircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />}
            <span>
              {t('summary', { total: m.total })}
              {m.total > 0 ? ` · ${t('changedCount', { changed: m.changed })}` : ''}
            </span>
          </p>
        </div>
        {m.total === 0 ? <p className="text-ink-muted">{t('noDocuments')}</p> : m.changed === 0 ? <p className="text-ink-muted">{t('noChange')}</p> : null}
        {m.load.length ? (
          <section aria-labelledby={`${id}-load`} className="flex flex-col gap-1">
            <h4 id={`${id}-load`} className="font-semibold">
              {t('loadTitle')}
            </h4>
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {m.load.map((l) => (
                <li key={l.memberId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                  <span className="break-words">{l.name}</span>
                  <span className="tabular inline-flex items-center gap-1 font-medium">
                    {l.delta > 0 ? <ArrowUp className="size-4 shrink-0" aria-hidden="true" /> : <ArrowDown className="size-4 shrink-0" aria-hidden="true" />}
                    {t('loadDelta', { text: l.text })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {m.rows.length ? (
          <section aria-labelledby={`${id}-rows`} className="flex flex-col gap-1">
            <h4 id={`${id}-rows`} className="font-semibold">
              {t('rowsTitle', { count: m.rows.length })}
            </h4>
            <ul aria-label={t('rowsLabel')} className="flex flex-col divide-y divide-line border-y border-line">
              {m.rows.map((r) => (
                <li key={r.ref} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-col">
                    <p className="font-semibold break-words">{r.label}</p>
                    <p className="text-base text-ink-muted md:text-sm">
                      {t(`subjectType.${r.subjectType}`)}
                      {r.sentAt ? ` · ${t('sentAt', { time: when(r.sentAt) })}` : ''}
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {sideBlock(t('current'), r.current)}
                    {sideBlock(t('draft'), r.draft)}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-muted">{t(`intro.${purpose}`, { name: versionName })}</p>
      <Button variant={view ? 'secondary' : 'primary'} className="self-start" disabled={action.pending} aria-busy={action.pending || undefined} onClick={() => void onRun()}>
        {action.pending ? t('running') : view ? t('runAgain') : t('run')}
      </Button>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <div aria-live="polite">{result()}</div>
    </div>
  )
}

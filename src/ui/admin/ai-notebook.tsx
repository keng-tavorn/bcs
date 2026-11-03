'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { ModuleState } from './module-state'
import type { AdminFailure, AdminOutcome } from './outcome'

type Name = { readonly th: string; readonly en: string | null }

export interface NotebookEntryView {
  readonly supplierId: string
  readonly supplier: Name
  readonly categoryCode: string | null
  readonly accountCode: string
  readonly accountName: string | null
  readonly uses: number
  readonly lines: number
  readonly lastUsedOn: string
  readonly confirmedBy: readonly Name[]
  readonly confirmedByCount: number
  readonly disabled: boolean
  readonly version: number
}

export type SetLearningAction = (
  input: { supplierId: string; categoryCode: string | null; action: 'DISABLE' | 'ENABLE' | 'FORGET'; expectedVersion: number },
  idempotencyKey: string,
) => Promise<AdminOutcome>

const KNOWN_ERRORS = ['CONFLICT_VERSION', 'NOT_LEARNED', 'NO_CHANGE', 'FORBIDDEN', 'MODULE_DISABLED', 'NOT_FOUND', 'UNAUTHENTICATED'] as const

// "สมุดของผู้ช่วย" at /admin/ai (NEW-125 · ADR-081): what the assistants learned, each with where it came from in
// words; ORG_ADMIN switches an entry off or on, or deletes it after a confirmation (it cannot be undone, §9.9). The
// service checks admin.ai.manage and the version shown. AUDITOR (canManage false) reads the same list without buttons.
export function AiNotebook({ entries, canManage, windowDays, update }: { entries: readonly NotebookEntryView[]; canManage: boolean; windowDays: number; update: SetLearningAction }) {
  const t = useTranslations('admin.ai.notebook')
  const locale = useLocale()
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [forgetting, setForgetting] = useState<NotebookEntryView | null>(null)
  const name = (n: Name) => (locale === 'en' ? (n.en ?? n.th) : n.th)
  const day = (d: string) => (locale === 'en' ? formatEnglishBeDate(d) : formatThaiDate(d))
  const list = new Intl.ListFormat(locale === 'en' ? 'en' : 'th', { type: 'conjunction' })

  function explain(f: AdminFailure): string {
    const reason = f.code === 'VALIDATION_FAILED' ? f.reason : f.code
    if (reason && (KNOWN_ERRORS as readonly string[]).includes(reason)) return t(`errors.${reason as (typeof KNOWN_ERRORS)[number]}`)
    if (f.code === 'INTERNAL') return t('errors.INTERNAL', { requestId: f.requestId ?? '-' })
    return t('errors.FAILED')
  }

  async function send(entry: NotebookEntryView, action: 'DISABLE' | 'ENABLE' | 'FORGET') {
    setPending(true)
    setMessage(null)
    const outcome = await update({ supplierId: entry.supplierId, categoryCode: entry.categoryCode, action, expectedVersion: entry.version }, submission.key)
    setPending(false)
    submission.next()
    setForgetting(null)
    if (!outcome.ok) return setMessage({ tone: 'danger', text: explain(outcome) })
    const supplier = name(entry.supplier)
    setMessage({ tone: 'success', text: action === 'DISABLE' ? t('disabled', { supplier }) : action === 'ENABLE' ? t('enabled', { supplier }) : t('forgotten', { supplier }) })
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-3">
      {message ? (
        <Notice tone={message.tone} role={message.tone === 'success' ? 'status' : undefined}>
          {message.text}
        </Notice>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-ink-muted">{t('empty')}</p>
      ) : (
        <ul aria-label={t('title')} className="flex flex-col divide-y divide-line">
          {entries.map((e) => {
            const titleId = `ai-learning-${e.supplierId}-${e.categoryCode ?? ''}`
            const shown = e.confirmedBy.map(name)
            return (
              <li key={titleId} className="flex flex-col gap-1.5 py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span id={titleId} className="font-medium break-words">
                      {t('entryTitle', { supplier: name(e.supplier) })}
                    </span>
                    <span className="text-base text-ink-muted md:text-sm">{e.categoryCode ? t('category', { category: e.categoryCode }) : t('noCategory')}</span>
                  </div>
                  <ModuleState enabled={!e.disabled} label={e.disabled ? t('off') : t('inUse')} className="shrink-0" />
                </div>
                <p>{e.accountName ? t('offers', { code: e.accountCode, name: e.accountName }) : t('offersNoName', { code: e.accountCode })}</p>
                <p className="text-base text-ink-muted md:text-sm">{t('source', { uses: e.uses, lines: e.lines, days: windowDays, date: day(e.lastUsedOn) })}</p>
                {shown.length ? (
                  <p className="text-base text-ink-muted md:text-sm">
                    {e.confirmedByCount > shown.length ? t('confirmedByMore', { names: list.format(shown), count: e.confirmedByCount - shown.length }) : t('confirmedBy', { names: list.format(shown) })}
                  </p>
                ) : null}
                {e.disabled ? <p className="text-base text-ink-muted md:text-sm">{t('offNote')}</p> : null}
                {canManage ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="secondary" disabled={pending} aria-describedby={titleId} onClick={() => void send(e, e.disabled ? 'ENABLE' : 'DISABLE')}>
                      {e.disabled ? t('enable') : t('disable')}
                    </Button>
                    <Button variant="danger" disabled={pending} aria-describedby={titleId} onClick={() => setForgetting(e)}>
                      {t('forget')}
                    </Button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <AlertDialog open={forgetting !== null} onOpenChange={(next) => (next ? null : setForgetting(null))}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold text-ink">{forgetting ? t('forgetTitle', { supplier: name(forgetting.supplier) }) : null}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">{t('forgetText')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={pending}>
              {t('cancel')}
            </AlertDialogCancel>
            <Button variant="danger" onClick={() => (forgetting ? void send(forgetting, 'FORGET') : undefined)} disabled={pending} aria-busy={pending || undefined}>
              {t('forgetConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

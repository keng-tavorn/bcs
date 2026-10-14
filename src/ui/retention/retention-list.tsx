'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'
import { StatusBadge } from '../document/badges'
import type { BadgeLook } from '../document/badge-looks'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { ListEmpty } from '../page/page'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs'
import { useTaxFailureText } from '../wht/failure-text'
import { NO_ANSWER, type TaxFailure, type TaxOutcome } from '../wht/outcome'

// The retentions FINANCE releases (S8-13 /finance/retentions, FR-AP-106 AC4): one tab per status with its count, each a
// table of the invoice and PO (links), the supplier, the amount right-aligned in tabular digits and the due date with
// "ครบกำหนดแล้ว" once the day has come; phones get a list instead, so nothing scrolls sideways (§9.9). A HELD retention
// whose day has come has the release button, confirmed in an AlertDialog first (§9.9: nothing that cannot be undone
// without a confirmation); before the day the row says from when it can be released. The result stays as a line above
// the tabs (§9.9 rule 7); the service is the guard (retention.release, PAY, version, RETENTION_NOT_DUE).

export const RETENTION_STATUSES = ['HELD', 'RELEASABLE', 'IN_PAYMENT_RUN', 'PAID'] as const
export type RetentionStatus = (typeof RETENTION_STATUSES)[number]

export interface RetentionRowView {
  readonly id: string
  readonly status: RetentionStatus
  readonly version: number
  /** "12,350.00" */
  readonly amount: string
  readonly invoice: { readonly href: string; readonly number: string }
  readonly po: { readonly href: string; readonly number: string }
  readonly supplier: string
  /** The due date in the reader's language; null until the PO's last milestone is received */
  readonly dueOn: string | null
  readonly due: boolean
}

type Release = (input: { retentionId: string; version: number }, idempotencyKey: string) => Promise<TaxOutcome>

const DUE_LOOK: BadgeLook = { tone: 'warn', icon: 'AlarmClock' }
const NOT_DUE_LOOK: BadgeLook = { tone: 'neutral', icon: 'Clock' }
const linkClass = 'inline-flex min-h-11 items-center self-start break-words text-primary underline underline-offset-4 hover:no-underline md:min-h-0'

export function RetentionList({ rows, release, emptyAction }: { rows: readonly RetentionRowView[]; release: Release; emptyAction?: ReactNode }) {
  const t = useTranslations('apTax.retentions')
  const failureText = useTaxFailureText()
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState<string | null>(null)
  const [result, setResult] = useState<{ readonly number: string; readonly outcome: TaxOutcome } | null>(null)

  async function send(row: RetentionRowView) {
    setPending(row.id)
    setResult(null)
    let outcome: TaxOutcome
    try {
      outcome = await release({ retentionId: row.id, version: row.version }, submission.key)
      submission.next()
    } catch {
      outcome = NO_ANSWER
    }
    setPending(null)
    setResult({ number: row.invoice.number, outcome })
    if (outcome.ok || outcome.code === 'CONFLICT_VERSION' || outcome.code === 'INVALID_STATE_TRANSITION') router.refresh()
  }

  const action = (row: RetentionRowView) => {
    if (row.status !== 'HELD') return null
    if (!row.due) return <span className="text-ink-muted">{row.dueOn ? t('notYet', { date: row.dueOn }) : t('noDate')}</span>
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button className="min-h-11 lg:min-h-10" disabled={pending !== null} aria-label={t('releaseOf', { number: row.invoice.number })}>
            {pending === row.id ? t('releasing') : t('release')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('releaseTitle', { amount: row.amount })}</AlertDialogTitle>
            <AlertDialogDescription>{t('releaseBody', { number: row.invoice.number, supplier: row.supplier })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 text-base">{t('releaseKeep')}</AlertDialogCancel>
            <AlertDialogAction className="min-h-11 text-base" onClick={() => void send(row)}>
              {t('releaseConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  const dueCell = (row: RetentionRowView) => (
    <div className="flex flex-col items-start gap-1">
      <span className="tabular">{row.dueOn ?? t('noDate')}</span>
      {row.status === 'HELD' && row.dueOn ? <StatusBadge look={row.due ? DUE_LOOK : NOT_DUE_LOOK} label={row.due ? t('dueBadge') : t('notDueBadge')} /> : null}
    </div>
  )

  const failure: TaxFailure | null = result && !result.outcome.ok ? result.outcome : null

  return (
    <div className="flex flex-col gap-3">
      {result?.outcome.ok ? <Notice tone="success">{`${t('invoice', { number: result.number })} · ${t('released')}`}</Notice> : null}
      {failure ? <Notice tone="danger">{`${t('invoice', { number: result!.number })} · ${failureText(failure)}`}</Notice> : null}
      <Tabs defaultValue="HELD">
        <TabsList aria-label={t('tabsLabel')} className="grid w-full grid-cols-2 group-data-horizontal/tabs:h-auto md:grid-cols-4">
          {RETENTION_STATUSES.map((status) => (
            <TabsTrigger key={status} value={status} className="h-auto min-h-11 px-2 text-base whitespace-normal md:text-sm lg:min-h-10">
              {t('tab', { status: t(`status.${status}`), count: rows.filter((r) => r.status === status).length })}
            </TabsTrigger>
          ))}
        </TabsList>
        {RETENTION_STATUSES.map((status) => {
          const shown = rows.filter((r) => r.status === status)
          const listLabel = t('list', { status: t(`status.${status}`) })
          return (
            <TabsContent key={status} value={status} className="flex flex-col gap-2 text-base">
              {shown.length === 0 ? (
                <ListEmpty title={t(`empty.${status}`)} hint={t('emptyHint')} actions={emptyAction} />
              ) : (
                <>
                  <Table aria-label={listLabel} className="hidden text-base md:table md:text-sm">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('columns.invoice')}</TableHead>
                        <TableHead>{t('columns.supplier')}</TableHead>
                        <TableHead className="text-right">{t('columns.amount')}</TableHead>
                        <TableHead>{t('columns.due')}</TableHead>
                        {status === 'HELD' ? <TableHead>{t('columns.action')}</TableHead> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="align-top whitespace-normal">
                            <div className="flex flex-col gap-0.5">
                              <Link href={row.invoice.href} className={linkClass}>
                                {t('invoice', { number: row.invoice.number })}
                              </Link>
                              <Link href={row.po.href} className={linkClass}>
                                {t('po', { number: row.po.number })}
                              </Link>
                            </div>
                          </TableCell>
                          <TableCell className="align-top whitespace-normal">{row.supplier}</TableCell>
                          <TableCell className="tabular text-right align-top">{row.amount}</TableCell>
                          <TableCell className="align-top">{dueCell(row)}</TableCell>
                          {status === 'HELD' ? <TableCell className="align-top whitespace-normal">{action(row)}</TableCell> : null}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <ul aria-label={listLabel} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
                    {shown.map((row) => (
                      <li key={row.id} className="flex flex-col gap-1.5 py-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <Link href={row.invoice.href} className={linkClass}>
                            {t('invoice', { number: row.invoice.number })}
                          </Link>
                          <span className="tabular font-medium">{`${row.amount} ${t('unit')}`}</span>
                        </div>
                        <Link href={row.po.href} className={linkClass}>
                          {t('po', { number: row.po.number })}
                        </Link>
                        <span>{row.supplier}</span>
                        <div className="flex flex-wrap items-center gap-2 text-ink-muted">
                          <span>{t('columns.due')}</span>
                          {dueCell(row)}
                        </div>
                        {action(row)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </TabsContent>
          )
        })}
      </Tabs>
    </div>
  )
}

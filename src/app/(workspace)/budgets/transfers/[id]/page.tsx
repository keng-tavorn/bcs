import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getBudgetTransfer } from '@/server/services/budget/transfer-view'
import { DocumentStatus } from '@/ui/budgets/badges'
import { moneyText } from '@/ui/budgets/format'
import { Refused } from '@/ui/budgets/refused'
import { TransferActions } from '@/ui/budgets/transfer-actions'
import { senderActions } from '@/ui/budgets/transfer-model'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Facts } from '@/ui/request-view/facts'
import { getSession } from '../../../../_lib/session'
import { cancelBudgetTransferAction, submitBudgetTransferAction } from '../actions'
import { lineText, transferLabel } from '../_present'

export async function generateMetadata() {
  const t = await getTranslations('budgetTransfer')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// One budget transfer or adjustment (S6-15 · FR-BUD-103, §9.1 /budgets/transfers/[id]): its number and status, the
// kind, the lines, the amount and the reason, who sent it and when, and where it stands — a draft reserves nothing, a
// pending one holds the source's amount, a returned one gave it back. Its sender sends it again (DRAFT, RETURNED) or
// cancels it (until decided); anyone else reading it finds the open approval task, which its approvers decide on
// /tasks/[id]. getBudgetTransfer checks who may read it; the commands check the sender again.
export default async function BudgetTransferPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('budgetTransfer'), getLocale()])
  const result = await getBudgetTransfer(ctx, id)
  if (!result.ok) return <Refused title={t('title')} message={result.error.code === 'NOT_FOUND' ? t('detail.notFound') : t('detail.forbidden')} href="/budgets/transfers" linkLabel={t('toList')} />

  const d = result.data
  const label = transferLabel(t, d)
  const can = senderActions(d.status, d.mine)
  // Arrived from the new-transfer form, which sent it: said once, in the words of the button
  const sent = (await searchParams).sent === '1' && d.status === 'PENDING_APPROVAL' && d.number
  const stateHint = d.status === 'DRAFT' ? t('detail.draftHint') : d.status === 'RETURNED' ? t('detail.returnedHint') : d.status === 'PENDING_APPROVAL' && d.kind !== 'INCREASE' ? t('detail.pendingHint') : null

  return (
    <Page>
      <Link href="/budgets/transfers" className={linkClass}>
        {t('toList')}
      </Link>
      <PageHeader title={d.number ? `${t(`kind.${d.kind}`)} ${d.number}` : t('detail.draftTitle')}>
        <DocumentStatus status={d.status} label={t(`status.${d.status}`)} className="self-start" />
      </PageHeader>
      <PageBody>
        {sent ? <Notice tone="success">{d.kind === 'INCREASE' ? t('detail.sentIncrease', { number: d.number! }) : t('detail.sent', { number: d.number! })}</Notice> : null}
        <Panel label={label}>
          <Facts
            items={[
              { label: t('detail.kind'), value: t(`kind.${d.kind}`) },
              ...(d.from ? [{ label: t('detail.from'), value: lineText(d.from) }] : []),
              ...(d.to ? [{ label: t('detail.to'), value: lineText(d.to) }] : []),
              { label: t('detail.amount'), value: <span className="money font-semibold">{t('detail.amountValue', { amount: moneyText(d.amount) })}</span> },
              { label: t('detail.reason'), value: <span className="break-words whitespace-pre-line">{d.reason}</span> },
              { label: t('detail.submittedBy'), value: d.submittedBy.nameTh },
              { label: t('detail.submittedAt'), value: d.submittedAt ? formatDateTime(locale, d.submittedAt) : t('list.notSent') },
              ...(d.decidedAt ? [{ label: t('detail.decidedAt'), value: formatDateTime(locale, d.decidedAt) }] : []),
            ]}
          />
          {stateHint ? <p className="text-ink-muted">{stateHint}</p> : null}
          {/* Kept on the sender's page whatever its state, so the words of what was just done stay after the page refreshes */}
          {d.mine ? (
            <TransferActions transferId={d.id} label={label} send={can.send} cancel={can.cancel} actions={{ submit: submitBudgetTransferAction, cancel: cancelBudgetTransferAction }} />
          ) : null}
          {d.openTaskId && !d.mine ? (
            <Link href={`/tasks/${d.openTaskId}`} className={linkClass}>
              {t('detail.openTask')}
            </Link>
          ) : null}
        </Panel>
      </PageBody>
    </Page>
  )
}

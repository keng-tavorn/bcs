import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { boardView } from '@/server/services/board'
import { formatDateTime } from '@/ui/format'
import { BoardDocuments } from '@/ui/insight/board-documents'
import { hoursText } from '@/ui/insight/format'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { getSession } from '../../../../_lib/session'
import { linkRights } from '../../_rights'
import { boardDocumentViews, boardFilter, filterQuery, readsOnly } from '../_present'
import { remindTaskAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('board')
  return { title: t('person.metaTitle') }
}

const refreshClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
const linkClass = `${refreshClass} self-start`

// One person's documents on the board (FR-VIS-001 AC2): what waits at them within the reader's scope, each with its
// page, its wait in business hours and its due time, and a manual reminder at most once an hour per document. The rows
// come from the same boardView as the board (the reader's scope and filters), so this page never shows more.
export default async function BoardPersonPage({ params, searchParams }: { params: Promise<{ memberId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, locale, { memberId }] = await Promise.all([getTranslations('board'), getLocale(), params])
  const filter = boardFilter(await searchParams)
  const query = filterQuery(filter)
  const back = (
    <Link href={`/board/pending${query}`} className={linkClass}>
      {t('person.back')}
    </Link>
  )
  const result = await boardView(ctx, filter)
  if (!result.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />
  const row = z.uuid().safeParse(memberId).success ? result.data.rows.find((r) => r.memberId === memberId) : undefined

  if (!row) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        {back}
        <h1 className="text-2xl font-semibold">{t('person.metaTitle')}</h1>
        <EmptyState title={t('person.noneTitle')} hint={t('person.noneHint')} href={`/board/pending${query}`} linkLabel={t('person.back')} />
      </div>
    )
  }

  const documents = boardDocumentViews(t, locale, row, state.member.id, linkRights(state.member.id, state.roles), ctx.now)
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {back}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('person.title', { name: row.name })}</h1>
        <p className="text-ink">{t('person.summary', { open: row.open, overdue: row.overdue, waiting: row.waitingForRequester })}</p>
        {row.open ? <p className="text-ink">{t('person.ages', { oldest: hoursText(row.oldestMinutes), average: hoursText(row.averageMinutes) })}</p> : null}
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-muted">
          <span>{t('asOf', { time: formatDateTime(locale, result.data.asOf) })}</span>
          {/* A full reload, as on the board: an installed app has no reload button of its own. A reminder refused because
              the document was decided or left the reader's scope meanwhile says to press this (board.errors) */}
          <a href={`/board/pending/${row.memberId}${query}`} className={refreshClass}>
            {t('refresh')}
          </a>
        </p>
      </div>
      <section aria-labelledby="board-documents" className="flex flex-col gap-3">
        <h2 id="board-documents" className="text-xl font-semibold">
          {t('person.listTitle')}
        </h2>
        <p className="text-ink-muted">{t('remind.rule')}</p>
        {readsOnly(row) ? <p className="text-ink">{t('remind.readOnly')}</p> : null}
        <BoardDocuments documents={documents} label={t('person.listLabel', { name: row.name })} locale={locale} remind={remindTaskAction} />
      </section>
    </div>
  )
}

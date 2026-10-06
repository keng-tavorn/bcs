import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listReceivable } from '@/server/services/receiving/view'
import { ReceivingList } from '@/ui/receiving/receiving-list'
import { getSession } from '../../_lib/session'
import { rowView } from './present'

export async function generateMetadata() {
  const t = await getTranslations('receiving')
  return { title: t('list.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** ?page=2 → 2; anything else → 1 (the service keeps it within the pages there are) */
function pageOf(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value
  return text && /^\d{1,6}$/.test(text) && Number(text) > 0 ? Number(text) : 1
}

// Receiving (spec §9.1 /receiving, FR-P2P-006, gr.post): the POs the member may receive now — sent to the supplier or
// partly received, for a department they receive for as RECEIVER, or their own requests when the DOA in effect lets
// requesters receive (OQ-04) — oldest sent first, a page at a time. The service decides who may receive each PO,
// separation of duties included (BR-SOD-02, BR-SOD-07); POs it refuses for that reason are listed apart with why, so the
// receiver knows to hand them to a colleague. Reading a page changes nothing (a GET).
export default async function ReceivingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale, query] = await Promise.all([getTranslations('receiving'), getLocale(), searchParams])
  const result = await listReceivable(ctx, { page: pageOf(query.page) })

  if (!result.ok || !result.data.receives) {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <h1 className="text-2xl font-semibold">{t('list.notReceiverTitle')}</h1>
        <p className="text-ink-muted">{t('list.notReceiverHint')}</p>
        <Link href="/" className={linkClass}>
          {t('list.home')}
        </Link>
      </div>
    )
  }

  const { rows, blocked, page, pageCount, pageSize, total } = result.data
  const from = (page - 1) * pageSize + 1
  const to = from + rows.length + blocked.length - 1
  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('list.title')}</h1>
        <p className="text-ink-muted">{t('list.intro')}</p>
      </div>

      {pageCount > 1 ? (
        <p className="text-ink" role="status">
          {t('list.range', { from, to, total, page, pages: pageCount })}
        </p>
      ) : null}

      {rows.length ? (
        <>
          {pageCount === 1 ? (
            <p className="text-ink" role="status">
              {t('list.count', { count: rows.length })}
            </p>
          ) : null}
          <ReceivingList rows={rows.map((c) => rowView(c, locale))} label={t('list.label')} />
        </>
      ) : pageCount > 1 ? (
        <p className="border-y border-line py-6 text-ink-muted">{t('list.emptyPage')}</p>
      ) : (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{t('list.emptyTitle')}</p>
          <p className="text-ink-muted">{t('list.emptyHint')}</p>
          <Link href="/" className={linkClass}>
            {t('list.home')}
          </Link>
        </div>
      )}

      {blocked.length ? (
        <section aria-labelledby="receiving-blocked" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="receiving-blocked" className="text-lg font-semibold text-ink">
              {t('list.blockedTitle')}
            </h2>
            <p className="text-ink-muted">{t('list.blockedHint')}</p>
          </div>
          <ReceivingList rows={blocked.map((c) => rowView(c, locale, c.rule))} label={t('list.blockedTitle')} blocked />
        </section>
      ) : null}

      {pageCount > 1 ? (
        <nav aria-label={t('list.pagesLabel')} className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:gap-8">
          {page > 1 ? (
            <Link href={`/receiving?page=${page - 1}`} className={linkClass}>
              {t('list.previous', { page: page - 1 })}
            </Link>
          ) : null}
          {page < pageCount ? (
            <Link href={`/receiving?page=${page + 1}`} className={linkClass}>
              {t('list.next', { page: page + 1 })}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  )
}

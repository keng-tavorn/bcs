import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listReceivable } from '@/server/services/receiving/view'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { ReceivingList } from '@/ui/receiving/receiving-list'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../_lib/session'
import { loadReceivingFilters } from './_filters'
import { rowView } from './present'

export async function generateMetadata() {
  const t = await getTranslations('receiving')
  return { title: t('list.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// Receiving (spec §9.1 /receiving, FR-P2P-006, gr.post): the POs the member may receive now — sent to the supplier or
// partly received, for a department they receive for as RECEIVER, or their own requests when the DOA in effect lets
// requesters receive (OQ-04) — oldest sent first, a page at a time (?page=, read with nuqs in ./_filters.ts). The service
// decides who may receive each PO, separation of duties included (BR-SOD-02, BR-SOD-07); POs it refuses for that reason
// are listed apart with why, in a card of their own, so the receiver knows to hand them to a colleague. Reading a page
// changes nothing (a GET).
export default async function ReceivingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale, query] = await Promise.all([getTranslations('receiving'), getLocale(), loadReceivingFilters(searchParams)])
  const result = await listReceivable(ctx, { page: query.page ?? 1 })

  if (!result.ok || !result.data.receives) {
    return (
      <Page>
        <PageHeader title={t('list.notReceiverTitle')} intro={t('list.notReceiverHint')} />
        <Link href="/" className={linkClass}>
          {t('list.home')}
        </Link>
      </Page>
    )
  }

  const { rows, blocked, page, pageCount, pageSize, total } = result.data
  const from = (page - 1) * pageSize + 1
  const to = from + rows.length + blocked.length - 1
  return (
    <Page>
      <PageHeader title={t('list.title')} intro={t('list.intro')} />
      <PageBody>
        <Panel label={t('list.label')}>
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
            <ListEmpty title={t('list.emptyPage')} />
          ) : (
            <ListEmpty
              title={t('list.emptyTitle')}
              hint={t('list.emptyHint')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/">{t('list.home')}</Link>
                </Button>
              }
            />
          )}

          {pageCount > 1 ? (
            <nav aria-label={t('list.pagesLabel')} className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:gap-8">
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
        </Panel>

        {blocked.length ? (
          <Panel title={t('list.blockedTitle')} id="receiving-blocked">
            <p className="text-ink-muted">{t('list.blockedHint')}</p>
            <ReceivingList rows={blocked.map((c) => rowView(c, locale, c.rule))} label={t('list.blockedTitle')} blocked />
          </Panel>
        ) : null}
      </PageBody>
    </Page>
  )
}

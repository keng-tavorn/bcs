import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { FOLLOW_UP_PATH } from '@/lib/follow-up'
import { ctxFromSession } from '@/server/auth/session'
import { listFollowUps } from '@/server/services/assistants/follow-up'
import { FollowUpList } from '@/ui/assistants/follow-up-list'
import { Refused } from '@/ui/insight/refused'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../_lib/session'
import { localeOf, when } from '../_tracking/present'
import { followUpItems } from './_present'
import { sendFollowUpAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('followUp')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

// The follow-up assistant "ผู้ช่วยตามงาน" (NEW-124 · ADR-082 · FR-VIS-001 AC4 AC5): the approval tasks of the documents
// the reader follows that are past or near their due time, why each still waits, and a nudge to its holder that the
// reader drafts, reads again and sends. Reached from the home card "ผู้ช่วยเจอให้คุณ" and the panel "จากผู้ช่วย" of a
// request or PO; every member has one (their own documents only). The frame of S16-10: title and what the page is for
// on the page's white, the list in a white card on --surface.
export default async function FollowUpsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx || ctx.actor.type !== 'USER') return null
  const [t, locale] = await Promise.all([getTranslations('followUp'), getLocale().then(localeOf)])
  const result = await listFollowUps(ctx)
  if (!result.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />
  const items = followUpItems(t, locale, ctx.actor.memberId, result.data.items)

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')}>
        <p className="text-ink-muted">{t('source')}</p>
        <p className="text-ink">{t('rule')}</p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink">
          <span>{t('asOf', { when: when(locale, result.data.asOf) })}</span>
          {/* a full reload: an installed app has no reload button of its own */}
          <a href={FOLLOW_UP_PATH} className={linkClass}>
            {t('refresh')}
          </a>
        </p>
      </PageHeader>
      <PageBody>
        <Panel title={t('list')} id="follow-up-list">
          {items.length ? (
            <FollowUpList items={items} label={t('list')} reasons={t('reasons')} send={sendFollowUpAction} />
          ) : (
            <ListEmpty
              title={t('empty.title')}
              hint={t('empty.hint')}
              actions={
                <Button asChild variant="outline" className="min-h-11">
                  <Link href="/requests?scope=mine">{t('empty.action')}</Link>
                </Button>
              }
            />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}

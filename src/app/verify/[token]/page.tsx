import Link from 'next/link'
import { headers } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { systemClock } from '@/lib/clock'
import { clientIp } from '@/server/auth/lockout'
import { makeCtx } from '@/server/context'
import { verifyPage } from '@/server/services/documents/verification'
import { Notice } from '@/ui/form/notice'
import { getSession } from '../../_lib/session'

// The public verification page of a printed PR or PO (S6-19 · FR-DOA-102 AC2 · BR-QR-02 · OQ-112): anyone holding the
// paper scans its QR and sees, without signing in, the organization, the kind, the number, the current status and its
// date, and whether the paper is the latest printing — never an amount or a person's name. A token that is missing,
// wrong or of no document shows the same "not found". Reading only: a GET changes nothing (the address limiter counts
// the visit, as for sign-in). A signed-in member who may view the document also gets a link to it. Plain, no shell.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('verify')
  return { title: t('metaTitle'), robots: { index: false, follow: false } }
}

export default async function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token
  const [t, tBadge, locale] = await Promise.all([getTranslations('verify'), getTranslations('document.badge'), getLocale()])
  const now = systemClock.now()
  const session = await getSession()
  const viewer =
    session.kind === 'member'
      ? (organizationId: string) => (session.member.organizationId === organizationId ? makeCtx({ organizationId, actor: { type: 'USER', memberId: session.member.id }, channel: session.client === 'APP' ? 'APP' : 'WEB', now }) : null)
      : null
  const page = await verifyPage(token, clientIp(await headers()), now, viewer)

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-md flex-col px-4 py-4">
          <span className="text-xl font-bold text-ink">{t('brand')}</span>
          <span className="text-base text-ink-muted md:text-sm">{t('tagline')}</span>
        </div>
      </header>
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 pt-8 pb-16">
        {page.kind === 'TOO_MANY' ? (
          <>
            <h1 className="text-2xl font-semibold text-ink">{t('tooManyTitle')}</h1>
            <Notice tone="info">{t('tooManyBody')}</Notice>
          </>
        ) : page.kind === 'NOT_FOUND' ? (
          <>
            <h1 className="text-2xl font-semibold text-ink">{t('notFoundTitle')}</h1>
            <Notice tone="warning">{t('notFoundBody')}</Notice>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-ink">{t(page.document.kind === 'REQUEST' ? 'titleRequest' : 'titlePurchaseOrder')}</h1>
            {page.document.latest ? <Notice tone="success">{t('latest')}</Notice> : <Notice tone="warning">{t('superseded')}</Notice>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-line bg-surface p-4 text-base">
              <dt className="text-ink-muted">{t('organization')}</dt>
              <dd className="text-ink">{page.document.organizationName}</dd>
              <dt className="text-ink-muted">{t('number')}</dt>
              <dd className="font-medium text-ink">{page.document.number}</dd>
              <dt className="text-ink-muted">{t('status')}</dt>
              <dd className="text-ink">{tBadge(`${page.document.kind === 'REQUEST' ? 'request' : 'po'}.${page.document.status}` as Parameters<typeof tBadge>[0])}</dd>
              {page.document.statusAt ? (
                <>
                  <dt className="text-ink-muted">{t('statusAt')}</dt>
                  <dd className="text-ink">
                    {locale === 'en' ? formatEnglishBeDate(new Date(page.document.statusAt)) : formatThaiDate(new Date(page.document.statusAt))}
                  </dd>
                </>
              ) : null}
            </dl>
            <p className="text-base text-ink-muted md:text-sm">{t('privacy')}</p>
            {page.document.href ? (
              <Link href={page.document.href} className="self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
                {t('open')}
              </Link>
            ) : null}
          </>
        )}
      </main>
    </div>
  )
}

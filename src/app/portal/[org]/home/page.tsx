import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { getPortalHome, listPortalTodos } from '@/server/portal/queries'
import { PortalButton, PortalFrame } from '@/ui/portal/frame'
import { pageOrg, pageSession, portalNav, Unavailable } from '../_lib/page'

// /portal/[org]/home (S7-08 · docs/sub-specs/S7.md "/portal/home"): what waits for the contact of a registered supplier,
// from the providers of PORTAL_HOME_PROVIDERS (S7: documents; S7-11 S7-12 S10 S11 add theirs), each a link to where it is
// done. A contact of an application goes to the application; the privacy notice comes first (BR-PORTAL ข้อ 08).

const KINDS = ['DOCUMENT_EXPIRING', 'DOCUMENT_EXPIRED', 'DOCUMENT_MISSING'] as const

export default async function PortalHome({ params }: { params: Promise<{ org: string }> }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, locale, home] = await Promise.all([getTranslations('portal'), getLocale(), getPortalHome(ctx)])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!home.supplier) redirect(`/portal/${org.code}/apply`)
  const todos = (await listPortalTodos(ctx)).filter((x) => (KINDS as readonly string[]).includes(x.kind))
  return (
    <PortalFrame organization={org.nameTh} title={t('home.greeting', { name: home.contact.nameTh })} nav={portalNav(org.code, t, 'home', 'SUPPLIER')} navLabel={t('nav.label')}>
      <p>{t('home.forSupplier', { supplier: home.supplier.nameTh })}</p>
      <section aria-labelledby="todo" className="flex flex-col gap-2">
        <h2 id="todo" className="text-lg font-semibold">
          {t('home.todoTitle')}
        </h2>
        {todos.length ? (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {todos.map((x, i) => (
              <li key={`${x.kind}-${i}`}>
                <a href={`/portal/${org.code}${x.page}`} className="flex min-h-11 items-center py-2 text-primary underline-offset-4 hover:underline">
                  {t(`home.todo.${x.kind as (typeof KINDS)[number]}`, { type: locale === 'en' ? (x.values.typeEn ?? '') : (x.values.typeTh ?? ''), date: x.values.date ?? '' })}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{t('home.todoEmpty')}</p>
        )}
      </section>
      <form method="post" action={`/portal/${org.code}/api/sign-out`}>
        <input type="hidden" name="csrf" value={session.csrf} />
        <PortalButton type="submit" variant="secondary" className="w-full">
          {t('home.signOut')}
        </PortalButton>
      </form>
    </PortalFrame>
  )
}

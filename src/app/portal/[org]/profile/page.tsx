import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPortalHome, listPortalContacts } from '@/server/portal/queries'
import { PortalButton, PortalFrame, PortalNotice, portalCheckboxClass } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, portalNav, Unavailable, type SearchParams } from '../_lib/page'

// /portal/[org]/profile (S7-08): the language, the contacts of the supplier or application (names only), closing one's
// own account (a tick to confirm: it cannot be undone from the portal) and signing out.
export default async function PortalProfilePage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, q, home, contacts] = await Promise.all([getTranslations('portal'), searchParams, getPortalHome(ctx), listPortalContacts(ctx)])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  const me = ctx.actor.type === 'SUPPLIER' ? ctx.actor.supplierContactId : ''
  const error = one(q.error)
  const errorText = error === 'PRIMARY_CONTACT' ? t('profile.closeLast') : error === 'CONFIRM' ? t('profile.closeConfirmNeeded') : error ? t('errors.FAILED') : null
  const owner = home.supplier?.nameTh ?? home.application?.nameTh ?? ''
  return (
    <PortalFrame organization={org.nameTh} title={t('profile.title')} nav={portalNav(org.code, t, 'profile', home.supplier ? 'SUPPLIER' : 'APPLICATION', session.invoices)} navLabel={t('nav.label')}>
      {one(q.saved) ? <PortalNotice tone="success">{t('profile.languageSaved')}</PortalNotice> : null}
      {errorText ? <PortalNotice tone="danger">{errorText}</PortalNotice> : null}
      <form method="post" action={`/portal/${org.code}/api/profile`} className="flex flex-col gap-3">
        <input type="hidden" name="csrf" value={session.csrf} />
        <input type="hidden" name="key" value={randomUUID()} />
        <input type="hidden" name="action" value="locale" />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-lg font-semibold">{t('profile.language')}</legend>
          {(['th', 'en'] as const).map((l) => (
            <label key={l} className="flex min-h-11 items-center gap-3" lang={l}>
              <input type="radio" name="locale" value={l} defaultChecked={home.contact.locale === l} className={portalCheckboxClass} />
              {t(`apply.contact.${l}`)}
            </label>
          ))}
        </fieldset>
        <PortalButton type="submit" variant="secondary">
          {t('profile.saveLanguage')}
        </PortalButton>
      </form>
      <section aria-labelledby="contacts" className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 id="contacts" className="text-lg font-semibold">
          {t('profile.contactsTitle', { name: owner })}
        </h2>
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {contacts.map((c) => (
            <li key={c.id} className="flex flex-col gap-0.5 py-3">
              <span className="font-medium">
                {c.nameTh}
                {c.id === me ? ` (${t('apply.contact.you')})` : ''}
              </span>
              {c.isPrimary ? <span className="text-ink-muted">{t('apply.contact.primary')}</span> : null}
            </li>
          ))}
        </ul>
      </section>
      <form method="post" action={`/portal/${org.code}/api/sign-out`} className="border-t border-line pt-4">
        <input type="hidden" name="csrf" value={session.csrf} />
        <PortalButton type="submit" variant="secondary" className="w-full">
          {t('home.signOut')}
        </PortalButton>
      </form>
      <section aria-labelledby="close" className="flex flex-col gap-3 border-t border-line pt-4">
        <h2 id="close" className="text-lg font-semibold">
          {t('profile.closeTitle')}
        </h2>
        <p className="text-ink-muted">{t('profile.closeBody')}</p>
        <form method="post" action={`/portal/${org.code}/api/profile`} className="flex flex-col gap-3">
          <input type="hidden" name="csrf" value={session.csrf} />
          <input type="hidden" name="key" value={randomUUID()} />
          <input type="hidden" name="action" value="close" />
          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" name="confirm" value="1" required className={portalCheckboxClass} />
            {t('profile.closeConfirm')}
          </label>
          <PortalButton type="submit" variant="danger">
            {t('profile.close')}
          </PortalButton>
        </form>
      </section>
    </PortalFrame>
  )
}

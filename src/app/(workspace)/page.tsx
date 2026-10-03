import { getLocale, getTranslations } from 'next-intl/server'
import { getSession } from '../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('home')
  return { title: t('title') }
}

// Home, work first (§9.9 rule 1): what waits for my decision, then my requests. Both fill in from S2; until then the
// empty states say what will appear here.
export default async function HomePage() {
  const state = await getSession()
  if (state.kind !== 'member') return null
  const [t, locale] = await Promise.all([getTranslations('home'), getLocale()])
  const name = locale === 'en' && state.member.displayNameEn ? state.member.displayNameEn : state.member.displayNameTh
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">{t('greeting', { name })}</h1>
      <section aria-labelledby="my-tasks" className="flex flex-col gap-3">
        <h2 id="my-tasks" className="text-xl font-semibold">
          {t('myTasks')}
        </h2>
        <p className="border-y border-line py-4 text-ink-muted">{t('myTasksEmpty')}</p>
      </section>
      <section aria-labelledby="my-requests" className="flex flex-col gap-3">
        <h2 id="my-requests" className="text-xl font-semibold">
          {t('myRequests')}
        </h2>
        <p className="border-y border-line py-4 text-ink-muted">{t('myRequestsEmpty')}</p>
      </section>
    </div>
  )
}

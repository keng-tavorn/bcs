import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listRequestTypesForAdmin } from '@/server/services/request-types'
import { ModuleState } from '@/ui/admin/module-state'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { RequestTypeControls } from '@/ui/admin-settings/request-type-controls'
import { getSession } from '../../../_lib/session'
import { moveRequestTypeAction, setRequestTypeActiveAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('adminSettings.requestTypes')
  return { title: t('title') }
}

// Request types of the catalog (FR-ADM-005 AC2, §9.1 /admin/*): the list is the order requesters see; each row says
// whether the type is on, which form version it uses, and offers moving, switching and its form page.
export default async function RequestTypesPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tCommon, locale] = await Promise.all([getTranslations('adminSettings.requestTypes'), getTranslations('adminSettings'), getLocale()])
  if (!ctx) return null
  const types = await listRequestTypesForAdmin(ctx)
  if (!types.ok) return <NoAccess title={t('title')} message={tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const nameOf = (type: { nameTh: string; nameEn: string | null }) => (locale === 'en' && type.nameEn ? type.nameEn : type.nameTh)

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <section aria-labelledby="types" className="flex flex-col gap-4">
        <h2 id="types" className="text-xl font-semibold">
          {t('listTitle', { count: types.data.length })}
        </h2>
        {types.data.length === 0 ? (
          <p className="text-ink-muted">{t('empty')}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-line border-y border-line">
            {types.data.map((type, i) => (
              <li key={type.code} className="flex flex-col gap-3 py-4 md:flex-row md:items-start md:justify-between md:gap-6">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="font-medium">{nameOf(type)}</p>
                  <p className="text-base break-words text-ink-muted md:text-sm">
                    {[t('code', { code: type.code }), t(`documentTypes.${type.documentType}`), type.currentVersionNo ? t('formVersion', { version: type.currentVersionNo }) : t('noForm')].join(' · ')}
                  </p>
                  {type.descriptionTh ? <p className="text-base md:text-sm">{type.descriptionTh}</p> : null}
                  <ModuleState enabled={type.active} label={type.active ? t('state.on') : t('state.off')} className="text-base md:text-sm" />
                  <Link
                    href={`/admin/request-types/${encodeURIComponent(type.code)}`}
                    className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline"
                  >
                    {t('manageForm', { name: nameOf(type) })}
                  </Link>
                </div>
                <RequestTypeControls
                  code={type.code}
                  name={nameOf(type)}
                  active={type.active}
                  first={i === 0}
                  last={i === types.data.length - 1}
                  move={moveRequestTypeAction}
                  setActive={setRequestTypeActiveAction}
                />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

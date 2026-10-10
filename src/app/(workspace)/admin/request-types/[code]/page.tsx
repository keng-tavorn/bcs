import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getRequestTypeForAdmin } from '@/server/services/request-types'
import { ModuleState } from '@/ui/admin/module-state'
import { FormImport } from '@/ui/admin-settings/form-import'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { formatDateTime } from '@/ui/format'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../../_lib/session'
import { checkFormImportAction, publishFormVersionAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('adminSettings.requestTypes')
  return { title: t('title') }
}

const FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'select', 'multiselect', 'checkbox', 'member', 'department', 'costCenter', 'budgetLine', 'supplier', 'deliverySite', 'lineItems', 'attachment'] as const
type FieldType = (typeof FIELD_TYPES)[number]
const isFieldType = (type: string): type is FieldType => (FIELD_TYPES as readonly string[]).includes(type)

// The form of one request type (FR-ADM-005 AC1 AC3): the version in use with its fields and attachment rules, every
// version with the requests that keep it, and the JSON import. Wide screens: the form and its history on the left, the
// import on the right; phones: the form in use, the import, then the history.
export default async function RequestTypeFormPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tTypes, tCommon, locale] = await Promise.all([getTranslations('adminSettings.forms'), getTranslations('adminSettings.requestTypes'), getTranslations('adminSettings'), getLocale()])
  if (!ctx) return null
  // Next decodes dynamic params already; decoding again would throw on a code such as "%" (a 500 instead of a 404)
  const result = await getRequestTypeForAdmin(ctx, code)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) return <NoAccess title={tTypes('title')} message={tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const { type, current, versions } = result.data
  const name = locale === 'en' && type.nameEn ? type.nameEn : type.nameTh
  const text = (label: { th: string; en: string } | null, fallback: string) => (label ? (locale === 'en' ? label.en : label.th) : fallback)

  return (
    <Page>
      <Link href="/admin/request-types" className="-mb-4 inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('back')}
      </Link>
      <PageHeader title={name} intro={t('subtitle', { code: type.code })}>
        <ModuleState enabled={type.active} label={type.active ? tTypes('state.on') : tTypes('state.off')} />
      </PageHeader>

      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_26rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-6">
          <Panel title={current ? t('currentTitle', { version: current.versionNo }) : t('fieldsTitle')} id="current" className="lg:col-start-1 lg:row-start-1">
            {current ? (
              <>
                <h3 className="text-base font-semibold">{t('fieldsTitle')}</h3>
                {current.summary.fields.length ? (
                  <ul className="flex flex-col divide-y divide-line border-y border-line">
                    {current.summary.fields.map((f) => (
                      <li key={f.id} className="flex flex-col gap-0.5 py-2.5">
                        <p className="font-medium break-words">{text(f.label, f.id)}</p>
                        <p className="text-base break-words text-ink-muted md:text-sm">
                          {[f.id, t('fieldLine', { type: isFieldType(f.type) ? t(`fieldTypes.${f.type}`) : f.type, required: f.required ? t('required') : t('optional') }), current.summary.conditionalFields.includes(f.id) ? t('conditional') : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ink-muted">{t('noFields')}</p>
                )}
                <h3 className="text-base font-semibold">{t('rulesTitle')}</h3>
                {current.summary.rules.length ? <p className="break-words">{current.summary.rules.join(' · ')}</p> : <p className="text-ink-muted">{t('noRules')}</p>}
                {current.summary.serviceEndDate ? <p className="text-ink-muted">{t('serviceEndDate')}</p> : null}
                <a
                  href={`/admin/request-types/${encodeURIComponent(type.code)}/form`}
                  download
                  className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline"
                >
                  {t('download')}
                </a>
              </>
            ) : (
              <ListEmpty title={t('noCurrent')} />
            )}
          </Panel>

          <Panel title={t('importTitle')} id="import" className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <FormImport code={type.code} check={checkFormImportAction} publish={publishFormVersionAction} />
          </Panel>

          <Panel title={t('versionsTitle')} id="versions" className="lg:col-start-1 lg:row-start-2">
            {versions.length === 0 ? (
              <ListEmpty title={t('versionsEmpty')} />
            ) : (
              <>
                <p className="text-ink-muted">{t('versionsNote')}</p>
                <ul className="flex flex-col divide-y divide-line border-y border-line">
                  {versions.map((v) => (
                    <li key={v.versionNo} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                      <p className="font-medium">
                        {t('versionLine', { version: v.versionNo })}
                        {v.current ? <span className="ml-2 font-normal text-primary">({t('versionCurrent')})</span> : null}
                      </p>
                      <p className="text-base text-ink-muted md:text-sm">
                        {[
                          v.publishedAt ? t('versionPublished', { time: formatDateTime(locale, v.publishedAt) }) : null,
                          v.publishedByName ? t('versionBy', { name: v.publishedByName }) : t('versionBySeed'),
                          t('versionRequests', { count: v.requestCount }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}

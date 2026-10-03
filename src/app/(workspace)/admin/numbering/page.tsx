import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getNumberingAdminView } from '@/server/services/numbering/admin'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { NUMBER_DOCUMENTS, PATTERN_TOKENS, SEQ_EXAMPLE } from '@/ui/admin-settings/numbering'
import { NumberingForm } from '@/ui/admin-settings/numbering-form'
import { toSettingsFailure } from '@/ui/admin-settings/outcome'
import { getSession } from '../../../_lib/session'
import { previewNumberingAction, saveNumberingAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('adminSettings.numbering')
  return { title: t('title') }
}

// Document number patterns (FR-ADM-004, §9.1 /admin/*): one section per numbered document with its next number now and
// a form whose example updates while the admin types. Wide screens put the list of codes on the right; phones after
// the forms.
export default async function NumberingPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tCommon] = await Promise.all([getTranslations('adminSettings.numbering'), getTranslations('adminSettings')])
  if (!ctx) return null
  const view = await getNumberingAdminView(ctx)
  if (!view.ok) return <NoAccess title={t('title')} message={tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const documentNames = Object.fromEntries(NUMBER_DOCUMENTS.map((d) => [d, t(`documents.${d}`)]))

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>

      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-x-12">
        <div className="flex flex-col gap-8 lg:col-start-1 lg:row-start-1">
          {view.data.documents.map((d) => (
            <section key={d.document} aria-labelledby={`doc-${d.document}`} className="flex flex-col gap-3 border-t border-line pt-6 first:border-t-0 first:pt-0">
              <h2 id={`doc-${d.document}`} className="text-xl font-semibold">
                {documentNames[d.document]}
              </h2>
              <p className="tabular text-ink-muted">{d.nextNumber ? t('nextNow', { number: d.nextNumber }) : t('nextNone')}</p>
              <NumberingForm
                document={d.document}
                initial={{
                  pattern: d.pattern,
                  reset: d.reset,
                  department: d.department,
                  nextNumber: d.nextNumber,
                  continues: d.continues,
                  refusal: d.refusal ? (toSettingsFailure({ code: 'VALIDATION_FAILED', details: d.refusal }).refusal ?? null) : null,
                }}
                departments={view.data.departments}
                documentNames={documentNames}
                preview={previewNumberingAction}
                save={saveNumberingAction}
              />
            </section>
          ))}
        </div>

        <aside aria-labelledby="tokens" className="flex flex-col gap-3 lg:col-start-2 lg:row-start-1">
          <h2 id="tokens" className="text-xl font-semibold">
            {t('tokensTitle')}
          </h2>
          <dl className="flex flex-col divide-y divide-line border-y border-line">
            {PATTERN_TOKENS.map(([code, key]) => (
              <div key={key} className="flex flex-col gap-0.5 py-2.5">
                <dt className="font-semibold">{code}</dt>
                <dd className="text-ink-muted">{key === 'SEQ' ? t('tokens.SEQ', { example: SEQ_EXAMPLE }) : t(`tokens.${key}`)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-base text-ink-muted md:text-sm">{t('tokensNote')}</p>
        </aside>
      </div>
    </div>
  )
}

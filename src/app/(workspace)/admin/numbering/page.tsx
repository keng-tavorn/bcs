import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getNumberingAdminView } from '@/server/services/numbering/admin'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
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
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1 lg:gap-6">
            {view.data.documents.map((d) => (
              <Panel key={d.document} title={documentNames[d.document]} id={`doc-${d.document}`}>
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
              </Panel>
            ))}
          </div>

          <Panel title={t('tokensTitle')} id="tokens" className="lg:col-start-2 lg:row-start-1">
            <dl className="flex flex-col divide-y divide-line border-y border-line">
              {PATTERN_TOKENS.map(([code, key]) => (
                <div key={key} className="flex flex-col gap-0.5 py-2.5">
                  <dt className="font-semibold">{code}</dt>
                  <dd className="text-ink-muted">{key === 'SEQ' ? t('tokens.SEQ', { example: SEQ_EXAMPLE }) : t(`tokens.${key}`)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-base text-ink-muted md:text-sm">{t('tokensNote')}</p>
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}

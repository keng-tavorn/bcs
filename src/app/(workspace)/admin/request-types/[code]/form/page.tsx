import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getRequestTypeForAdmin } from '@/server/services/request-types'
import { getFormBuilder } from '@/server/services/request-types/form-builder'
import { FormBuilder } from '@/ui/admin-settings/form-builder'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader } from '@/ui/page/page'
import { getSession } from '../../../../../_lib/session'
import { createFormDraftAction, publishFormDraftAction, saveFormDraftAction } from '../../actions'

export async function generateMetadata() {
  const t = await getTranslations('formBuilder')
  return { title: t('metaTitle') }
}

// The no-code form builder of one request type (S6-14 · FR-INT-104 · BR-FORM-09): the form in use and the one draft,
// edited on the page with a preview of the real request form, then published as the type's next version. ORG_ADMIN only
// (admin.requestTypes, checked by the services); the page reads, the actions change.
export default async function FormBuilderPage({ params }: { params: Promise<{ code: string }> }) {
  // Next decodes dynamic params already; decoding again would throw on a code such as "%" (a 500 instead of a 404)
  const { code } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tTypes, tCommon, locale] = await Promise.all([getTranslations('formBuilder'), getTranslations('adminSettings.requestTypes'), getTranslations('adminSettings'), getLocale()])
  if (!ctx) return null
  const [builder, detail] = await Promise.all([getFormBuilder(ctx, code), getRequestTypeForAdmin(ctx, code)])
  if (!builder.ok && builder.error.code === 'NOT_FOUND') notFound()
  if (!builder.ok || !detail.ok) return <NoAccess title={tTypes('title')} message={tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const { type } = detail.data
  const name = locale === 'en' && type.nameEn ? type.nameEn : type.nameTh
  const b = builder.data

  return (
    <Page>
      <Link
        href={`/admin/request-types/${encodeURIComponent(b.code)}`}
        className="-mb-4 inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline"
      >
        {t('back', { name })}
      </Link>
      <PageHeader title={t('title', { name })} intro={t('intro')} />
      <PageBody>
        <FormBuilder
          view={{
            code: b.code,
            current: b.current,
            draft: b.draft ? { id: b.draft.id, versionNo: b.draft.versionNo, form: b.draft.form, changes: b.draft.changes, noChange: b.draft.noChange, lint: b.draft.lint } : null,
          }}
          typeName={name}
          create={createFormDraftAction}
          save={saveFormDraftAction}
          publish={publishFormDraftAction}
        />
      </PageBody>
    </Page>
  )
}

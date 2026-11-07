import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { bankChoices, getSupplierApplicationForScreen } from '@/server/services/suppliers/applications-view'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { ON_BEHALF_STEPS, OnBehalfForm, type OnBehalfStep } from '@/ui/supplier-applications/on-behalf-form'
import { getSession } from '../../../../../_lib/session'
import { submitOnBehalfAction, updateOnBehalfAction } from '../../actions'

// /suppliers/applications/[id]/edit (S7-09 · BR-SUP ข้อ 10): PROCUREMENT fills in the application for the supplier, a step
// at a time (?step=company|tax|bank|send). Only for an application still waiting for its supplier, and for a member with
// supplier.application.fillOnBehalf — the command checks both again.

export async function generateMetadata() {
  const t = await getTranslations('supplierApplications.edit')
  return { title: t('title') }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function OnBehalfPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [{ id }, q] = await Promise.all([params, searchParams])
  const [t, locale] = await Promise.all([getTranslations('supplierApplications'), getLocale()])
  const result = await getSupplierApplicationForScreen(ctx, id)
  const back = (
    <Link href={`/suppliers/applications/${id}`} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
      {t('edit.back')}
    </Link>
  )
  if (!result.ok || !result.data.can.fillOnBehalf || result.data.kind !== 'NEW' || !['INVITED', 'DRAFT', 'RETURNED'].includes(result.data.status)) {
    return (
      <Page>
        <PageHeader title={t('edit.title')} />
        <PageBody>
          <Notice tone="warning">{!result.ok ? (result.error.code === 'NOT_FOUND' ? t('detail.notFound') : t('detail.forbidden')) : result.data.can.fillOnBehalf ? t('actions.errors.INVALID_STATE_TRANSITION') : t('actions.errors.FORBIDDEN')}</Notice>
          {back}
        </PageBody>
      </Page>
    )
  }
  const a = result.data
  const asked = one(q.step)
  const step: OnBehalfStep = (ON_BEHALF_STEPS as readonly string[]).includes(asked ?? '') ? (asked as OnBehalfStep) : 'company'
  const typeNames = Object.fromEntries(Object.entries(a.documentTypeNames).map(([code, n]) => [code, locale === 'en' ? n.nameEn : n.nameTh]))
  return (
    <Page>
      <PageHeader title={t('edit.title')} intro={t('edit.intro')} />
      <PageBody>
        <Panel title={a.number ? `${a.number} · ${a.fields.nameTh}` : a.fields.nameTh} id="application">
          <OnBehalfForm
            applicationId={a.id}
            version={a.version}
            step={step}
            fields={a.fields}
            banks={bankChoices()}
            missing={a.missing}
            warnings={a.warnings}
            typeNames={typeNames}
            update={updateOnBehalfAction}
            submit={submitOnBehalfAction}
          />
        </Panel>
      </PageBody>
    </Page>
  )
}

import { getLocale, getTranslations } from 'next-intl/server'
import { getNewRequestForm } from '@/server/services/requests/form-view'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { LiffRequestForm } from '@/ui/liff/requests/request-form'
import { liffFormStart } from '@/ui/liff/requests/start'
import { liffPage } from '../../../_lib/session'
import { LIFF_FORM_ACTIONS, LIFF_FORM_PATHS } from '../../_lib/form'
import { screenOf } from '../../_lib/principal'

export async function generateMetadata() {
  const t = await getTranslations('requestForm.page')
  return { title: t('metaNew') }
}

/** Request type codes are plain letters, digits and underscores (the RequestTypes sheet); anything else is no type */
const TYPE_CODE = /^[A-Za-z0-9_-]{1,50}$/

// /liff/requests/new/[type]: the short form of one request type in LINE (§9.4, FR-INT-002, FR-INT-003): the same form
// data as the workspace's (getNewRequestForm: the type's fields and rules, the budget lines the requester may use with
// the default one, today's VAT rate, the delivery sites with the latest one), filled in three steps and sent with the
// same command on the LIFF channel (src/ui/liff/requests/request-form.tsx). Nothing is stored until the requester types —
// the first autosave creates the draft (a GET never changes state). A member only: without a session the gate signs in
// with LINE first and shows nothing of the form.
export default async function LiffNewRequestFormPage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params
  const [t, tl, locale, page] = await Promise.all([getTranslations('requestForm.page'), getTranslations('liffRequests.form'), getLocale(), liffPage()])
  const back = { href: LIFF_FORM_PATHS.catalog, label: tl('backToCatalog') }
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('metaNew')} back={back}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const screen = screenOf(locale)
  const result = TYPE_CODE.test(type) ? await getNewRequestForm(page.ctx, type, screen) : ({ ok: false, error: { code: 'NOT_FOUND' } } as const)
  if (!result.ok) {
    return (
      <LiffFrame title={t('unknownTypeTitle')} back={back}>
        <LiffContent>
          <LiffNotice tone="warning">{result.error.code === 'NOT_FOUND' ? t('unknownType') : t('forbidden')}</LiffNotice>
          <LiffLink href={LIFF_FORM_PATHS.catalog}>{t('toCatalog')}</LiffLink>
        </LiffContent>
      </LiffFrame>
    )
  }
  return (
    <LiffFrame title={t('newTitle', { type: result.data.type.name })} back={back}>
      <LiffRequestForm data={result.data} start={liffFormStart(result.data)} locale={screen} actions={LIFF_FORM_ACTIONS} paths={LIFF_FORM_PATHS} />
    </LiffFrame>
  )
}

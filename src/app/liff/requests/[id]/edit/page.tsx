import { getLocale, getTranslations } from 'next-intl/server'
import { isUuid } from '@/server/queries/requests'
import { getRequestForEdit } from '@/server/services/requests/form-view'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { LiffRequestForm } from '@/ui/liff/requests/request-form'
import { liffFormStart } from '@/ui/liff/requests/start'
import { liffPage } from '../../../_lib/session'
import { LIFF_FORM_ACTIONS, LIFF_FORM_PATHS, liffRequestHref } from '../../_lib/form'
import { screenOf } from '../../_lib/principal'

export async function generateMetadata() {
  const t = await getTranslations('requestForm.page')
  return { title: t('metaEdit') }
}

// /liff/requests/[id]/edit: a draft or a returned request, for its requester to go on with in LINE (FR-INT-006 AC2: the
// same draft on any device; FR-INT-009 AC2: change a returned request and send it again). The same data as the
// workspace's edit page (getRequestForEdit: only the requester, only while it is a draft or returned) in the short form
// of LIFF. The address the form gives a new draft once its first save made it (../../new/[type]).
export default async function LiffEditRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [t, tl, locale, page] = await Promise.all([getTranslations('requestForm.page'), getTranslations('liffRequests.form'), getLocale(), liffPage()])
  const back = { href: LIFF_FORM_PATHS.catalog, label: tl('backToCatalog') }
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('metaEdit')} back={back}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const screen = screenOf(locale)
  const result = isUuid(id) ? await getRequestForEdit(page.ctx, id, screen) : ({ ok: false, error: { code: 'NOT_FOUND' } } as const)
  if (!result.ok) {
    const code = result.error.code
    // The service names the status: a cancelled request says so, as it may never have been sent (DRAFT → CANCELLED, §6.4)
    const status = 'details' in result.error ? result.error.details?.status : undefined
    const [title, body] =
      code === 'INVALID_STATE_TRANSITION'
        ? status === 'CANCELLED'
          ? [t('cancelledTitle'), t('cancelled')]
          : [t('sentTitle'), t('sent')]
        : code === 'FORBIDDEN'
          ? [t('notYoursTitle'), t('notYours')]
          : [tl('notFoundTitle'), tl('notFound')]
    return (
      <LiffFrame title={title} back={back}>
        <LiffContent>
          <LiffNotice tone="warning">{body}</LiffNotice>
          {code === 'NOT_FOUND' ? <LiffLink href={LIFF_FORM_PATHS.catalog}>{t('toCatalog')}</LiffLink> : <LiffLink href={liffRequestHref(id)}>{t('openRequest')}</LiffLink>}
        </LiffContent>
      </LiffFrame>
    )
  }
  const data = result.data
  return (
    <LiffFrame title={t(data.draft?.status === 'RETURNED' ? 'returnedTitle' : 'draftTitle', { type: data.type.name })} back={back}>
      <LiffRequestForm data={data} start={liffFormStart(data)} locale={screen} actions={LIFF_FORM_ACTIONS} paths={LIFF_FORM_PATHS} />
    </LiffFrame>
  )
}

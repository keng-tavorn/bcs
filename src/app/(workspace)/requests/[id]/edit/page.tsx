import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { getRequestAccess } from '@/server/queries/requests'
import { getRequestForEdit } from '@/server/services/requests/form-view'
import { Notice } from '@/ui/form/notice'
import { RequestForm } from '@/ui/request-form/request-form'
import { completeUploadAction, downloadUrlAction, requestUploadAction } from '../../../../_lib/file-actions'
import { getSession } from '../../../../_lib/session'
import { editRefusal } from '../../../_tracking/access'
import { attachFileAction, detachFileAction, previewRequestAction, submitRequestAction } from '../../new/actions'

export async function generateMetadata() {
  const t = await getTranslations('requestForm.page')
  return { title: t('metaEdit') }
}

const link = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// A draft or a returned request, opened by its requester on any device (FR-INT-006, FR-INT-009 AC2). Only the requester
// edits it, only while it is a draft or returned; the services check both again on every save. Refused, the page says
// why in words of its own and leads on (§9.9 rule 7): a request sent or cancelled to its page; a reader who is not its
// requester to its page when they may open it (the request page's own check), and home when they may not — never to a
// page that refuses them again; the requester whose account may no longer edit to their administrator.
export default async function EditRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, locale] = await Promise.all([getTranslations('requestForm.page'), getLocale()])
  const screen = locale === 'en' ? 'en' : 'th'
  const result = await getRequestForEdit(ctx, id, screen)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok && result.error.code === 'INVALID_STATE_TRANSITION') {
    // The service names the status: a cancelled request says so, as it may never have been sent (DRAFT → CANCELLED, §6.4)
    const cancelled = result.error.details?.status === 'CANCELLED'
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{cancelled ? t('cancelledTitle') : t('sentTitle')}</h1>
        <Notice tone="info">{cancelled ? t('cancelled') : t('sent')}</Notice>
        <Link href={`/requests/${id}`} className={link}>
          {t('openRequest')}
        </Link>
      </div>
    )
  }
  if (!result.ok) {
    // Not this account's to edit: who is reading decides what the page says and where it leads (editRefusal)
    const access = await getRequestAccess(ctx, id)
    const refusal = access ? editRefusal(memberPrincipal(state.member.id, state.roles), access) : ({ who: 'NONE', canOpen: false } as const)
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{refusal.who === 'REQUESTER' ? t('lostEditTitle') : t('notYoursTitle')}</h1>
        <Notice tone="warning">{refusal.who === 'REQUESTER' ? t('lostEdit') : refusal.who === 'VIEWER' ? t('viewOnly') : t('noAccess')}</Notice>
        {refusal.canOpen ? (
          <Link href={`/requests/${id}`} className={link}>
            {t('openRequest')}
          </Link>
        ) : (
          <Link href="/" className={link}>
            {t('home')}
          </Link>
        )}
      </div>
    )
  }
  return (
      <RequestForm
        data={result.data}
        locale={screen}
        autosaveUrl="/requests/new/autosave"
        actions={{
          preview: previewRequestAction,
          attach: attachFileAction,
          detach: detachFileAction,
          submit: submitRequestAction,
          requestUpload: requestUploadAction,
          completeUpload: completeUploadAction,
          downloadUrl: downloadUrlAction,
        }}
      />
  )
}

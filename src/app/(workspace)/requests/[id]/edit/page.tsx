import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getRequestForEdit } from '@/server/services/requests/form-view'
import { Notice } from '@/ui/form/notice'
import { RequestForm } from '@/ui/request-form/request-form'
import { completeUploadAction, downloadUrlAction, requestUploadAction } from '../../../../_lib/file-actions'
import { getSession } from '../../../../_lib/session'
import { attachFileAction, detachFileAction, previewRequestAction, submitRequestAction } from '../../new/actions'

export async function generateMetadata() {
  const t = await getTranslations('requestForm.page')
  return { title: t('metaEdit') }
}

const link = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// A draft or a returned request, opened by its requester on any device (FR-INT-006, FR-INT-009 AC2). Only the requester
// edits it, only while it is a draft or returned; the services check both again on every save.
export default async function EditRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('requestForm.page'), getLocale()])
  const screen = locale === 'en' ? 'en' : 'th'
  const result = await getRequestForEdit(ctx, id, screen)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) {
    const sent = result.error.code === 'INVALID_STATE_TRANSITION'
    // The service names the status: a cancelled request says so, as it may never have been sent (DRAFT → CANCELLED, §6.4)
    const cancelled = sent && result.error.details?.status === 'CANCELLED'
    const [title, body] = cancelled ? [t('cancelledTitle'), t('cancelled')] : sent ? [t('sentTitle'), t('sent')] : [t('notYoursTitle'), t('notYours')]
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <Notice tone={sent ? 'info' : 'warning'}>{body}</Notice>
        <Link href={`/requests/${id}`} className={link}>
          {t('openRequest')}
        </Link>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <RequestForm
        data={result.data}
        locale={screen}
        autosaveUrl="/requests/new/autosave"
        backLink="toCatalog"
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
    </div>
  )
}

import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getNewRequestForm } from '@/server/services/requests/form-view'
import { Notice } from '@/ui/form/notice'
import { RequestForm } from '@/ui/request-form/request-form'
import { documentAiFor } from '../../../../_lib/ai-read'
import { completeUploadAction, downloadUrlAction, requestUploadAction } from '../../../../_lib/file-actions'
import { getSession } from '../../../../_lib/session'
import { attachFileAction, detachFileAction, previewRequestAction, submitRequestAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('requestForm.page')
  return { title: t('metaNew') }
}

const TYPE_CODE = /^[A-Za-z0-9_-]{1,50}$/

// The form of a new request of one type (§9.1 /requests/new/[type], FR-INT-002, FR-INT-003): nothing is stored until the
// requester types — the first autosave creates the draft (a GET never changes state).
export default async function NewRequestFormPage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('requestForm.page'), getLocale()])
  const screen = locale === 'en' ? 'en' : 'th'
  // Request type codes are plain letters, digits and underscores (the RequestTypes sheet); anything else is no type
  const result = TYPE_CODE.test(type) ? await getNewRequestForm(ctx, type, screen) : ({ ok: false, error: { code: 'NOT_FOUND' } } as const)
  if (!result.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('unknownTypeTitle')}</h1>
        <Notice tone="warning">{result.error.code === 'NOT_FOUND' ? t('unknownType') : t('forbidden')}</Notice>
        <Link href="/requests/new" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('toCatalog')}
        </Link>
      </div>
    )
  }
  // The Document Agent reads quotations into the form when it is available to this member (FR-AI-303 AC8)
  const ai = await documentAiFor(ctx)
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
          ...(ai ? { ai } : {}),
        }}
      />
  )
}

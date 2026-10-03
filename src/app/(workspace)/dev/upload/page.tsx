import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getEnv } from '@/lib/env'
import { UploadHarness } from '@/ui/files/upload-harness'
import { completeUploadAction, downloadUrlAction, requestUploadAction } from '../../../_lib/file-actions'

// Attachment test page for developer machines only (404 on staging and production): S1 has no business document to
// attach files to yet; request forms take over in S2-11.
export default async function UploadHarnessPage() {
  if (getEnv().APP_ENV !== 'local') notFound()
  const t = await getTranslations('files')
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('harnessTitle')}</h1>
      <p className="text-ink-muted">{t('harnessIntro')}</p>
      <UploadHarness requestUpload={requestUploadAction} completeUpload={completeUploadAction} downloadUrl={downloadUrlAction} />
    </div>
  )
}

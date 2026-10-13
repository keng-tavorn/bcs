import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getDoaOverviewForAdmin } from '@/server/services/doa/view'
import { DoaAiDraft } from '@/ui/admin-doa/ai-draft'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { doaDrafterFor } from '../../../../_lib/ai-read'
import { completeUploadAction, requestUploadAction } from '../../../../_lib/file-actions'
import { getSession } from '../../../../_lib/session'

// /admin/doa/ai-draft (FR-AI-308, docs/sub-specs/S13.md "หน้าจอ"): the DOA drafter for whoever may draft the DOA, only
// while the drafter is available to them (BR-AI-11); otherwise the page says so and the DOA is edited as before.
export default async function DoaAiDraftPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tDoa] = await Promise.all([getTranslations('aiAssist.doa'), getTranslations('adminDoa')])
  const overview = await getDoaOverviewForAdmin(ctx)
  if (!overview.ok) return <NoAccess title={t('title')} message={tDoa('forbidden')} homeLabel={tDoa('homeLink')} />
  const drafter = await doaDrafterFor(ctx)
  return (
    <Page>
      <Link href="/admin/doa" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {tDoa('title')}
      </Link>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel>{drafter ? <DoaAiDraft actions={drafter} uploads={{ requestUpload: requestUploadAction, completeUpload: completeUploadAction }} /> : <Notice tone="info">{t('unavailable')}</Notice>}</Panel>
      </PageBody>
    </Page>
  )
}

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getDoaEditor } from '@/server/services/doa/editor'
import { DoaEditor } from '@/ui/admin-doa/editor'
import { versionLook } from '@/ui/admin-doa/version-status'
import { Notice } from '@/ui/form/notice'
import { getSession } from '../../../../../_lib/session'
import { saveDoaDraftAction } from '../../actions'

export async function generateMetadata() {
  const t = await getTranslations('adminDoa')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

// The DOA editor (FR-DOA-001 AC1): the version named in the address — the list links its latest version — copied into
// a table per document type with the version's policies, edited in three steps and saved once as a new draft with the
// next number; the version itself never changes. admin.doa.draft (ORG_ADMIN) only: the service refuses anyone else,
// PLATFORM_ADMIN included (NG-12), and this page then says whose page it is.
export default async function DoaEditPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const t = await getTranslations('adminDoa')
  if (!ctx) return null
  const result = await getDoaEditor(ctx, versionId)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="danger">{t('forbidden')}</Notice>
        <Link href="/" className={`${linkClass} self-start`}>
          {t('homeLink')}
        </Link>
      </div>
    )
  }
  const view = result.data
  const source = view.source
  const sourceName = t('versionName', { code: source.code, version: source.versionNo })
  const draftName = t('versionName', { code: source.code, version: view.nextVersionNo })

  return (
    <div className="flex max-w-6xl flex-col gap-8">
      <Link href={`/admin/doa/${source.id}`} className={`${linkClass} self-start`}>
        {t('editor.back', { name: sourceName })}
      </Link>
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('editor.pageTitle', { name: draftName })}</h1>
        <p className="text-ink-muted">{t('editor.pageIntro', { source: sourceName, status: t(`status.${versionLook(source)}`), name: draftName })}</p>
      </div>
      <DoaEditor
        sourceVersionId={source.id}
        code={source.code}
        sourceVersionNo={source.versionNo}
        nextVersionNo={view.nextVersionNo}
        defaultEffectiveDate={view.defaultEffectiveDate}
        minEffectiveDate={view.minEffectiveDate}
        policy={view.policy}
        rules={view.rules}
        positions={view.positions}
        members={view.members}
        save={saveDoaDraftAction}
      />
    </div>
  )
}

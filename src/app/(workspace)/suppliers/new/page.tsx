import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getNewSupplierContext } from '@/server/services/suppliers/view'
import { Notice } from '@/ui/form/notice'
import { NewSupplierForm } from '@/ui/suppliers/create-form'
import { completeUploadAction, requestUploadAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { checkSupplierAction, createSupplierAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('suppliers.new')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// Adding a supplier (spec §9.1 /suppliers/new, S4-02, FR-SUP-001): PROCUREMENT types the 13-digit tax id and the
// Revenue Department and DBD fill the rest for them to check (stub mode locally and in the demo, BR-SUP-05). Anyone
// else is told who adds suppliers; the service refuses them anyway (supplier.manage, BR-AUTH-05).
export default async function NewSupplierPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const t = await getTranslations('suppliers.new')
  const context = await getNewSupplierContext(ctx)
  if (!context.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('forbiddenTitle')}</h1>
        <Notice tone="warning">{t('forbidden')}</Notice>
        <Link href="/suppliers" className={linkClass}>
          {t('back')}
        </Link>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <Link href="/suppliers" className={linkClass}>
        {t('back')}
      </Link>
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <NewSupplierForm
        suggestedCode={context.data.suggestedCode}
        stub={context.data.registryMode === 'stub'}
        actions={{ check: checkSupplierAction, create: createSupplierAction, requestUpload: requestUploadAction, completeUpload: completeUploadAction }}
      />
    </div>
  )
}

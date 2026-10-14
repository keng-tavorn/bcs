import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { newApInvoiceView } from '@/server/services/ap/view-list'
import { NewInvoiceForm, type PoChoiceView } from '@/ui/ap/list/new-invoice-form'
import { Notice } from '@/ui/form/notice'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { documentAiFor } from '../../../../_lib/ai-read'
import { getSession } from '../../../../_lib/session'
import { localeOf } from '../../../_tracking/present'
import { money } from '../../present'
import { createApInvoiceAction, createApInvoiceFromReadingAction } from '../ap-list-actions'

export async function generateMetadata() {
  const t = await getTranslations('apList.new')
  return { title: t('metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// /finance/invoices/new (S8-13, FR-AP-101 AC1): FINANCE chooses the PO an invoice is for and uploads the supplier's file,
// or starts without one, and lands on the draft. The view checks invoice.record and module PAY before anything is read;
// the commands check again.
export default async function NewApInvoicePage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('apList'), getLocale().then(localeOf)])
  const result = await newApInvoiceView(ctx)
  // S13-20: the Document Agent's button, only while it is available to this member (FR-AI-303 AC8, EG-1)
  const ai = result.ok ? await documentAiFor(ctx) : undefined
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{result.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : t('forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('home')}
          </Link>
        </div>
      </Page>
    )
  }
  const pos: PoChoiceView[] = result.data.pos.map((po) => {
    const supplier = `${locale === 'en' && po.supplier.nameEn ? po.supplier.nameEn : po.supplier.nameTh} (${po.supplier.code})`
    return { value: po.id, label: t('new.poOption', { number: po.number ?? '-', supplier }), summary: t('new.poSummary', { supplier, amount: money(po.netSatang) }) }
  })

  return (
    <Page>
      <PageHeader
        title={t('new.title')}
        intro={t('new.intro')}
        actions={
          <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
            <Link href="/finance/invoices">{t('toList')}</Link>
          </Button>
        }
      />
      <PageBody>
        {pos.length ? (
          <NewInvoiceForm pos={pos} create={createApInvoiceAction} {...(ai ? { ai: { read: ai, createFromReading: createApInvoiceFromReadingAction } } : {})} />
        ) : (
          <Panel label={t('new.poTitle')}>
            <ListEmpty
              title={t('new.noPos')}
              hint={t('new.noPosHint')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/procurement/pos">{t('new.toPos')}</Link>
                </Button>
              }
            />
          </Panel>
        )}
      </PageBody>
    </Page>
  )
}

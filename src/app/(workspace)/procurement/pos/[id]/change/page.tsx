import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getPoChangeForm } from '@/server/services/purchase-orders/view-change'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { PoChangeForm } from '@/ui/po-change/change-form'
import { OpenChangeActions } from '@/ui/po-change/open-change'
import { changeFacts } from '@/ui/po-change/po-tabs'
import { PO_CHANGE_BADGES } from '@/ui/po-change/looks'
import { StatusBadge } from '@/ui/document/badges'
import { getSession } from '../../../../../_lib/session'
import { localeOf, money } from '../../../../_tracking/present'
import { cancelChangeAction, createChangeAction, previewChangeAction, submitChangeAction } from '../s8-actions'

export async function generateMetadata() {
  const t = await getTranslations('poChange')
  return { title: t('page.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// The change of a sent PO (S8-13, FR-AP-107 AC2 AC3 AC5, BR-POC-01 to BR-POC-05): procurement (po.change) drafts a
// change of prices, quantities, the delivery date or the notes, sees the PO's new totals from the server, and sends it
// for approval under DOA PO_CHANGE — or cancels it. One change is open at a time: while there is one, the page shows it
// with what it does and its actions instead of a new form. Without a PO_CHANGE rule in the DOA in effect the page says
// so (BR-POC-05); anyone else is told the page is procurement's. The view and every command check again.
export default async function PoChangePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('poChange'), getLocale().then(localeOf)])
  const back = (
    <Link href={`/procurement/pos/${id}`} className={linkClass}>
      {t('page.back')}
    </Link>
  )

  const view = await getPoChangeForm(ctx, id)
  if (!view.ok) {
    if (view.error.code === 'NOT_FOUND') notFound()
    const doa = view.error.code === 'DOA_NOT_CONFIGURED'
    return (
      <Page>
        <PageHeader title={doa ? t('page.doaMissingTitle') : t('page.forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-3">
          <Notice tone="warning">{doa ? t('page.doaMissing') : t('page.forbiddenHint')}</Notice>
          {back}
        </div>
      </Page>
    )
  }
  const { po, lines, open, changeable } = view.data
  const title = t('page.title', { number: po.number ?? t('page.draftNumber') })

  return (
    <Page>
      <div className="flex flex-col gap-2">
        {back}
        <PageHeader title={title} intro={`${po.supplierName} · ${t('page.current', { amount: money(po.grossSatang), revision: po.revisionNo })}`} />
      </div>
      <PageBody>
        <Panel label={title}>
          <div className="flex max-w-3xl flex-col gap-5">
            <p className="text-ink">{t('page.intro')}</p>
            {open ? (
              <section aria-labelledby="po-change-open" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="po-change-open" className="text-lg font-semibold text-ink">
                    {t('open.title', { no: open.changeNo })}
                  </h2>
                  <StatusBadge look={PO_CHANGE_BADGES[open.status]} label={t(`changeStatus.${open.status}` as 'changeStatus.DRAFT')} />
                </div>
                <p className="text-ink-muted">{open.status === 'DRAFT' ? (open.autoApproved ? t('open.draftAutoHint') : t('open.draftHint')) : t('open.pendingHint')}</p>
                <ul className="flex flex-col gap-1">
                  {changeFacts(t, locale, open).map((f) => (
                    <li key={f} className="tabular break-words text-ink">
                      {f}
                    </li>
                  ))}
                </ul>
                {open.notesToSupplier ? <p className="break-words whitespace-pre-line text-ink">{t('open.notes', { notes: open.notesToSupplier })}</p> : null}
                {open.quantityDisposition ? <p className="text-ink">{t('open.disposition', { disposition: t(`form.dispositionOption.${open.quantityDisposition}` as 'form.dispositionOption.RETURN_TO_POOL') })}</p> : null}
                {open.reason ? <p className="break-words whitespace-pre-line text-ink-muted">{t('changes.reason', { reason: open.reason })}</p> : null}
                <OpenChangeActions
                  change={{ id: open.id, version: open.version, changeNo: open.changeNo, status: open.status, autoApproved: open.autoApproved }}
                  actions={{ submit: submitChangeAction, cancel: cancelChangeAction }}
                />
              </section>
            ) : changeable ? (
              <PoChangeForm
                poId={po.id}
                lines={lines.map((l) => ({
                  id: l.id,
                  lineNo: l.lineNo,
                  description: l.description,
                  uom: l.uom,
                  quantity: l.quantity,
                  unitPrice: money(l.unitPriceSatang),
                  received: l.received,
                  invoiced: l.invoiced,
                  maxQuantity: l.maxQuantity,
                  minQuantity: l.minQuantity,
                  priceLocked: l.priceLocked,
                }))}
                deliveryDate={po.deliveryDate}
                notesToSupplier={po.notesToSupplier}
                actions={{ preview: previewChangeAction, create: createChangeAction }}
              />
            ) : (
              <Notice tone="info">{t('page.notChangeable')}</Notice>
            )}
          </div>
        </Panel>
      </PageBody>
    </Page>
  )
}

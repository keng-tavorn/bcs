import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatThaiDate } from '@/core/thai'
import { getPortalHome } from '@/server/portal/queries'
import { listPortalInvoicePos } from '@/server/portal/queries-invoices'
import { PortalButton, PortalField, PortalFrame, PortalNotice, portalCheckboxClass, portalInputClass } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, portalNav, Unavailable, type SearchParams } from '../../_lib/page'

// /portal/[org]/invoices/new (S7-12 · FR-AP-101 AC7 · BR-SUP ข้อ 15): a new invoice on a PO of the contact's supplier that
// takes one — the PO, the invoice's file (PDF, JPEG or PNG · 20 MB), the supplier's number, its date, the VAT it states
// and whether its prices include VAT. The lines start from what is still to invoice on the PO; the contact changes them on
// the invoice's page until finance confirms its coding.

const ERRORS = ['FILE_REQUIRED', 'TYPE_NOT_ALLOWED', 'TOO_LARGE', 'INVOICE_NO', 'INVOICE_DATE', 'AMOUNT', 'RATE_LIMITED', 'NOT_FOUND', 'INVALID_STATE_TRANSITION'] as const

export default async function PortalNewInvoicePage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, home, q] = await Promise.all([getTranslations('portal'), getPortalHome(ctx), searchParams])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!home.supplier) redirect(`/portal/${org.code}/apply`)
  const nav = portalNav(org.code, t, 'invoices', 'SUPPLIER', session.invoices)
  if (!session.invoices) {
    return (
      <PortalFrame organization={org.nameTh} title={t('invoices.newTitle')} nav={nav} navLabel={t('nav.label')}>
        <PortalNotice tone="info">{t('invoices.off')}</PortalNotice>
      </PortalFrame>
    )
  }
  const pos = await listPortalInvoicePos(ctx)
  const error = one(q.error)
  const known = error && (ERRORS as readonly string[]).includes(error) ? (error as (typeof ERRORS)[number]) : null
  const chosen = one(q.po) ?? ''
  const back = (
    <a href={`/portal/${org.code}/invoices`} className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 hover:no-underline">
      {t('invoices.back')}
    </a>
  )
  return (
    <PortalFrame organization={org.nameTh} title={t('invoices.newTitle')} nav={nav} navLabel={t('nav.label')}>
      {error ? <PortalNotice tone="danger">{known ? t(`invoices.errors.${known}`) : t('invoices.errors.FAILED')}</PortalNotice> : null}
      {pos.length === 0 ? (
        <p className="text-ink-muted">{t('invoices.noPos')}</p>
      ) : (
        <form method="post" action={`/portal/${org.code}/api/invoices`} encType="multipart/form-data" className="flex flex-col gap-4">
          <input type="hidden" name="csrf" value={session.csrf} />
          <input type="hidden" name="key" value={randomUUID()} />
          <p className="text-ink-muted">{t('invoices.newIntro')}</p>
          <PortalField id="poId" label={t('invoices.po')} required requiredLabel={t('invoices.required')}>
            <select id="poId" name="poId" required defaultValue={pos.some((p) => p.id === chosen) ? chosen : ''} className={portalInputClass}>
              <option value="" disabled>
                {t('invoices.choosePo')}
              </option>
              {pos.map((p) => (
                <option key={p.id} value={p.id}>
                  {t('invoices.poOption', { number: p.number ?? '-', date: p.sentAt ? formatThaiDate(p.sentAt) : '-', amount: formatSatang(BigInt(p.grossSatang)) })}
                </option>
              ))}
            </select>
          </PortalField>
          <PortalField id="file" label={t('invoices.file')} hint={t('invoices.fileHint')} required requiredLabel={t('invoices.required')}>
            <input id="file" name="file" type="file" required accept="application/pdf,image/jpeg,image/png" className={portalInputClass} />
          </PortalField>
          <PortalField id="supplierInvoiceNo" label={t('invoices.supplierNo')} required requiredLabel={t('invoices.required')}>
            <input id="supplierInvoiceNo" name="supplierInvoiceNo" required maxLength={60} autoComplete="off" className={portalInputClass} />
          </PortalField>
          <PortalField id="invoiceDate" label={t('invoices.date')} required requiredLabel={t('invoices.required')}>
            <input id="invoiceDate" name="invoiceDate" type="date" required className={portalInputClass} />
          </PortalField>
          <PortalField id="statedVat" label={t('invoices.vat')} hint={t('invoices.vatHint')} required requiredLabel={t('invoices.required')}>
            <input id="statedVat" name="statedVat" inputMode="decimal" required pattern="[0-9,]+(\.[0-9]{1,2})?" className={portalInputClass} />
          </PortalField>
          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" name="priceIncludesVat" className={portalCheckboxClass} />
            <span>{t('invoices.includesVat')}</span>
          </label>
          <PortalButton type="submit">{t('invoices.send')}</PortalButton>
        </form>
      )}
      {back}
    </PortalFrame>
  )
}

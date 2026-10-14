import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { Amounts, Facts, Section, type Fact } from '@/ui/request-view/facts'

// The body of an approval task on an invoice's price variance (S8-06, FR-AP-105 AC2, BR-AP-06): the invoice and its PO,
// each line over the PO price (the PO's and the invoice's unit price and the difference) and the variance with its VAT,
// on the web. `brief` is the LIFF summary (ADR-052: no workspace component, numbers and the total only, BR-AP-09). Flat
// sections, amounts right-aligned in tabular digits (§9.9). No link: the invoice page comes with S8-13.

/** The view the page reads (getInvoiceTaskView of src/server/queries/ap-invoices.ts has this shape) */
export interface InvoiceTaskView {
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly invoiceDate: string | null
  readonly po: { readonly number: string | null }
  readonly supplier: { readonly nameTh: string }
  readonly lines: ReadonlyArray<{ readonly lineNo: number; readonly description: string; readonly quantity: string; readonly uom: string; readonly poUnitPriceSatang: bigint; readonly unitPriceSatang: bigint; readonly overSatang: bigint }>
  readonly variance: { readonly netSatang: bigint; readonly vatSatang: bigint } | null
}

export async function InvoiceVarianceBody({ invoice, brief = false }: { invoice: InvoiceTaskView; brief?: boolean }) {
  const [t, locale] = await Promise.all([getTranslations('tasks.invoice'), getLocale()])
  // "YYYY-MM-DD" as the reader's language writes a day: "12 ต.ค. 2569" · "12 Oct 2569" (BR-DATE-01)
  const day = (d: string) => (locale === 'en' ? formatEnglishBeDate : formatThaiDate)(`${d}T00:00:00+07:00`)
  const money = (s: bigint) => formatSatang(s)
  const facts: Fact[] = [
    { label: t('number'), value: invoice.number ?? '-' },
    { label: t('po'), value: invoice.po.number ?? '-' },
    ...(brief ? [] : [{ label: t('supplierInvoiceNo'), value: invoice.supplierInvoiceNo ?? '-' }, { label: t('supplier'), value: invoice.supplier.nameTh }]),
    ...(brief || !invoice.invoiceDate ? [] : [{ label: t('invoiceDate'), value: day(invoice.invoiceDate) }]),
  ]
  const variance = invoice.variance
  return (
    <div className="@container flex flex-col gap-6">
      <Facts items={facts} />
      {!brief && invoice.lines.length > 0 ? (
        <Section id="invoice-variance-lines" title={t('linesTitle')}>
          <Facts
            columns="one"
            items={invoice.lines.map((l) => ({
              label: t('line', { no: l.lineNo, description: l.description }),
              value: (
                <span className="tabular">{t('lineValue', { quantity: l.quantity, uom: l.uom, poPrice: money(l.poUnitPriceSatang), price: money(l.unitPriceSatang), over: money(l.overSatang) })}</span>
              ),
            }))}
          />
        </Section>
      ) : null}
      {variance ? (
        <Section id="invoice-variance-amounts" title={t('amountsTitle')}>
          <Amounts
            heading={t('unit')}
            unit={t('unit')}
            rows={[
              { label: t('net'), value: money(variance.netSatang) },
              { label: t('vat'), value: money(variance.vatSatang) },
              { label: t('gross'), value: money(variance.netSatang + variance.vatSatang), total: true },
            ]}
          />
          <p className="text-base text-ink-muted md:text-sm">{t('approveHint')}</p>
        </Section>
      ) : null}
    </div>
  )
}

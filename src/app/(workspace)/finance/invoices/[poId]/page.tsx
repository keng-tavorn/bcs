import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getInvoicePoView, type InvoicePoViewDto } from '@/server/services/invoices/view'
import { InvoiceForm } from '@/ui/finance/invoice-form'
import { InvoiceList } from '@/ui/finance/invoice-list'
import { Notice } from '@/ui/form/notice'
import { PoStatus } from '@/ui/purchase-order/status'
import { StateLine } from '@/ui/request-view/status'
import { HEAD_OFFICE } from '@/ui/suppliers/model'
import { downloadUrlAction } from '../../../../_lib/file-actions'
import { getSession } from '../../../../_lib/session'
import { day, localeOf, memberName, when, type Locale } from '../../../_tracking/present'
import { budgetLineText, invoiceStates, money, nameIn, taxIdText, vatRateText, type FinanceT } from '../../present'
import { previewInvoiceAction, recordInvoiceAction } from '../actions'

export async function generateMetadata({ params }: { params: Promise<{ poId: string }> }) {
  const { poId } = await params
  const t = await getTranslations('finance.po')
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  // The title names the PO only for those who may open it
  const view = ctx ? await getInvoicePoView(ctx, poId) : null
  return { title: view?.ok && view.data.number ? t('metaTitle', { number: view.data.number }) : t('metaTitleNoNumber') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** One figure of the PO: label and amount, the amount right-aligned in tabular digits */
function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`money text-ink ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  )
}

/** The budget of the PO's lines, per budget line: what it still holds and what has become actual (FR-P2P-008 AC2) */
function budgetOf(po: InvoicePoViewDto): Array<{ id: string; text: string; committed: bigint; actual: bigint }> {
  const byLine = new Map<string, { id: string; text: string; committed: bigint; actual: bigint }>()
  for (const l of po.lines) {
    const before = byLine.get(l.budgetLine.id) ?? { id: l.budgetLine.id, text: budgetLineText(l.budgetLine), committed: 0n, actual: 0n }
    byLine.set(l.budgetLine.id, { ...before, committed: before.committed + l.committedSatang, actual: before.actual + l.actualSatang })
  }
  return [...byLine.values()]
}

function Blocked({ po, t, locale }: { po: InvoicePoViewDto; t: FinanceT; locale: Locale }) {
  switch (po.blocked) {
    case 'NOT_SENT':
      return <Notice tone="info">{t('po.blocked.NOT_SENT', { status: t(`poStatus.${po.status as 'SENT'}`) })}</Notice>
    case 'CANCELLED':
      return <Notice tone="info">{t('po.blocked.CANCELLED')}</Notice>
    case 'FINAL_RECORDED':
      return <Notice tone="success">{po.status === 'CLOSED' && po.closedAt ? t('po.blocked.FINAL_CLOSED', { date: day(locale, po.closedAt) }) : t('po.blocked.FINAL_RECORDED')}</Notice>
    case 'NOTHING_HELD':
      return <Notice tone="info">{po.status === 'CLOSED' ? t('po.blocked.NOTHING_HELD_CLOSED') : t('po.blocked.NOTHING_HELD')}</Notice>
    default:
      return null
  }
}

// Recording the supplier's invoice of one PO (spec §9.1 /finance/invoices/[poId], S4-08, S4-17, FR-P2P-008, demo scene
// 13): which PO and supplier (tax id and branch, to compare with the invoice), whether an invoice can be recorded now and
// if not why in plain words, the two-step form (an e-Tax file fills it; the server shows what will happen before anything
// is written), and beside it the PO's figures — received, invoiced, still held — the budget of its lines (committed and
// actual), its lines, and the invoices recorded so far. FINANCE's page (invoiceConfirmation.record, checked by the
// service before anything is read); the command checks every rule again.
export default async function InvoicePoPage({ params }: { params: Promise<{ poId: string }> }) {
  const { poId } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('finance'), getLocale().then(localeOf)])
  const result = await getInvoicePoView(ctx, poId)
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND') notFound()
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('forbiddenTitle')}</h1>
        <Notice tone="warning">{t('forbiddenHint')}</Notice>
        <Link href="/" className={linkClass}>
          {t('home')}
        </Link>
      </div>
    )
  }
  const po = result.data
  const number = po.number ?? '-'
  const supplierName = nameIn(locale, po.supplier.name)
  const taxId = taxIdText(po.supplier.taxId)
  const rate = vatRateText(po.totals.vatRateBp)
  const budget = budgetOf(po)
  const open = po.blocked === null

  /** The invoices recorded on the PO: beside the form while it takes invoices, the main content once it does not */
  const invoicesSection = (side: boolean) => (
    <section aria-labelledby="po-invoices" className="flex flex-col gap-2">
      <h2 id="po-invoices" className="text-lg font-semibold text-ink">
        {t('po.invoicesTitle')}
      </h2>
      {po.invoices.length ? (
        <InvoiceList
          rows={po.invoices.map((inv) => ({
            id: inv.id,
            title: t('invoices.recorded.number', { number: inv.invoiceNo }),
            details: [t('invoices.recorded.dated', { date: day(locale, inv.invoiceDate) })],
            link: null,
            meta: [t('invoices.recorded.by', { name: memberName(locale, inv.recordedBy) || '-', time: when(locale, inv.recordedAt) })],
            states: invoiceStates(t, locale, inv),
            net: money(inv.netSatang),
            vat: money(inv.vatSatang),
            gross: money(inv.grossSatang),
            file: inv.file ? { fileId: inv.file.id, label: t('openFile', { name: inv.file.fileName }), busyLabel: t('openingFile', { name: inv.file.fileName }) } : null,
          }))}
          open={downloadUrlAction}
          layout={side ? 'side' : 'main'}
          labels={{
            list: t('po.invoicesTitle'),
            invoiceColumn: t('invoices.recorded.columns.invoice'),
            stateColumn: t('invoices.recorded.columns.state'),
            net: t('invoices.recorded.columns.net'),
            vat: t('invoices.recorded.columns.vat'),
            gross: t('invoices.recorded.columns.gross'),
            unit: t('unit'),
            fileFailed: t('fileFailed'),
          }}
        />
      ) : (
        <StateLine kind="waiting">{t('po.noInvoices')}</StateLine>
      )}
    </section>
  )

  return (
    <div className="flex flex-col gap-6">
      <Link href="/finance/invoices" className={linkClass}>
        {t('po.back')}
      </Link>

      <header className="flex max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-semibold break-words">{t('po.title', { number })}</h1>
        <PoStatus status={po.status} label={t(`poStatus.${po.status as 'SENT'}`)} />
        <div className="flex flex-col text-ink-muted">
          <span className="break-words text-ink">{t('supplierWithCode', { name: supplierName, code: po.supplier.code })}</span>
          <span className="break-words">
            {taxId
              ? po.supplier.branchCode === HEAD_OFFICE
                ? t('po.taxIdHead', { taxId })
                : t('po.taxIdBranch', { taxId, branch: po.supplier.branchCode })
              : t('po.noTaxId')}
          </span>
          {po.sentAt ? <span>{t('po.sentOn', { time: when(locale, po.sentAt) })}</span> : null}
        </div>
        <Link href={`/procurement/pos/${po.id}`} className={linkClass}>
          {t('po.openPo', { number })}
        </Link>
      </header>

      <Blocked po={po} t={t} locale={locale} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {/* Kept in the same place whatever the PO's state, so its confirmation stays after the page refreshes */}
          <InvoiceForm
            poId={po.id}
            open={open}
            supplier={{ name: supplierName, taxId, branch: po.supplier.branchCode }}
            vatRate={rate}
            etaxUrl={`/finance/invoices/${po.id}/etax`}
            listHref="/finance/invoices"
            actions={{ preview: previewInvoiceAction, record: recordInvoiceAction }}
          />
          {/* A PO that takes no more invoices: what was recorded is the page's main content */}
          {open ? null : invoicesSection(false)}
        </div>

        <aside className="flex min-w-0 flex-col gap-8">
          <section aria-labelledby="po-figures" className="flex flex-col gap-2">
            <h2 id="po-figures" className="text-lg font-semibold text-ink">
              {t('po.figuresTitle')}
            </h2>
            <dl className="flex flex-col divide-y divide-line border-y border-line">
              <Figure label={t('po.net')} value={money(po.totals.netSatang)} />
              <Figure label={rate ? t('po.vatRate', { rate }) : t('po.vat')} value={money(po.totals.vatSatang)} />
              <Figure label={t('po.gross')} value={money(po.totals.grossSatang)} strong />
              <Figure label={t('po.received')} value={money(po.receivedSatang)} />
              <Figure label={t('po.invoiced')} value={money(po.invoicedSatang)} />
              <Figure label={t('po.held')} value={money(po.heldSatang)} strong />
            </dl>
            <p className="text-base text-ink-muted md:text-sm">{t('po.figuresHint')}</p>
          </section>

          <section aria-labelledby="po-budget" className="flex flex-col gap-2">
            <h2 id="po-budget" className="text-lg font-semibold text-ink">
              {t('po.budgetTitle')}
            </h2>
            <p className="text-base text-ink-muted md:text-sm">{t('po.budgetHint')}</p>
            <ul aria-label={t('po.budgetTitle')} className="flex flex-col divide-y divide-line border-y border-line">
              {budget.map((b) => (
                <li key={b.id} className="flex flex-col gap-1 py-2">
                  <span className="break-words font-medium text-ink">{b.text}</span>
                  <dl className="flex flex-col">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">{t('po.committed')}</dt>
                      <dd className="money text-ink">{money(b.committed)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">{t('po.actual')}</dt>
                      <dd className="money text-ink">{money(b.actual)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="po-lines" className="flex flex-col gap-2">
            <h2 id="po-lines" className="text-lg font-semibold text-ink">
              {t('po.linesTitle')}
            </h2>
            <ul aria-label={t('po.linesTitle')} className="flex flex-col divide-y divide-line border-y border-line">
              {po.lines.map((l) => (
                <li key={l.id} className="flex flex-col gap-1 py-2">
                  <span className="break-words font-medium text-ink">{l.description}</span>
                  <span className="text-base text-ink-muted md:text-sm">{t('po.lineQuantities', { ordered: l.quantity, received: l.receivedQuantity, uom: l.uom })}</span>
                  <dl className="flex flex-col">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">{t('po.lineAmount')}</dt>
                      <dd className="money text-ink">{money(l.netSatang)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">{t('po.lineInvoiced')}</dt>
                      <dd className="money text-ink">{money(l.invoicedSatang)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-muted">{t('po.lineHeld')}</dt>
                      <dd className="money font-semibold text-ink">{money(l.committedSatang)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </section>

          {open ? invoicesSection(true) : null}
        </aside>
      </div>
    </div>
  )
}

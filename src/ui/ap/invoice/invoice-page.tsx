import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { satangToAmount } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDay, formatThaiDay } from '@/core/thai/day'
import { StatusBadge } from '../../document/badges'
import { FileButton } from '../../finance/file-button'
import { formatDateTime } from '../../format'
import { Notice } from '../../form/notice'
import { Page, PageBody, PageHeader, Panel } from '../../page/page'
import { CodingForm, NO_WITHHOLDING, type CodingLineView } from './coding-form'
import { DraftActions, ExceptionActions } from './exception-actions'
import { HeaderForm } from './header-form'
import { InvoiceLines, type LineView } from './invoice-lines'
import type { ApInvoiceActions } from './outcome'
import { SourceLabel } from './source-label'
import { INVOICE_BADGES, type ApInvoicePageData } from './types'

// The page of one tier-2 invoice (S8-13, docs/sub-specs/S8.md "หน้าจอ" /finance/invoices/[id]; FR-AP-101 AC5,
// FR-AP-102, FR-AP-103 AC1 AC2, FR-AP-105 AC2, FR-AP-108 AC1 AC2). Left, the work: the header (editable while a draft,
// each value labelled with where it came from), the lines with the match result, the coding of each line with its
// suggestion and source, and the differences still open — each a notice that says what, which line, how much and whom it
// is sent to — with the ways to settle them that the member's role allows. Right, what the invoice comes to: its
// amounts down to the expected transfer, submit or discard a draft, its source file (downloaded through the files
// service, never a storage address), and its history. Every action goes through a server action; the services check
// everything again.

type T = Awaited<ReturnType<typeof getTranslations<'apInvoice'>>>
type Locale = 'th' | 'en'

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

const money = (satang: bigint) => formatSatang(satang)
const dayText = (locale: Locale, day: string) => (locale === 'en' ? formatEnglishBeDay(day) : formatThaiDay(day)) ?? day
const nameOf = (locale: Locale, name: { readonly th: string; readonly en: string | null }) => (locale === 'en' && name.en ? name.en : name.th)

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`money text-ink ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  )
}

function lineViews(data: ApInvoicePageData): LineView[] {
  const matched = data.lines.some((l) => l.matchStatus !== 'PENDING')
  return data.lines.map((l) => ({
    id: l.id,
    lineNo: l.lineNo,
    poLineId: l.poLineId,
    poLineNo: l.poLineNo,
    description: l.description,
    quantity: l.quantity,
    uom: l.uom,
    unitPrice: data.may.edit ? satangToAmount(l.unitPriceSatang) : money(l.unitPriceSatang),
    poUnitPrice: money(l.poUnitPriceSatang),
    amount: money(l.netSatang),
    expected: matched && l.matchStatus !== 'PENDING' ? money(l.expectedNetSatang) : null,
    over: matched && l.matchStatus !== 'PENDING' ? money(l.overSatang) : null,
    matchStatus: l.matchStatus,
    priceUnder: l.flags.includes('PRICE_UNDER'),
  }))
}

function sourceText(t: T, s: { readonly source: string; readonly count: number }): string {
  if (s.source === 'HISTORY') return t('coding.from.HISTORY', { count: s.count })
  return s.source === 'BUDGET_LINE' ? t('coding.from.BUDGET_LINE') : t('coding.from.NONE')
}

function codingViews(t: T, data: ApInvoicePageData): CodingLineView[] {
  return data.lines.map((l) => ({
    id: l.id,
    lineNo: l.lineNo,
    description: l.description,
    accountCode: l.accountCode,
    costCenterId: l.costCenterId,
    costCenterReason: l.costCenterReason ?? '',
    whtIncomeTypeCode: l.whtIncomeTypeCode,
    budgetCostCenterId: l.budgetCostCenterId,
    confirmed: l.codingConfirmed,
    suggestion: l.suggestion ? { accountCode: l.suggestion.accountCode, sourceText: sourceText(t, l.suggestion) } : null,
  }))
}

/** The coding of an invoice that is no longer a draft (or read by someone who does not code it) */
function CodingRead({ t, data }: { t: T; data: ApInvoicePageData }) {
  return (
    <ul aria-label={t('coding.title')} className="flex flex-col divide-y divide-line border-y border-line">
      {data.lines.map((l) => (
        <li key={l.id} className="flex flex-col gap-1 py-2">
          <span className="font-medium break-words text-ink">{t('coding.line', { no: l.lineNo, description: l.description })}</span>
          {l.codingConfirmed && l.accountCode ? (
            <span className="text-ink">
              {t('coding.readCode', { code: l.accountCode })} · {t(`coding.from.${l.codingSource as 'MANUAL'}`, { count: 0 })}
            </span>
          ) : (
            <span className="text-ink-muted">{t('coding.notCoded')}</span>
          )}
          {l.whtIncomeTypeCode ? <span className="text-ink-muted">{t('coding.readType', { type: l.whtIncomeTypeCode })}</span> : null}
          {l.costCenterReason ? <span className="text-ink-muted">{l.costCenterReason}</span> : null}
        </li>
      ))}
    </ul>
  )
}

/** The header of an invoice that is no longer a draft */
function HeaderRead({ t, locale, data }: { t: T; locale: Locale; data: ApInvoicePageData }) {
  const labels = { AI_READING: t('source.AI_READING'), ETAX_XML: t('source.ETAX_XML') }
  const row = (field: string, label: string, value: string) => (
    <div className="flex flex-col gap-1 py-1.5 md:flex-row md:items-baseline md:justify-between md:gap-4">
      <dt className="flex flex-wrap items-center gap-2 text-ink-muted">
        {label}
        <SourceLabel source={data.fieldSources[field]} labels={labels} />
      </dt>
      <dd className="break-words text-ink">{value}</dd>
    </div>
  )
  return (
    <dl className="flex flex-col divide-y divide-line border-y border-line">
      {row('supplierInvoiceNo', t('header.supplierInvoiceNo'), data.supplierInvoiceNo ?? t('header.notSet'))}
      {row('invoiceDate', t('header.invoiceDate'), data.invoiceDate ? dayText(locale, data.invoiceDate) : t('header.notSet'))}
      {row('priceIncludesVat', t('header.priceIncludesVat'), data.priceIncludesVat ? t('header.yes') : t('header.no'))}
      {row('discount', t('header.discount'), money(data.discountSatang))}
      {row('statedVat', t('header.statedVat'), money(data.statedVatSatang))}
      {row('isFinal', t('header.isFinal'), data.isFinal ? t('header.yes') : t('header.no'))}
    </dl>
  )
}

export async function ApInvoicePage({ data, actions, openFile }: { data: ApInvoicePageData; actions: ApInvoiceActions; openFile: (fileId: string) => Promise<string | null> }) {
  const [t, ta, rawLocale] = await Promise.all([getTranslations('apInvoice'), getTranslations('audit'), getLocale()])
  const locale: Locale = rawLocale === 'en' ? 'en' : 'th'
  const title = data.number ? t('title', { number: data.number }) : t('titleDraft')
  const supplierName = locale === 'en' && data.supplier.nameEn ? data.supplier.nameEn : data.supplier.nameTh
  const open = data.exceptions.filter((e) => e.status === 'OPEN')
  const asked = data.exceptions.some((e) => e.status === 'ACCEPT_REQUESTED')
  const statusLabel = t.has(`status.${data.status}` as 'status.DRAFT') ? t(`status.${data.status}` as 'status.DRAFT') : data.status
  const typeText = (type: string) => (t.has(`exceptions.type.${type}` as 'exceptions.type.PRICE_OVER') ? t(`exceptions.type.${type}` as 'exceptions.type.PRICE_OVER') : type)
  const eventText = (type: string) => {
    const key = `events.${type}` as 'events.invoice.drafted'
    return ta.has(key) ? ta(key) : type
  }
  const transfer = data.payableSatang - data.expectedWhtSatang
  const incomeTypes = [
    { value: NO_WITHHOLDING, label: t('coding.noWithholding') },
    ...data.options.incomeTypes.map((x) => {
      const label = t('coding.typeOption', { name: locale === 'en' && x.nameEn ? x.nameEn : x.nameTh, rate: (x.rateBp / 100).toString() })
      return { value: x.code, label: x.confirmed ? label : `${label} · ${t('coding.rateNotConfirmed')}` }
    }),
  ]

  return (
    <Page>
      <Link href="/finance/invoices" className={linkClass}>
        {t('back')}
      </Link>

      <PageHeader title={title}>
        <StatusBadge look={INVOICE_BADGES[data.status]} label={statusLabel} className="self-start text-base md:text-sm" />
        <div className="flex flex-col text-ink-muted">
          <span>
            {t('header.number')}: <span className="text-ink">{data.number ?? t('header.noNumber')}</span>
          </span>
          <Link href={`/suppliers/${data.supplier.id}`} className={linkClass}>
            {t('header.supplierName', { name: supplierName, code: data.supplier.code })}
          </Link>
          <Link href={`/procurement/pos/${data.po.id}`} className={linkClass}>
            {data.po.number ? t('header.poLink', { number: data.po.number }) : t('header.poNoNumber')}
          </Link>
        </div>
      </PageHeader>

      <PageBody>
        {data.status === 'REJECTED' && data.rejectReason ? <Notice tone="danger" role="status">{t('header.rejected', { reason: data.rejectReason })}</Notice> : null}
        {data.status === 'CANCELLED' && data.cancelReason ? <Notice tone="info">{t('header.cancelled', { reason: data.cancelReason })}</Notice> : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
          <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
            {data.exceptions.length > 0 ? (
              <Panel title={t('exceptions.title')} id="invoice-exceptions">
                <p className="text-ink-muted">{t('exceptions.hint')}</p>
                <ul aria-label={t('exceptions.title')} className="flex flex-col gap-2">
                  {data.exceptions.map((e) => (
                    <li key={e.id}>
                      <Notice tone={e.status === 'OPEN' ? 'warning' : 'info'}>
                        <span className="block font-medium">{typeText(e.type)}</span>
                        <span className="block">
                          {e.lineNo ? t('exceptions.line', { no: e.lineNo }) : t('exceptions.whole')} · {t('exceptions.amount', { amount: money(e.amountSatang) })} · {t('exceptions.sentTo', { role: t(`exceptions.role.${e.assigneeRole as 'FINANCE'}`) })}
                        </span>
                        {e.status === 'ACCEPT_REQUESTED' ? <span className="block text-ink-muted">{t('exceptions.asked')}</span> : null}
                      </Notice>
                    </li>
                  ))}
                </ul>
                {data.status === 'EXCEPTION' ? (
                  <ExceptionActions
                    invoiceId={data.id}
                    version={data.version}
                    may={data.may}
                    duplicates={open.filter((e) => e.type === 'POSSIBLE_DUPLICATE').map((e) => e.id)}
                    actions={actions}
                  />
                ) : null}
                {asked && data.status === 'PENDING_APPROVAL' ? <Notice tone="info">{t('exceptions.asked')}</Notice> : null}
              </Panel>
            ) : null}

            <Panel title={t('header.title')} id="invoice-header">
              {data.may.edit ? (
                <HeaderForm
                  invoiceId={data.id}
                  version={data.version}
                  sources={data.fieldSources}
                  values={{
                    supplierInvoiceNo: data.supplierInvoiceNo ?? '',
                    invoiceDate: data.invoiceDate ?? '',
                    priceIncludesVat: data.priceIncludesVat,
                    discount: satangToAmount(data.discountSatang),
                    statedVat: satangToAmount(data.statedVatSatang),
                    isFinal: data.isFinal,
                  }}
                  update={actions.update}
                />
              ) : (
                <HeaderRead t={t} locale={locale} data={data} />
              )}
            </Panel>

            <Panel title={t('lines.title')} id="invoice-lines">
              <InvoiceLines invoiceId={data.id} version={data.version} lines={lineViews(data)} editable={data.may.edit} {...(data.may.edit ? { update: actions.update } : {})} />
            </Panel>

            <Panel title={t('coding.title')} id="invoice-coding">
              {data.may.edit && data.lines.length > 0 ? (
                <CodingForm
                  invoiceId={data.id}
                  version={data.version}
                  lines={codingViews(t, data)}
                  choices={{
                    accountCodes: data.options.accountCodes.map((c) => ({ value: c.code, label: `${c.code} ${c.nameTh}` })),
                    costCenters: data.options.costCenters.map((c) => ({ value: c.id, label: `${c.code} ${c.nameTh}` })),
                    incomeTypes,
                  }}
                  confirm={actions.confirmCoding}
                />
              ) : (
                <CodingRead t={t} data={data} />
              )}
            </Panel>
          </div>

          <aside className="flex min-w-0 flex-col gap-4 lg:gap-6">
            <Panel title={t('amounts.title')} id="invoice-amounts">
              <dl className="flex flex-col divide-y divide-line border-y border-line">
                <Figure label={t('amounts.net')} value={money(data.netSatang)} />
                {data.discountSatang > 0n ? <Figure label={t('amounts.discount')} value={money(data.discountSatang)} /> : null}
                <Figure label={t('amounts.statedVat')} value={money(data.statedVatSatang)} />
                <Figure label={t('amounts.gross')} value={money(data.grossSatang)} strong />
                <Figure label={t('amounts.retention')} value={money(data.retentionSatang)} />
                <Figure label={t('amounts.payable')} value={money(data.payableSatang)} strong />
                <Figure label={t('amounts.wht')} value={money(data.expectedWhtSatang)} />
                <Figure label={t('amounts.transfer')} value={money(transfer)} strong />
              </dl>
              <p className="text-base text-ink-muted md:text-sm">{t('amounts.transferHint')}</p>
              {data.dueDate ? <p className="font-medium text-ink">{t('amounts.due', { date: dayText(locale, data.dueDate) })}</p> : null}
            </Panel>

            {data.may.submit || data.may.cancel ? (
              <Panel title={t('draft.title')} id="invoice-submit">
                <DraftActions invoiceId={data.id} version={data.version} may={data.may} actions={actions} />
              </Panel>
            ) : null}

            <Panel title={t('file.title')} id="invoice-file">
              {data.file ? (
                <FileButton fileId={data.file.id} label={t('file.open', { name: data.file.fileName })} busyLabel={t('file.opening', { name: data.file.fileName })} failedText={t('file.failed')} open={openFile} />
              ) : (
                <p className="text-ink-muted">{t('file.none')}</p>
              )}
            </Panel>

            <Panel title={t('history.title')} id="invoice-history">
              {data.events.length ? (
                <ol aria-label={t('history.title')} className="flex flex-col divide-y divide-line border-y border-line">
                  {data.events.map((e) => (
                    <li key={e.id} className="flex flex-col gap-0.5 py-2">
                      <span className="font-medium text-ink">{eventText(e.type)}</span>
                      <span className="text-base text-ink-muted md:text-sm">
                        {e.actor ? nameOf(locale, e.actor) : t('history.system')} · {formatDateTime(locale, e.occurredAt)}
                      </span>
                      {e.reason ? <span className="text-base break-words text-ink md:text-sm">{t('history.reason', { reason: e.reason })}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-ink-muted">{t('history.empty')}</p>
              )}
            </Panel>
          </aside>
        </div>
      </PageBody>
    </Page>
  )
}

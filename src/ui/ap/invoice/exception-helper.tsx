import { CircleCheck, CircleDashed } from 'lucide-react'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { HELP_MESSAGE_MAX } from '@/lib/exception-help'
import { ExceptionDraft, type ExceptionDraftView } from './exception-draft'
import { dayText, invoiceLinkClass, type InvoiceLocale } from './invoice-parts'
import type { ApOutcome } from './outcome'
import type { ExceptionHelpData as ExceptionHelpDto, InvoiceHelpData as InvoiceHelpDto } from './types'

// The helper of an invoice's open differences (NEW-126 · ADR-081 · ผู้ช่วยตรวจเอกสาร), under each difference the reader
// may see: the steps the assistant took, each with a tick and what it found by code (the PO line, what this invoice
// bills, the goods received, the agreed price, past prices), the step waiting for the reader, the ways the reader really
// has — each one link to where it is done, the page's own buttons included — and the drafted messages to send after
// reading. The rules found everything here; no AI wrote it, so it has no Sparkles (§12.5) and stays when the AI is off.

type T = Awaited<ReturnType<typeof getTranslations<'exceptionHelp'>>>
type ApT = Awaited<ReturnType<typeof getTranslations<'apInvoice'>>>

const money = (satang: bigint) => formatSatang(satang)

interface Step {
  readonly key: string
  readonly text: string
  readonly done: boolean
}

function stepsOf(t: T, ta: ApT, locale: InvoiceLocale, help: InvoiceHelpDto, h: ExceptionHelpDto, where: string): Step[] {
  const steps: Step[] = []
  const l = h.line
  if (l) {
    steps.push({ key: 'poLine', text: t('step.poLine', { poLine: l.poLineNo, ordered: l.ordered, uom: l.uom, price: money(l.poUnitPriceSatang) }), done: true })
    steps.push({ key: 'invoiceLine', text: t('step.invoiceLine', { line: l.lineNo, invoiced: l.invoiced, uom: l.uom, price: money(l.unitPriceSatang) }), done: true })
    if (l.invoicedElsewhere !== '0') steps.push({ key: 'elsewhere', text: t('step.elsewhere', { quantity: l.invoicedElsewhere, uom: l.uom }), done: true })
  } else {
    steps.push({ key: 'amount', text: t('step.amount', { where }), done: true })
  }
  if (h.receipts && l) {
    steps.push({
      key: 'receipts',
      text: h.receipts.count && h.receipts.lastOn ? t('step.receipts', { received: l.received, uom: l.uom, count: h.receipts.count, date: dayText(locale, h.receipts.lastOn) }) : t('step.receiptsNone'),
      done: true,
    })
  }
  if (h.agreement) {
    const a = h.agreement
    steps.push({ key: 'agreement', text: a.kind === 'FOUND' ? t('step.agreement', { price: money(a.unitPriceSatang), date: dayText(locale, a.validTo) }) : a.kind === 'NO_ITEM' ? t('step.agreementNoItem') : t('step.agreementNone'), done: true })
  }
  if (h.pastPrices) {
    const last = h.pastPrices.recent[0]
    steps.push({
      key: 'pastPrices',
      text: last
        ? t(last.priceIncludesVat ? 'step.pastPricesWithVat' : 'step.pastPrices', { count: h.pastPrices.count, days: h.pastPrices.windowDays, price: money(last.unitPriceSatang), po: last.poNumber ?? '-', date: dayText(locale, last.approvedOn) })
        : t('step.pastPricesNone', { days: h.pastPrices.windowDays }),
      done: true,
    })
  }
  if (h.type === 'VAT_MISMATCH' || h.type === 'VAT_SUPPLIER_NOT_REGISTERED') steps.push({ key: 'vat', text: t('step.vatStated', { stated: money(help.statedVatSatang) }), done: true })
  steps.push({
    key: 'fixes',
    text: h.fixes.length ? t('step.fixes', { count: h.fixes.length }) : t('step.fixesNone', { role: ta(`exceptions.role.${h.assigneeRole}`) }),
    done: true,
  })
  if (h.recipients.length || h.email?.hasEmail) steps.push({ key: 'drafts', text: t('step.drafts'), done: true })
  if (h.fixes.length) steps.push({ key: 'choose', text: t('step.choose'), done: false })
  return steps
}

/** The values every draft of this difference fills in, as text (numbers by code, BR-AI-03) */
function draftValues(t: T, help: InvoiceHelpDto, h: ExceptionHelpDto) {
  const l = h.line
  return {
    invoice: help.number ?? '-',
    supplierInvoiceNo: help.supplierInvoiceNo ?? '-',
    po: help.po.number ?? '-',
    line: l?.lineNo ?? 0,
    description: l?.description ?? '',
    uom: l?.uom ?? '',
    invoiced: l?.invoiced ?? '',
    ordered: l?.ordered ?? '',
    received: l?.received ?? '',
    // What other invoices billed of the line, said only when they billed some
    elsewhere: l && l.invoicedElsewhere !== '0' ? t('draftElsewhere', { quantity: l.invoicedElsewhere, uom: l.uom }) : '',
    price: l ? money(l.unitPriceSatang) : '',
    poPrice: l ? money(l.poUnitPriceSatang) : '',
    stated: money(help.statedVatSatang),
  }
}

function draftsOf(t: T, locale: InvoiceLocale, help: InvoiceHelpDto, h: ExceptionHelpDto): ExceptionDraftView[] {
  const values = draftValues(t, help, h)
  const anchor = `exception-help-${h.exceptionId}`
  const drafts: ExceptionDraftView[] = []
  const askKey = `draft.ask.${h.type}` as 'draft.ask.PRICE_OVER'
  if (h.recipients.length && t.has(askKey)) {
    drafts.push({
      exceptionId: h.exceptionId,
      to: 'MEMBER',
      anchor: `${anchor}-ask`,
      title: t('ask.title'),
      hint: t('ask.hint'),
      toLabel: t('ask.to'),
      recipients: h.recipients.map((r) => {
        const name = locale === 'en' && r.en ? r.en : r.th
        return {
          id: r.id,
          label: t('ask.recipient', { name, relation: t(`ask.relation.${r.relation}`) }),
          draft: t(askKey, { ...values, name }),
          confirmTitle: t('ask.confirmTitle', { name }),
          sent: t('ask.sent', { name }),
        }
      }),
      review: t('ask.review'),
      confirmHint: t('ask.confirmHint'),
      send: t('ask.send'),
      sending: t('ask.sending'),
      max: HELP_MESSAGE_MAX,
    })
  }
  const emailKey = `draft.email.${h.type}` as 'draft.email.PRICE_OVER'
  if (h.email?.hasEmail && t.has(emailKey)) {
    const name = locale === 'en' && help.supplier.nameEn ? help.supplier.nameEn : help.supplier.nameTh
    drafts.push({
      exceptionId: h.exceptionId,
      to: 'SUPPLIER',
      anchor: `${anchor}-email`,
      title: t('email.title'),
      hint: t('email.hint'),
      toLabel: t('email.to', { name }),
      recipients: [{ id: 'SUPPLIER', label: name, draft: t(emailKey, values), confirmTitle: t('email.confirmTitle', { name }), sent: t('email.sent') }],
      review: t('email.review'),
      confirmHint: t('email.confirmHint'),
      send: t('email.send'),
      sending: t('email.sending'),
      max: HELP_MESSAGE_MAX,
    })
  }
  return drafts
}

export async function ExceptionHelper({ help, send }: { help: InvoiceHelpDto; send: (input: unknown, idempotencyKey: string) => Promise<ApOutcome> }) {
  const [t, ta, rawLocale] = await Promise.all([getTranslations('exceptionHelp'), getTranslations('apInvoice'), getLocale()])
  const locale: InvoiceLocale = rawLocale === 'en' ? 'en' : 'th'
  if (help.helps.length === 0) return null
  const typeText = (type: string) => (ta.has(`exceptions.type.${type}` as 'exceptions.type.PRICE_OVER') ? ta(`exceptions.type.${type}` as 'exceptions.type.PRICE_OVER') : type)
  const whereOf = (h: ExceptionHelpDto) => `${h.line ? ta('exceptions.line', { no: h.line.lineNo }) : ta('exceptions.whole')} · ${ta('exceptions.amount', { amount: money(h.amountSatang) })}`

  return (
    <section aria-labelledby="exception-helper-title" id="exception-helper" className="flex flex-col gap-4 border-t border-line pt-4">
      <div className="flex flex-col gap-1">
        <h3 id="exception-helper-title" className="font-semibold text-ink">
          {t('title')}
        </h3>
        <p className="text-base text-ink-muted md:text-sm">{t('hint')}</p>
      </div>
      {help.helps.map((h) => {
        const where = whereOf(h)
        const steps = stepsOf(t, ta, locale, help, h, where)
        const drafts = draftsOf(t, locale, help, h)
        const itemId = `exception-help-${h.exceptionId}`
        return (
          <article key={h.exceptionId} id={itemId} aria-labelledby={`${itemId}-title`} data-exception-help={h.type} className="flex flex-col gap-3 rounded-md border border-line p-3">
            <h4 id={`${itemId}-title`} className="font-medium break-words text-ink">
              {t('itemTitle', { type: typeText(h.type), where })}
            </h4>
            <div className="flex flex-col gap-1">
              <p id={`${itemId}-steps`} className="text-base text-ink-muted md:text-sm">
                {t('stepsTitle')}
              </p>
              <ol aria-labelledby={`${itemId}-steps`} className="flex flex-col gap-1.5">
                {steps.map((s) => (
                  <li key={s.key} className="flex items-start gap-2" data-step={s.key}>
                    {s.done ? <CircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleDashed className="mt-1 size-4 shrink-0 text-warn" aria-hidden="true" />}
                    <span className="break-words text-ink">
                      <span className="sr-only">{s.done ? t('stepDone') : t('stepWaiting')}: </span>
                      {s.text}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            {h.fixes.length ? (
              <div className="flex flex-col gap-1">
                <p id={`${itemId}-fixes`} className="text-base text-ink-muted md:text-sm">
                  {t('fixesTitle')}
                </p>
                <ul aria-labelledby={`${itemId}-fixes`} className="flex flex-col">
                  {h.fixes.map((f) => {
                    // Rejecting a possible duplicate says it is one, not that a new invoice is coming
                    const label = f.key === 'REJECT' && h.type === 'POSSIBLE_DUPLICATE' ? t('fix.REJECT_DUPLICATE') : t(`fix.${f.key}`)
                    return (
                      <li key={f.key} data-fix={f.key}>
                        {f.href.startsWith('#') ? (
                          <a href={f.href} className={invoiceLinkClass}>
                            {label}
                          </a>
                        ) : (
                          <Link href={f.href} className={invoiceLinkClass}>
                            {label}
                          </Link>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}
            {h.email && !h.email.hasEmail ? <p className="text-base text-ink-muted md:text-sm">{t('email.noEmail')}</p> : null}
            {drafts.map((d) => (
              <ExceptionDraft key={d.anchor} view={d} send={send} />
            ))}
          </article>
        )
      })}
    </section>
  )
}

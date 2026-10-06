import { getTranslations } from 'next-intl/server'
import type { VarianceViewDto } from '@/server/queries/purchase-orders'
import { LightLink } from '@/ui/light-link'
import { AttachmentList } from '@/ui/request-view/attachments'
import { Amounts, Facts, Section, type AmountRow, type Fact } from '@/ui/request-view/facts'
import { StateLine } from '@/ui/request-view/status'
import { memberName, money, when, type Locale } from '../../_tracking/present'
import { attachmentViews, RouteSection, type OpenFile } from '../../procurement/pos/_parts/po-body'

// What the approver of a receiving variance decides on (spec BR-GR-03, BR-GR-04, BR-GR-05, FR-P2P-007 AC2, §9.9
// principle 5): the PO and its line, what was ordered, received and closed short, the difference and what approving
// it does, its amount before VAT at the PO's unit price, its VAT at the PO's rate and the two together, the budget line
// and what the PO holds there with what approving changes, the reason it was recorded with, the goods receipt it came
// from with its photos (a damaged-goods variance has at least one), and the route with its DOA rule. Flat sections; no
// cards. Amounts are right-aligned in tabular digits; the budget shows the PO's own amounts, never the line's balance.
// The LIFF decision page of a variance task renders this body too (src/app/liff/tasks/[id]/page.tsx, without a PO link):
// its one link is a light link (src/ui/light-link.tsx), as next/link's client code would weigh on a LIFF page (§9.4).

const HINTED = ['CLOSE_SHORT', 'ACCEPT_EXCESS', 'ACCEPT_DAMAGED'] as const

export async function VarianceBody({ variance, locale, doaLinks, poHref, openFile }: { variance: VarianceViewDto; locale: Locale; doaLinks: boolean; poHref: string | null; openFile: OpenFile }) {
  const [t, tp] = await Promise.all([getTranslations('tasks'), getTranslations('purchaseOrder')])
  const qty = (quantity: string) => t('variance.qty', { quantity, uom: variance.line.uom })
  const hinted = (HINTED as readonly string[]).includes(variance.disposition) ? (variance.disposition as (typeof HINTED)[number]) : 'other'
  const poLabel = `${variance.po.number ?? '-'} · ${variance.po.supplier.nameTh}`
  const photos = await attachmentViews(locale, variance.photos)
  const items: Fact[] = [
    { label: t('variance.type'), value: t(`varianceType.${variance.type}`) },
    {
      label: t('variance.disposition'),
      value: (
        <span className="flex flex-col">
          <span>{t(`varianceDisposition.${variance.disposition}`)}</span>
          <span className="text-base text-ink-muted md:text-sm">{t(`decide.variance.approveHint.${hinted}`)}</span>
        </span>
      ),
    },
    { label: t('variance.quantity'), value: <span className="tabular">{qty(variance.quantity)}</span> },
    {
      label: t('variance.po'),
      value: poHref ? (
        <LightLink href={poHref} className="font-medium text-primary underline underline-offset-4 hover:no-underline">
          {poLabel}
        </LightLink>
      ) : (
        poLabel
      ),
    },
    { label: t('variance.line'), value: t('variance.lineValue', { no: variance.line.lineNo, description: variance.line.description }) },
    { label: t('variance.ordered'), value: <span className="tabular">{qty(variance.line.ordered)}</span> },
    { label: t('variance.received'), value: <span className="tabular">{qty(variance.line.received)}</span> },
    ...(variance.line.cancelled !== '0' ? [{ label: t('variance.cancelled'), value: <span className="tabular">{qty(variance.line.cancelled)}</span> }] : []),
    { label: t('variance.reason'), value: variance.reason ? <span className="whitespace-pre-line">{variance.reason}</span> : t('variance.noReason') },
    { label: t('variance.recordedBy'), value: memberName(locale, variance.createdBy) || '-' },
    { label: t('variance.recordedAt'), value: when(locale, variance.createdAt) },
    {
      label: t('variance.gr'),
      value: variance.gr
        ? variance.gr.number
          ? t('variance.grValue', { number: variance.gr.number, time: when(locale, variance.gr.receivedAt) })
          : t('variance.grNoNumber', { time: when(locale, variance.gr.receivedAt) })
        : t('variance.noGr'),
    },
    ...(variance.gr?.deliveryNoteNo ? [{ label: t('variance.deliveryNote'), value: variance.gr.deliveryNoteNo }] : []),
    ...(variance.gr?.receiver ? [{ label: t('variance.receiver'), value: memberName(locale, variance.gr.receiver) }] : []),
  ]
  const budget = variance.budget
  const budgetRows: AmountRow[] = budget
    ? [{ label: t('variance.budgetHeld'), value: money(budget.heldSatang) }, ...(budget.actualSatang > 0n ? [{ label: t('variance.budgetActual'), value: money(budget.actualSatang) }] : [])]
    : []
  return (
    // The amounts and the budget side by side only where the document's column is 40rem wide or more: never in the one
    // column of a LIFF page (§9.9), whatever the screen (as RequestSections)
    <div className="@container flex flex-col gap-6">
      <div className="grid gap-6 @min-[40rem]:grid-cols-2">
        <Section id="variance-amounts" title={t('variance.amountsTitle')}>
          <Amounts
            heading={tp('amounts.unit')}
            unit={tp('amounts.unit')}
            rows={[
              { label: t('variance.unitPrice'), value: money(variance.line.unitPriceSatang) },
              { label: t('variance.net'), value: money(variance.amountSatang) },
              { label: variance.vatRateBp !== null ? t('variance.vat', { rate: variance.vatRateBp / 100 }) : t('variance.vatPlain'), value: money(variance.vatSatang) },
              { label: t('variance.gross'), value: money(variance.grossSatang), total: true },
            ]}
          />
          {/* Which of the amounts the route was made with: the basis of the DOA version (GROSS or NET) */}
          {variance.route ? <p className="text-base text-ink-muted md:text-sm">{t(`variance.amountBasis.${variance.route.amountBasis}`)}</p> : null}
        </Section>

        <Section id="variance-budget" title={t('variance.budgetTitle')}>
          {budget ? (
            <div className="flex flex-col gap-3">
              <Facts
                columns="one"
                items={[
                  { label: t('variance.budgetLine'), value: `${budget.code} · ${budget.name}` },
                  {
                    label: t('variance.budgetEffectLabel'),
                    value: (
                      <span className="flex flex-col">
                        <StateLine kind={hinted === 'other' ? 'closed' : 'done'}>{t(`variance.budgetEffect.${hinted}`, { amount: money(variance.amountSatang) })}</StateLine>
                        {budget.status !== 'OPEN' ? <StateLine kind="closed">{tp(`budget.lineStatus.${budget.status}`)}</StateLine> : null}
                      </span>
                    ),
                  },
                ]}
              />
              <Amounts heading={tp('amounts.unit')} unit={tp('amounts.unit')} rows={budgetRows} />
              <p className="text-base text-ink-muted md:text-sm">{t('variance.budgetNote')}</p>
            </div>
          ) : (
            <p className="text-ink-muted">{t('variance.budgetNone')}</p>
          )}
        </Section>
      </div>

      <Section id="variance-facts" title={t('variance.title')}>
        {/* In columns by the list's own width: one in the LIFF column at every screen width, two in the workspace's */}
        <Facts items={items} columns={2} />
      </Section>

      <Section id="variance-photos" title={t('variance.photosTitle')}>
        {photos.length ? (
          <AttachmentList open={openFile} files={photos} />
        ) : (
          <p className="text-ink-muted">{variance.gr ? t('variance.photosNone') : t('variance.photosNoGr')}</p>
        )}
      </Section>

      <RouteSection id="variance-route" route={variance.route} locale={locale} doaLinks={doaLinks} subject="VARIANCE" empty={tp('detail.routeNotYet')} />
    </div>
  )
}
